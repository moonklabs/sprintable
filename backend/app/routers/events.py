"""이벤트 시스템 라우터.

C-S6: SSE 스트림 (메모 변경 이벤트 실시간 푸시)
E-EVENTBUS S1: events 테이블 CRUD (이벤트버스 기반)
E-EVENTBUS S2: MCP Streamable HTTP SSE 푸시 (에이전트 전용)
E-EVENTBUS S3: 이벤트 큐 + 오프라인 재전달 (at-least-once + 배치 + expired)
"""
from __future__ import annotations

import asyncio
import json
import uuid
from collections import defaultdict
from datetime import datetime, timedelta, timezone
from typing import Any

from fastapi import APIRouter, BackgroundTasks, Depends, HTTPException, Query, Request
from fastapi.responses import StreamingResponse
from pydantic import BaseModel, ConfigDict
from sqlalchemy import and_, delete, or_, select, update
from sqlalchemy.ext.asyncio import AsyncSession

from app.dependencies.auth import (
    AuthContext,
    get_current_user,
    get_current_user_streaming,
    get_verified_org_id,
    get_verified_org_id_streaming,
)
from app.dependencies.database import get_db
from app.models.event import Event
from app.models.team import TeamMember

router = APIRouter(prefix="/api/v2/events", tags=["events"])

# ─── In-process event bus (C-S6: memo SSE) ────────────────────────────────────
# org_id → set of queues (one per connected SSE client)
_subscribers: dict[str, set[asyncio.Queue[dict]]] = defaultdict(set)


def publish_event(org_id: str, event_type: str, data: dict, _from_listener: bool = False) -> None:
    """다른 라우터에서 이벤트를 발행할 때 호출.

    _from_listener=True: LISTEN 수신기에서 호출 시 pg_notify 재발행 금지 (무한 루프 차단).
    """
    payload = {"type": event_type, **data}
    dead: list[asyncio.Queue] = []
    for q in _subscribers.get(org_id, set()):
        try:
            q.put_nowait(dict(payload))  # copy per subscriber — shared dict mutation 방지
        except asyncio.QueueFull:
            dead.append(q)
    for q in dead:
        _subscribers[org_id].discard(q)
    if not _from_listener:
        try:
            from app.services.pg_pubsub import pg_notify
            asyncio.get_running_loop().create_task(
                pg_notify("org", org_id, event_type, data)
            )
        except RuntimeError:
            pass  # 이벤트 루프 없음 (테스트 등)


# ─── Agent connection registry (S2/S3: 에이전트별 SSE) ───────────────────────
# member_id (str) → set[Queue] — 다중 연결 지원, 해제 시 해당 queue만 제거
_agent_connections: dict[str, set[asyncio.Queue[dict]]] = defaultdict(set)

_SSE_BATCH_SIZE = 10  # 배치 전달 청크 크기

# ─── S20: SSE 연결 수 전역 제한 ───────────────────────────────────────────────
import os as _os
_MAX_SSE_CONNECTIONS: int = int(_os.getenv("MAX_SSE_CONNECTIONS", "100"))
_sse_connection_count: int = 0
_SSE_HEARTBEAT_TIMEOUT: float = float(_os.getenv("SSE_HEARTBEAT_TIMEOUT", "30"))

# ─── S6-1: Backfill 볼륨 제어 ─────────────────────────────────────────────────
_BACKFILL_THRESHOLD_SECONDS: int = int(_os.getenv("BACKFILL_THRESHOLD_SECONDS", "300"))
_BACKFILL_MAX_EVENTS: int = int(_os.getenv("BACKFILL_MAX_EVENTS", "50"))
# S0-1: 초기 연결(last_event_id=None) 시 backfill 상한 — 재연결과 구분하여 중복 방지
_BACKFILL_INITIAL_EVENTS: int = int(_os.getenv("BACKFILL_INITIAL_EVENTS", "5"))


def _compute_backfill_mode(
    ref_ts: "datetime | None",
    now: "datetime",
    initial: bool = False,
) -> tuple[bool, int]:
    """(exceed_threshold, limit) — threshold 초과 여부와 사용할 LIMIT 반환.

    exceed_threshold=True  → DESC 최신 N건 조회
    exceed_threshold=False → ASC 전량 조회 (max 100)
    initial=True: last_event_id=None 초기 연결 — BACKFILL_INITIAL_EVENTS 상한 적용
    """
    if ref_ts is None:
        limit = _BACKFILL_INITIAL_EVENTS if initial else _BACKFILL_MAX_EVENTS
        return True, limit
    _ref = ref_ts if ref_ts.tzinfo else ref_ts.replace(tzinfo=timezone.utc)
    exceed = (now - _ref) > timedelta(seconds=_BACKFILL_THRESHOLD_SECONDS)
    return exceed, (_BACKFILL_MAX_EVENTS if exceed else 100)


def _push_to_agent(member_id: str, payload: dict, _from_listener: bool = False) -> bool:
    """연결 중인 에이전트 모든 큐에 SSE 페이로드 전송. True=1개 이상 전달, False=미연결.

    _from_listener=True: LISTEN 수신기에서 호출 시 pg_notify 재발행 금지 (무한 루프 차단).
    """
    queues = _agent_connections.get(member_id)
    pushed = False
    if queues:
        dead: list[asyncio.Queue] = []
        for q in list(queues):
            try:
                q.put_nowait(payload)
                pushed = True
            except asyncio.QueueFull:
                dead.append(q)
        for q in dead:
            queues.discard(q)
    if not _from_listener:
        try:
            from app.services.pg_pubsub import pg_notify
            asyncio.get_running_loop().create_task(
                pg_notify("agent", member_id, payload.get("event_type", ""), payload)
            )
        except RuntimeError:
            pass  # 이벤트 루프 없음 (테스트 등)
    return pushed


def _event_to_payload(event: "Event") -> dict:
    return {
        "event_id": str(event.id),
        "event_type": event.event_type,
        "source": {"type": event.source_entity_type, "id": str(event.source_entity_id) if event.source_entity_id else None},
        "sender_id": str(event.sender_id) if event.sender_id else None,
        "payload": event.payload,
        "created_at": event.created_at.isoformat(),
    }


# ─── SSE endpoint ─────────────────────────────────────────────────────────────



# ─── Pydantic schemas ─────────────────────────────────────────────────────────

class CreateEventRequest(BaseModel):
    project_id: uuid.UUID
    event_type: str
    source_entity_type: str | None = None
    source_entity_id: uuid.UUID | None = None
    sender_id: uuid.UUID | None = None
    recipient_id: uuid.UUID
    recipient_type: str
    payload: dict = {}


class EventResponse(BaseModel):
    id: uuid.UUID
    project_id: uuid.UUID
    org_id: uuid.UUID
    event_type: str
    source_entity_type: str | None
    source_entity_id: uuid.UUID | None
    sender_id: uuid.UUID | None
    recipient_id: uuid.UUID
    recipient_type: str
    payload: dict
    status: str
    created_at: datetime
    delivered_at: datetime | None

    model_config = ConfigDict(from_attributes=True)


# ─── Agent SSE stream (S2) ────────────────────────────────────────────────────

@router.get("/stream")
async def agent_event_stream(
    request: Request,
    member_id: uuid.UUID | None = Query(default=None),  # AC2: API key 시 자동 추출, JWT 시 필수
    auth: AuthContext = Depends(get_current_user_streaming),  # AC1: Bearer {API_KEY} 또는 JWT — 없으면 401 (AC3). P0(#abaf6279): SSE 커넥션 비점유 변형
    org_id: uuid.UUID = Depends(get_verified_org_id_streaming),
    since_timestamp: datetime | None = Query(default=None),
    last_event_id: uuid.UUID | None = Query(default=None),
):
    """GET /api/v2/events/stream — 에이전트 전용 SSE 스트림.

    인증: Authorization: Bearer {API_KEY} 또는 JWT.
    API Key 사용 시 member_id 자동 추출 — 쿼리 파라미터 불필요.
    JWT 사용 시 member_id 쿼리 파라미터 필수.

    이벤트:
    - heartbeat: 30초마다 연결 유지
    - <event_type>: 이벤트버스 이벤트 실시간 수신
    """
    from app.core.database import async_session_factory

    is_api_key = bool(auth.claims.get("app_metadata", {}).get("api_key_id"))

    # AC2: API key → member_id 자동 추출 (auth.user_id = team_member.id)
    if is_api_key:
        resolved_member_id = uuid.UUID(auth.user_id)
        # query param이 명시된 경우 일치 여부 검증 — AC4
        if member_id is not None and member_id != resolved_member_id:
            raise HTTPException(status_code=403, detail="API key can only subscribe to its own stream")
    else:
        if member_id is None:
            raise HTTPException(status_code=400, detail="member_id query parameter required")
        resolved_member_id = member_id

    # member_id가 org 소속인지 검증 + AC4: JWT 경로에서 타인 stream 접근 차단
    async with async_session_factory() as db:
        result = await db.execute(
            select(TeamMember).where(
                TeamMember.id == resolved_member_id,
                TeamMember.org_id == org_id,
            )
        )
        member_row = result.scalar_one_or_none()
        if member_row is None:
            raise HTTPException(status_code=404, detail="Member not found")

        # AC4: JWT 사용자는 자신의 team_member(user_id 일치)에만 구독 허용
        if not is_api_key:
            if member_row.user_id is None or str(member_row.user_id) != auth.user_id:
                raise HTTPException(status_code=403, detail="Cannot subscribe to another member's stream")

    # AC1(S-COMM-05): Last-Event-ID 헤더 우선, 쿼리 파라미터 fallback (RFC 8895)
    _header_last_id = request.headers.get("Last-Event-ID") or request.headers.get("last-event-id")
    if _header_last_id and last_event_id is None:
        try:
            last_event_id = uuid.UUID(_header_last_id)
        except (ValueError, AttributeError):
            pass

    # S20: 전역 연결 수 제한 — 초과 시 503
    global _sse_connection_count
    if _sse_connection_count >= _MAX_SSE_CONNECTIONS:
        raise HTTPException(status_code=503, detail="SSE connection limit reached")
    _sse_connection_count += 1

    member_id_str = str(resolved_member_id)
    queue: asyncio.Queue[dict] = asyncio.Queue(maxsize=200)
    _agent_connections[member_id_str].add(queue)

    async def generate():
        try:
            # 즉시 heartbeat → HTTP 응답 헤더 즉시 반환 (대량 백필 전 hang 방지)
            yield "event: heartbeat\ndata: {}\n\n"

            # S6-1: pending 이벤트 백필 — threshold 기반 볼륨 제어
            async with async_session_factory() as db:
                now = datetime.now(timezone.utc)

                # 기준 시각 결정: last_event_id > since_timestamp > None 우선순위
                ref_ts: datetime | None = since_timestamp
                if last_event_id is not None:
                    ts_row = await db.execute(
                        select(Event.created_at).where(Event.id == last_event_id)
                    )
                    ts = ts_row.scalar_one_or_none()
                    if ts is not None:
                        ref_ts = ts if ts.tzinfo else ts.replace(tzinfo=timezone.utc)

                _ref = ref_ts if ref_ts is None or ref_ts.tzinfo else ref_ts.replace(tzinfo=timezone.utc)
                # S0-1: 초기 연결(last_event_id=None, since_timestamp=None)은 INITIAL 상한 적용
                is_initial = last_event_id is None and since_timestamp is None
                exceed, limit = _compute_backfill_mode(_ref, now, initial=is_initial)
                if exceed:
                    # threshold 초과: _ref 이후 최근 N건만 (최신순 → 역순 전달로 시간 순서 보존)
                    exceed_clauses: list[Any] = [
                        Event.org_id == org_id,
                        Event.recipient_id == resolved_member_id,
                        Event.status == "pending",
                    ]
                    if _ref is not None:
                        if last_event_id is not None:
                            exceed_clauses.append(
                                or_(
                                    Event.created_at > _ref,
                                    and_(Event.created_at == _ref, Event.id > last_event_id),
                                )
                            )
                        else:
                            exceed_clauses.append(Event.created_at > _ref)
                    result = await db.execute(
                        select(Event)
                        .where(*exceed_clauses)
                        .order_by(Event.created_at.desc())
                        .limit(limit)
                    )
                    pending_events = list(reversed(result.scalars().all()))
                else:
                    # threshold 이내: ref_ts 이후 전량 (최대 100건)
                    where_clauses: list[Any] = [
                        Event.org_id == org_id,
                        Event.recipient_id == resolved_member_id,
                        Event.status == "pending",
                    ]
                    if _ref is not None:
                        if last_event_id is not None:
                            # 복합 커서: 동일 타임스탬프 이벤트 누락 방지
                            where_clauses.append(
                                or_(
                                    Event.created_at > _ref,
                                    and_(Event.created_at == _ref, Event.id > last_event_id),
                                )
                            )
                        else:
                            where_clauses.append(Event.created_at > _ref)
                    result = await db.execute(
                        select(Event)
                        .where(*where_clauses)
                        .order_by(Event.created_at.asc())
                        .limit(100)
                    )
                    pending_events = result.scalars().all()

                for i in range(0, len(pending_events), _SSE_BATCH_SIZE):
                    batch = pending_events[i : i + _SSE_BATCH_SIZE]
                    batch_data = [_event_to_payload(evt) for evt in batch]
                    # 1c22da3e fix: yield 먼저 → 성공 후 delivered 마킹.
                    # 선마킹 시 yield(클라 disconnect 등) 실패하면 이벤트가 delivered로
                    # 남아 영구 누락. 후마킹 + 클라 seen_ids dedup 으로 손실 0(재전송 허용).
                    for data, evt in zip(batch_data, batch):
                        yield f"event: {evt.event_type}\nid: {evt.id}\ndata: {json.dumps({**data, 'is_backfill': True})}\n\n"
                    for evt in batch:
                        evt.status = "delivered"
                        evt.delivered_at = now
                    await db.commit()

            # 신규 이벤트 리슨 — 대기 구간에서 커넥션 미점유, 이벤트마다 개별 세션
            while not await request.is_disconnected():
                try:
                    event_data = await asyncio.wait_for(queue.get(), timeout=_SSE_HEARTBEAT_TIMEOUT)
                    event_type = event_data.get("event_type", "message")
                    # 1c22da3e fix: yield 전엔 pending 여부만 확인(skip 판정, 마킹 X),
                    # delivered 마킹은 yield 성공 후로 미룬다 → yield 실패 시 영구 누락 방지.
                    eid = event_data.get("event_id")
                    if eid:
                        try:
                            async with async_session_factory() as db:
                                r = await db.execute(
                                    select(Event.status).where(
                                        Event.id == uuid.UUID(eid),
                                        Event.org_id == org_id,
                                    )
                                )
                                _status = r.scalar_one_or_none()
                                if _status is not None and _status != "pending":
                                    # 이미 백필/타 연결에서 delivered → 중복 skip
                                    continue
                        except Exception:
                            pass
                    # event_id 없는 경로(chats direct push 등)도 id: 보장 — 재연결 추적 약화 방지
                    # is_backfill: False 명시 + event_id 동기화 — SeenIdsCache dedup 및 relay 필터 정합성
                    _live_id = eid or str(uuid.uuid4())
                    _sse_data = json.dumps({**event_data, 'event_id': _live_id, 'is_backfill': False})
                    # S-COMM-12: canonical 이벤트 시 legacy alias도 병행 yield (HTTP SSE 하위호환)
                    if event_type == "conversation.message_created":
                        yield f"event: conversation:message\nid: {_live_id}\ndata: {_sse_data}\n\n"
                    yield f"event: {event_type}\nid: {_live_id}\ndata: {_sse_data}\n\n"
                    # yield 성공 후 delivered 마킹 (1c22da3e: 손실 방지, dup은 클라 dedup)
                    if eid:
                        try:
                            async with async_session_factory() as db:
                                await db.execute(
                                    update(Event)
                                    .where(Event.id == uuid.UUID(eid), Event.status == "pending")
                                    .values(status="delivered", delivered_at=datetime.now(timezone.utc))
                                )
                                await db.commit()
                        except Exception:
                            pass
                except asyncio.TimeoutError:
                    # S20: heartbeat 후 즉시 disconnect 체크 — dead connection 조기 정리
                    yield "event: heartbeat\ndata: {}\n\n"
                    if await request.is_disconnected():
                        break
        except (asyncio.CancelledError, GeneratorExit):
            pass
        finally:
            global _sse_connection_count
            _sse_connection_count -= 1
            _agent_connections[member_id_str].discard(queue)
            if not _agent_connections[member_id_str]:
                _agent_connections.pop(member_id_str, None)

    return StreamingResponse(
        generate(),
        media_type="text/event-stream",
        headers={
            "Cache-Control": "no-cache",
            "X-Accel-Buffering": "no",
            "Connection": "keep-alive",
        },
    )


# ─── CRUD endpoints ───────────────────────────────────────────────────────────

@router.post("", response_model=EventResponse, status_code=201)
async def create_event(
    body: CreateEventRequest,
    background_tasks: BackgroundTasks,
    db: AsyncSession = Depends(get_db),
    org_id: uuid.UUID = Depends(get_verified_org_id),
) -> EventResponse:
    """POST /api/v2/events — 이벤트 생성 (내부용).

    recipient가 SSE 연결 중이면 즉시 전달 + status=delivered.
    미연결이면 status=pending 유지.
    Channel Router(S-A6)로 preference 기반 채널 결정 후 전달.
    """
    from app.models.team import TeamMember

    # recipient가 동일 org 소속인지 + type 확정
    result = await db.execute(
        select(TeamMember.type).where(
            TeamMember.id == body.recipient_id,
            TeamMember.org_id == org_id,
        )
    )
    member_type = result.scalar_one_or_none()
    if member_type is None:
        raise HTTPException(status_code=404, detail="Recipient not found")

    event = Event(
        project_id=body.project_id,
        org_id=org_id,
        event_type=body.event_type,
        source_entity_type=body.source_entity_type,
        source_entity_id=body.source_entity_id,
        sender_id=body.sender_id,
        recipient_id=body.recipient_id,
        recipient_type=member_type,
        payload=body.payload,
        status="pending",
    )
    db.add(event)
    await db.commit()
    await db.refresh(event)

    # S-A6: Channel Router 기반 dispatch (preference → sse/discord/etc.)
    from app.services.dispatch_router import route_dispatch_event as _route_dispatch
    background_tasks.add_task(_route_dispatch_bg, event.id)

    return EventResponse.model_validate(event)


async def _route_dispatch_bg(event_id: uuid.UUID) -> None:
    """BackgroundTask wrapper — 별도 DB 세션에서 dispatch routing."""
    from app.core.database import async_session_factory
    from app.services.dispatch_router import route_dispatch_event

    async with async_session_factory() as db:
        try:
            await route_dispatch_event(event_id, db)
        except Exception:
            import logging
            logging.getLogger(__name__).exception(
                "dispatch routing failed event_id=%s", event_id
            )


@router.get("/pending", response_model=list[EventResponse])
async def get_pending_events(
    recipient_id: uuid.UUID = Query(...),
    event_type: str | None = Query(default=None),
    include_recent_delivered_minutes: int = Query(default=30, le=120),
    db: AsyncSession = Depends(get_db),
    org_id: uuid.UUID = Depends(get_verified_org_id),
) -> list[EventResponse]:
    """GET /api/v2/events/pending — 수신자별 pending + 최근 N분 delivered 이벤트 목록.

    include_recent_delivered_minutes: SSE로 delivered 마킹된 이벤트도 최근 N분 이내라면 반환.
    → SSE 전달과 poll_events 폴링 간 충돌(갭 2) 해소.
    """
    cutoff = datetime.now(timezone.utc) - timedelta(minutes=include_recent_delivered_minutes)
    status_filter = or_(
        Event.status == "pending",
        and_(Event.status == "delivered", Event.delivered_at >= cutoff),
    )
    filters = [
        Event.org_id == org_id,
        Event.recipient_id == recipient_id,
        status_filter,
    ]
    if event_type:
        filters.append(Event.event_type == event_type)
    result = await db.execute(
        select(Event).where(*filters).order_by(Event.created_at.asc())
    )
    events = result.scalars().all()
    return [EventResponse.model_validate(e) for e in events]


@router.patch("/{event_id}/delivered", response_model=EventResponse)
async def mark_delivered(
    event_id: uuid.UUID,
    db: AsyncSession = Depends(get_db),
    org_id: uuid.UUID = Depends(get_verified_org_id),
) -> EventResponse:
    """PATCH /api/v2/events/{id}/delivered — 전달 완료 마킹."""
    result = await db.execute(
        select(Event).where(Event.id == event_id, Event.org_id == org_id)
    )
    event = result.scalar_one_or_none()
    if event is None:
        raise HTTPException(status_code=404, detail="Event not found")

    event.status = "delivered"
    event.delivered_at = datetime.now(timezone.utc)
    await db.commit()
    await db.refresh(event)
    return EventResponse.model_validate(event)


# ─── S3: 큐 관리 (expired + cleanup) ─────────────────────────────────────────

_EXPIRE_DAYS = 30  # pending → expired 후 이 기간 보관 (AC3: 최소 1일 이상)
_CLEANUP_DAYS = 7   # delivered 이벤트 삭제 주기 (AC3: 최소 1일 이상)
_EVENT_RETENTION_MIN_HOURS = 24  # S-COMM-05 AC3: 최소 보관 시간 (문서화 목적)
assert _EXPIRE_DAYS * 24 >= _EVENT_RETENTION_MIN_HOURS, "Event retention must be >= 24h"
assert _CLEANUP_DAYS * 24 >= _EVENT_RETENTION_MIN_HOURS, "Event cleanup must be >= 24h"


@router.post("/expire-stale", status_code=200)
async def expire_stale_events(
    db: AsyncSession = Depends(get_db),
    org_id: uuid.UUID = Depends(get_verified_org_id),
) -> dict:
    """POST /api/v2/events/expire-stale — 30일 초과 pending → expired, 7일 초과 delivered 삭제."""
    now = datetime.now(timezone.utc)
    cutoff_expire = now - timedelta(days=_EXPIRE_DAYS)
    cutoff_cleanup = now - timedelta(days=_CLEANUP_DAYS)

    expired = await db.execute(
        update(Event)
        .where(
            Event.org_id == org_id,
            Event.status == "pending",
            Event.created_at < cutoff_expire,
        )
        .values(status="expired")
    )

    cleaned = await db.execute(
        delete(Event).where(
            Event.org_id == org_id,
            Event.status == "delivered",
            Event.delivered_at < cutoff_cleanup,
        )
    )

    await db.commit()
    return {
        "expired": expired.rowcount,
        "cleaned": cleaned.rowcount,
    }
