"""이벤트 시스템 라우터.

C-S6: SSE 스트림 (메모 변경 이벤트 실시간 푸시)
E-EVENTBUS S1: events 테이블 CRUD (이벤트버스 기반)
"""
from __future__ import annotations

import asyncio
import json
import uuid
from collections import defaultdict
from datetime import datetime, timezone
from typing import Any

from fastapi import APIRouter, Depends, HTTPException, Query, Request
from fastapi.responses import StreamingResponse
from pydantic import BaseModel, ConfigDict
from sqlalchemy import select, update
from sqlalchemy.ext.asyncio import AsyncSession

from app.dependencies.auth import AuthContext, get_current_user
from app.dependencies.database import get_db
from app.models.event import Event

router = APIRouter(prefix="/api/v2/events", tags=["events"])

# ─── In-process event bus ─────────────────────────────────────────────────────
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
    org_id: uuid.UUID
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


# ─── CRUD endpoints ───────────────────────────────────────────────────────────

@router.post("", response_model=EventResponse, status_code=201)
async def create_event(
    body: CreateEventRequest,
    db: AsyncSession = Depends(get_db),
    _auth: AuthContext = Depends(get_current_user),
) -> EventResponse:
    """POST /api/v2/events — 이벤트 생성 (내부용)."""
    from app.models.team import TeamMember

    # recipient_type을 team_members.type 기준으로 확정
    result = await db.execute(
        select(TeamMember.type).where(TeamMember.id == body.recipient_id)
    )
    member_type = result.scalar_one_or_none()
    if member_type is None:
        raise HTTPException(status_code=404, detail="Recipient not found")

    event = Event(
        project_id=body.project_id,
        org_id=body.org_id,
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
    return EventResponse.model_validate(event)


@router.get("/pending", response_model=list[EventResponse])
async def get_pending_events(
    recipient_id: uuid.UUID = Query(...),
    db: AsyncSession = Depends(get_db),
    _auth: AuthContext = Depends(get_current_user),
) -> list[EventResponse]:
    """GET /api/v2/events/pending?recipient_id={id} — 수신자별 pending 이벤트 목록."""
    result = await db.execute(
        select(Event)
        .where(Event.recipient_id == recipient_id, Event.status == "pending")
        .order_by(Event.created_at.asc())
    )
    events = result.scalars().all()
    return [EventResponse.model_validate(e) for e in events]


@router.patch("/{event_id}/delivered", response_model=EventResponse)
async def mark_delivered(
    event_id: uuid.UUID,
    db: AsyncSession = Depends(get_db),
    _auth: AuthContext = Depends(get_current_user),
) -> EventResponse:
    """PATCH /api/v2/events/{id}/delivered — 전달 완료 마킹."""
    result = await db.execute(select(Event).where(Event.id == event_id))
    event = result.scalar_one_or_none()
    if event is None:
        raise HTTPException(status_code=404, detail="Event not found")

    event.status = "delivered"
    event.delivered_at = datetime.now(timezone.utc)
    await db.commit()
    await db.refresh(event)
    return EventResponse.model_validate(event)
