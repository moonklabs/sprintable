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

from fastapi import APIRouter, Depends, HTTPException, Query, Request
from fastapi.responses import StreamingResponse
from pydantic import BaseModel, ConfigDict
from sqlalchemy import delete, select, update
from sqlalchemy.ext.asyncio import AsyncSession

from app.dependencies.auth import AuthContext, get_current_user, get_verified_org_id
from app.dependencies.database import get_db
from app.models.event import Event

router = APIRouter(prefix="/api/v2/events", tags=["events"])

# ─── In-process event bus (C-S6: memo SSE) ────────────────────────────────────
# org_id → set of queues (one per connected SSE client)
_subscribers: dict[str, set[asyncio.Queue[dict]]] = defaultdict(set)


def publish_event(org_id: str, event_type: str, data: dict) -> None:
    """다른 라우터에서 이벤트를 발행할 때 호출."""
    payload = {"type": event_type, **data}
    dead: list[asyncio.Queue] = []
    for q in _subscribers.get(org_id, set()):
        try:
            q.put_nowait(dict(payload))  # copy per subscriber — shared dict mutation 방지
        except asyncio.QueueFull:
            dead.append(q)
    for q in dead:
        _subscribers[org_id].discard(q)


# ─── Agent connection registry (S2/S3: 에이전트별 SSE) ───────────────────────
# member_id (str) → set[Queue] — 다중 연결 지원, 해제 시 해당 queue만 제거
_agent_connections: dict[str, set[asyncio.Queue[dict]]] = defaultdict(set)

_SSE_BATCH_SIZE = 10  # 배치 전달 청크 크기


def _push_to_agent(member_id: str, payload: dict) -> bool:
    """연결 중인 에이전트 모든 큐에 SSE 페이로드 전송. True=1개 이상 전달, False=미연결."""
    queues = _agent_connections.get(member_id)
    if not queues:
        return False
    pushed = False
    dead: list[asyncio.Queue] = []
    for q in list(queues):
        try:
            q.put_nowait(payload)
            pushed = True
        except asyncio.QueueFull:
            dead.append(q)
    for q in dead:
        queues.discard(q)
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

@router.get("/memos")
async def memo_event_stream(
    request: Request,
    auth: AuthContext = Depends(get_current_user),
    member_id: str | None = Query(default=None),
):
    """GET /api/v2/events/memos — SSE 스트림.

    이벤트:
    - heartbeat: 30초마다 연결 유지
    - memo_created: 새 메모 INSERT
    - memo_updated: 메모 UPDATE
    - reply_created: 새 메모 답글 INSERT
    """
    org_id = auth.claims.get("app_metadata", {}).get("org_id", auth.user_id)
    queue: asyncio.Queue[dict] = asyncio.Queue(maxsize=100)
    _subscribers[org_id].add(queue)

    async def generate():
        try:
            while not await request.is_disconnected():
                try:
                    event = await asyncio.wait_for(queue.get(), timeout=30.0)
                    event_type = event.get("type", "message")
                    data = {k: v for k, v in event.items() if k != "type"}
                    yield f"event: {event_type}\ndata: {json.dumps(data)}\n\n"
                except asyncio.TimeoutError:
                    yield "event: heartbeat\ndata: {}\n\n"
        except (asyncio.CancelledError, GeneratorExit):
            pass
        finally:
            _subscribers[org_id].discard(queue)

    return StreamingResponse(
        generate(),
        media_type="text/event-stream",
        headers={
            "Cache-Control": "no-cache",
            "X-Accel-Buffering": "no",
            "Connection": "keep-alive",
        },
    )


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
    member_id: uuid.UUID = Query(...),
    db: AsyncSession = Depends(get_db),
    org_id: uuid.UUID = Depends(get_verified_org_id),
):
    """GET /api/v2/events/stream?member_id={id} — 에이전트 전용 SSE 스트림.

    이벤트:
    - heartbeat: 30초마다 연결 유지
    - <event_type>: 이벤트버스 이벤트 실시간 수신
    """
    from app.models.team import TeamMember

    # member_id가 요청자 org 소속인지 검증
    result = await db.execute(
        select(TeamMember.id).where(
            TeamMember.id == member_id,
            TeamMember.org_id == org_id,
        )
    )
    if result.scalar_one_or_none() is None:
        raise HTTPException(status_code=404, detail="Member not found")

    member_id_str = str(member_id)
    queue: asyncio.Queue[dict] = asyncio.Queue(maxsize=200)
    _agent_connections[member_id_str].add(queue)

    async def generate():
        try:
            # 연결 즉시 pending 이벤트 백필 전달 (배치: 10건 청크)
            result = await db.execute(
                select(Event)
                .where(
                    Event.org_id == org_id,
                    Event.recipient_id == member_id,
                    Event.status == "pending",
                )
                .order_by(Event.created_at.asc())
            )
            pending_events = result.scalars().all()
            for i in range(0, len(pending_events), _SSE_BATCH_SIZE):
                batch = pending_events[i : i + _SSE_BATCH_SIZE]
                for evt in batch:
                    data = _event_to_payload(evt)
                    yield f"event: {evt.event_type}\ndata: {json.dumps(data)}\n\n"
                    evt.status = "delivered"
                    evt.delivered_at = datetime.now(timezone.utc)
                if batch:
                    await db.commit()

            # 신규 이벤트 리슨 — yield 후 delivered 마킹 (at-least-once)
            while not await request.is_disconnected():
                try:
                    event_data = await asyncio.wait_for(queue.get(), timeout=30.0)
                    event_type = event_data.get("event_type", "message")
                    yield f"event: {event_type}\ndata: {json.dumps(event_data)}\n\n"
                    # yield 후 DB delivered 마킹 — 실제 전송 시도 후 처리
                    if eid := event_data.get("event_id"):
                        try:
                            r = await db.execute(
                                select(Event).where(
                                    Event.id == uuid.UUID(eid),
                                    Event.status == "pending",
                                    Event.org_id == org_id,
                                )
                            )
                            live_evt = r.scalar_one_or_none()
                            if live_evt:
                                live_evt.status = "delivered"
                                live_evt.delivered_at = datetime.now(timezone.utc)
                                await db.commit()
                        except Exception:
                            pass
                except asyncio.TimeoutError:
                    yield "event: heartbeat\ndata: {}\n\n"
        except (asyncio.CancelledError, GeneratorExit):
            pass
        finally:
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
    db: AsyncSession = Depends(get_db),
    org_id: uuid.UUID = Depends(get_verified_org_id),
) -> EventResponse:
    """POST /api/v2/events — 이벤트 생성 (내부용).

    recipient가 SSE 연결 중이면 즉시 전달 + status=delivered.
    미연결이면 status=pending 유지.
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

    # SSE 라우팅: 연결 중인 에이전트에게 즉시 전달 (delivered 마킹은 SSE yield 후 처리)
    if member_type == "agent":
        _push_to_agent(str(body.recipient_id), _event_to_payload(event))

    return EventResponse.model_validate(event)


@router.get("/pending", response_model=list[EventResponse])
async def get_pending_events(
    recipient_id: uuid.UUID = Query(...),
    db: AsyncSession = Depends(get_db),
    org_id: uuid.UUID = Depends(get_verified_org_id),
) -> list[EventResponse]:
    """GET /api/v2/events/pending?recipient_id={id} — 수신자별 pending 이벤트 목록."""
    result = await db.execute(
        select(Event)
        .where(
            Event.org_id == org_id,
            Event.recipient_id == recipient_id,
            Event.status == "pending",
        )
        .order_by(Event.created_at.asc())
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

_EXPIRE_DAYS = 30
_CLEANUP_DAYS = 7


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
