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
from app.core import shutdown as _shutdown_module
from app.dependencies.database import get_db
from app.dependencies.ownership import _is_org_admin
from app.models.event import Event
from app.services.member_resolver import assert_caller_is_member, resolve_member_identity

router = APIRouter(prefix="/api/v2/events", tags=["events", "Organization"])

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

# story #2101(2026-07-22, 까심군 raw curl 재현 확認): 같은 member의 동시 연결(다중 탭)이
# 있으면 delivered가 Event 행 하나에 전역 플래그라 — 탭A가 먼저 받아 delivered로 마킹하면
# 탭B가 재연결 시 status=="pending"만 보는 백필에서 그 이벤트가 영구 제외된다(탭B 자신은
# 못 받았는데도). `/pending`(get_pending_events, include_recent_delivered_minutes)이 이미
# 같은 문제를 "최근 delivered도 포함"으로 풀어놨는데 SSE 스트림 자체의 백필엔 그 처리가
# 없었다 — 동형으로 맞춘다("최소 한 번 배달 + 수신측 dedup"이 분산시스템 표준, "정확히
# 한 번"을 위한 connection/session 단위 추적은 스키마 변경급이라 이번 스코프 아님).
# 값 근거(임의 아님): `apps/web/src/hooks/use-chat-sse.ts`의 RECONNECT_DELAYS_MS =
# [5,30,60,300]초가 4번째 실패부터 300초에서 plateau(더 안 늘어남, 무한 재시도) — 즉
# 클라가 아무리 여러 번 실패해도 "다음 재시도까지의 간격"은 300초를 절대 안 넘는다.
# N을 이보다 작게 잡으면 백오프가 plateau에 도달한 뒤 다시 갭이 재발하는 구조적 하한이라,
# 300초는 절충이 아니라 이 재연결 루프가 보장하는 정확한 경계값이다.
_BACKFILL_RECENT_DELIVERED_SECONDS: int = int(
    _os.getenv("BACKFILL_RECENT_DELIVERED_SECONDS", "300")
)


def _pending_or_recently_delivered_filter(now: "datetime"):
    """story #2101 — 백필 status 필터: pending 전량 + 최근 N초 이내 delivered.

    `/pending`(get_pending_events)의 include_recent_delivered_minutes와 동형 —
    같은 member의 다른 연결이 먼저 받아 delivered로 마킹한 이벤트도 재연결한 이
    연결이 다시 받게 한다(영구 유실 방지, 중복은 클라 dedup이 처리)."""
    cutoff = now - timedelta(seconds=_BACKFILL_RECENT_DELIVERED_SECONDS)
    return or_(
        Event.status == "pending",
        and_(Event.status == "delivered", Event.delivered_at >= cutoff),
    )


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
        # prod 커넥션 누수 근본fix(2026-07-08) — 참조 미보관 create_task는 GC가 pg_notify()의
        # async with async_session_factory() 도중 태스크를 조기수거할 수 있다(공식 문서 경고) —
        # fire_and_forget이 강한 참조를 보관해 이를 막는다.
        # E-ARCH S2(story #2078): pg_notify() 직접 호출 → event_broker.publish()로 — PG NOTIFY는
        # 그대로(내부에서 동일 호출) + event_broker_redis_dual_publish_enabled 시 Redis shadow
        # 추가 발행(기본 off, 무회귀).
        from app.services.event_broker import event_broker
        from app.services.pg_pubsub import fire_and_forget
        fire_and_forget(event_broker.publish("agent", member_id, payload.get("event_type", ""), payload))
    return pushed


async def push_to_org_members(
    org_id: str, event_type: str, data: dict, *, member_ids: set[str] | None = None,
) -> None:
    """story #2139/#2132 근본수정 — 예전 `publish_event()`의 org-level fanout은 아무도
    구독하지 않는 영구 죽은 레지스트리였다(_subscribers.add() 호출처 저장소 전체 0곳,
    story #2059/#2067/#2132 실측). 실제 브라우저/에이전트 배달 경로는 `_push_to_agent()`
    (`_agent_connections[member_id]`)뿐이라, org 단위 발행도 결국 이 경로로 개별 push해야
    실제로 도달한다.

    `member_ids` 미지정(None) 시 org 전체 활성 멤버(`org_members`, human+agent 전부)에게
    보낸다 — presence 전용(#2139 §3, 오르테가 확定: project로 좁히지 않는다. 호출부 4곳이
    애초에 project_id를 안 들고 있고, 에이전트는 multi-project·DM은 project 자체가 없어
    데이터가 org 단위다). `member_ids` 지정 시 그 집합에게만 — conversation.working 전용
    (참가자만, org 전체 아님 — payload가 conversation 단위라 org로 보내면 새는 것).

    best-effort — caller가 감싼 try/except 전제(presence_events.py 관례)로 자체 예외 전파.
    자기 세션을 열고 닫아(member_ids=None일 때만) caller의 세션 상태와 무관하게 동작."""
    ids = member_ids
    if ids is None:
        from sqlalchemy import text as _text

        from app.core.database import async_session_factory
        async with async_session_factory() as session:
            rows = await session.execute(
                _text("SELECT id FROM org_members WHERE org_id = :org_id AND deleted_at IS NULL"),
                {"org_id": org_id},
            )
            ids = {str(r[0]) for r in rows.all()}
    for mid in ids:
        _push_to_agent(mid, {"event_type": event_type, **data})


def _event_to_payload(event: "Event") -> dict:
    return {
        "event_id": str(event.id),
        "event_type": event.event_type,
        "source": {"type": event.source_entity_type, "id": str(event.source_entity_id) if event.source_entity_id else None},
        "sender_id": str(event.sender_id) if event.sender_id else None,
        "payload": event.payload,
        # E-EVENT-INJECT S1: content를 SSE top-level로 노출(conversation.message_created 미러).
        # connector가 top-level content를 읽어 드롭 안 걸리게.
        "content": (event.payload or {}).get("content"),
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
    # E-MEMBER-SSOT Phase 0: team_member 강요 제거 — grant-only 휴먼(org_member)도 구독 허용
    async with async_session_factory() as db:
        member_row = await resolve_member_identity(resolved_member_id, org_id, db)
        if member_row is None:
            raise HTTPException(status_code=404, detail="Member not found")

        # AC4: JWT 사용자는 자신의 신원(user_id 일치)에만 구독 허용
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

    # S20/#2121: 전역 연결 수 제한 — 503. Redis lease(공유·TTL 자가회수)가 주경로·Redis 불가 시 in-process 폴백.
    global _sse_connection_count
    _lease_conn_id = str(uuid.uuid4())
    from app.services import sse_lease
    _lease = await sse_lease.acquire("events_global", _MAX_SSE_CONNECTIONS, _lease_conn_id)
    if _lease is False:  # Redis lease: 전역 한계 초과
        raise HTTPException(status_code=503, detail="SSE connection limit reached")
    if _lease is None and _sse_connection_count >= _MAX_SSE_CONNECTIONS:  # Redis 불가 → in-process 폴백
        raise HTTPException(status_code=503, detail="SSE connection limit reached")
    _sse_connection_count += 1  # in-process shadow(Redis 다운 시 폴백용 유지)

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
                # story #2101: pending뿐 아니라 최근 delivered도 포함 — 동일 member의
                # 다른 연결(탭)이 먼저 받아 delivered로 마킹한 이벤트를, 재연결한 이 연결도
                # 다시 받게 한다(중복은 클라 dedup이 처리, 영구 유실 0이 목표).
                _status_filter = _pending_or_recently_delivered_filter(now)
                if exceed:
                    # threshold 초과: _ref 이후 최근 N건만 (최신순 → 역순 전달로 시간 순서 보존)
                    exceed_clauses: list[Any] = [
                        Event.org_id == org_id,
                        Event.recipient_id == resolved_member_id,
                        _status_filter,
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
                        _status_filter,
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
            # story c4c72eb1(E-ARCH GCE 이전) PR-A: 전역 shutdown_event를 queue.get()과 경합
            # 시켜(asyncio.wait FIRST_COMPLETED) 셧다운 신호에 하트비트 주기(최대 30초)를
            # 기다리지 않고 즉시 반응한다 — 강제 CancelledError 대신 정상 return으로 스트림을
            # 깔끔히 끝내 EventSource가 즉시 재연결하도록 유도(GCLB 드레이닝과 결합 시 자동으로
            # 건강한 인스턴스로 이동). shutdown 대기 태스크는 연결 생애주기 동안 단 1개만
            # 생성한다(루프마다 재생성하면 테스트 타이밍이 흔들려 test_s20 케이스가 불안정해짐 —
            # 뮤테이션 셀프체크로 확認됨, 매 iteration 재생성 버전은 실패).
            shutdown_wait_task = asyncio.create_task(_shutdown_module.shutdown_event.wait())
            try:
                while not await request.is_disconnected():
                    get_task = asyncio.create_task(queue.get())
                    try:
                        done, _pending = await asyncio.wait(
                            {get_task, shutdown_wait_task},
                            timeout=_SSE_HEARTBEAT_TIMEOUT,
                            return_when=asyncio.FIRST_COMPLETED,
                        )
                        if shutdown_wait_task in done:
                            get_task.cancel()
                            yield "event: shutdown_reconnect\ndata: {}\n\n"
                            return
                        if get_task not in done:
                            # 타임아웃 — 기존 heartbeat 분기
                            get_task.cancel()
                            # #2121: 연결 살아있음 → lease score 재갱신(TTL 만료 방지). off/다운 no-op.
                            await sse_lease.refresh("events_global", _lease_conn_id)
                            yield "event: heartbeat\ndata: {}\n\n"
                            if await request.is_disconnected():
                                break
                            continue
                        event_data = get_task.result()
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
                    finally:
                        if not get_task.done():
                            get_task.cancel()
            finally:
                if not shutdown_wait_task.done():
                    shutdown_wait_task.cancel()
        except (asyncio.CancelledError, GeneratorExit):
            pass
        finally:
            global _sse_connection_count
            _sse_connection_count -= 1
            # #2121: lease 명시 해제(최적화만·TTL 이 주 회수 경로). off/다운 no-op.
            await sse_lease.release("events_global", _lease_conn_id)
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
    auth: AuthContext = Depends(get_current_user),
) -> EventResponse:
    """POST /api/v2/events — 이벤트 생성 (내부용).

    recipient가 SSE 연결 중이면 즉시 전달 + status=delivered.
    미연결이면 status=pending 유지.
    Channel Router(S-A6)로 preference 기반 채널 결정 후 전달.

    S19(SHOULD, PO 포함 승인): sender_id가 검증 없이 body에서 그대로 신뢰돼 caller가 임의
    sender로 이벤트를 위조(임퍼스네이션)할 수 있었다. sender_id가 명시되면 caller 본인과
    일치해야만 허용(시스템 이벤트의 sender_id=None 케이스는 그대로 무변경).

    S19(발견·회귀수정): axis-safe 비교(assert_caller_is_member) 사용 — resolve_member()/.id
    직접비교는 휴먼 JWT caller에서 축이 어긋나 본인 sender_id 지정도 403날 수 있었다.
    """
    if body.sender_id is not None:
        await assert_caller_is_member(
            body.sender_id, auth, db, org_id, detail="sender_id must match the caller's own identity",
        )

    # recipient가 동일 org 소속인지 + type 확정
    # E-MEMBER-SSOT Phase 0: grant-only 휴먼(org_member)도 수신자로 허용
    recipient = await resolve_member_identity(body.recipient_id, org_id, db)
    if recipient is None:
        raise HTTPException(status_code=404, detail="Recipient not found")
    member_type = recipient.type

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
    await db.flush()  # event.id 확보
    # L1 BE-3: 같은 tx에서 활동 수렴(best-effort·SAVEPOINT) → event와 단일 commit(다른 fan-out
    # 사이트와 일관·commit 1회 유지). 추출 실패해도 SAVEPOINT만 롤백, delivery는 정상 commit.
    from app.services.activity_stream import extract_activities_best_effort
    await extract_activities_best_effort(db, [event.id])
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
    auth: AuthContext = Depends(get_current_user),
) -> list[EventResponse]:
    """GET /api/v2/events/pending — 수신자별 pending + 최근 N분 delivered 이벤트 목록.

    include_recent_delivered_minutes: SSE로 delivered 마킹된 이벤트도 최근 N분 이내라면 반환.
    → SSE 전달과 poll_events 폴링 간 충돌(갭 2) 해소.

    산티아고 SME 최종 MUST(S19): recipient_id 쿼리로 타 member 이벤트(payload/sender/source)를
    auth·recipient 검증 없이 읽을 수 있었다 — mark_delivered(write)는 recipient==caller로
    닫혔는데 같은 recipient 축의 이 read fallback이 열려있었다. 동일 패턴(순수 self, admin
    대리열람 흐름 없음)으로 닫는다.
    """
    await assert_caller_is_member(
        recipient_id, auth, db, org_id, detail="Cannot read another member's events",
    )
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
    auth: AuthContext = Depends(get_current_user),
) -> EventResponse:
    """PATCH /api/v2/events/{id}/delivered — 전달 완료 마킹.

    S19(#7 MUST): org-scope만 있고 recipient 확인이 없어 누구나 타 member의 이벤트를
    delivered로 마킹(알림 은폐)할 수 있었다. caller==recipient 강제(axis-safe).

    S19(발견·회귀수정): resolve_member()/.id 직접비교는 휴먼 JWT caller의 axis가 어긋나 본인
    이벤트도 403날 수 있었다 — assert_caller_is_member로 교체.
    """
    result = await db.execute(
        select(Event).where(Event.id == event_id, Event.org_id == org_id)
    )
    event = result.scalar_one_or_none()
    if event is None:
        raise HTTPException(status_code=404, detail="Event not found")

    await assert_caller_is_member(
        event.recipient_id, auth, db, org_id, detail="Not the recipient of this event",
    )

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


async def expire_stale_events_core(
    db: AsyncSession, org_id: uuid.UUID | None
) -> dict:
    """30일 초과 pending → expired, 7일 초과 delivered 삭제.

    ``org_id`` 가 주어지면 그 org 로 스코프(엔드포인트 경로), ``None`` 이면 전 org 일괄
    회수(cron 경로). E-EVENT-1CONFIG: ACK retire 가 delivered 로 마킹한 agent SSE 이벤트를
    이 cleanup 이 회수한다 — 둘이 짝이라 cron 미연결 시 retire 해도 영영 안 지워진다.
    """
    now = datetime.now(timezone.utc)
    cutoff_expire = now - timedelta(days=_EXPIRE_DAYS)
    cutoff_cleanup = now - timedelta(days=_CLEANUP_DAYS)

    expire_where = [Event.status == "pending", Event.created_at < cutoff_expire]
    cleanup_where = [Event.status == "delivered", Event.delivered_at < cutoff_cleanup]
    if org_id is not None:
        expire_where.append(Event.org_id == org_id)
        cleanup_where.append(Event.org_id == org_id)

    expired = await db.execute(update(Event).where(*expire_where).values(status="expired"))
    cleaned = await db.execute(delete(Event).where(*cleanup_where))

    await db.commit()
    return {"expired": expired.rowcount, "cleaned": cleaned.rowcount}


@router.post("/expire-stale", status_code=200)
async def expire_stale_events(
    db: AsyncSession = Depends(get_db),
    org_id: uuid.UUID = Depends(get_verified_org_id),
    auth: AuthContext = Depends(get_current_user),
) -> dict:
    """POST /api/v2/events/expire-stale — 30일 초과 pending → expired, 7일 초과 delivered 삭제.

    S19(SHOULD, PO 포함 승인): per-resource ownership 문제가 아니라 privilege 게이트 자체가
    없어 org 내 임의 멤버가 org 전체 이벤트 만료/삭제를 강제할 수 있었다. org-admin 전용으로 닫는다.
    """
    if not await _is_org_admin(db, org_id, uuid.UUID(auth.user_id)):
        raise HTTPException(status_code=403, detail="org admin/owner required")
    return await expire_stale_events_core(db, org_id)
