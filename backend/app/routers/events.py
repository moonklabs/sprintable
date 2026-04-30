"""C-S6: Supabase Realtime → FastAPI SSE 대체

메모 변경 이벤트를 SSE(Server-Sent Events)로 스트리밍.
클라이언트는 EventSource로 연결하여 memo_created / memo_updated / reply_created 이벤트를 수신.

실제 DB 변경 감지는 in-process 이벤트 버스 (asyncio.Queue) 사용.
"""
from __future__ import annotations

import asyncio
import json
import uuid
from collections import defaultdict
from typing import Any

from fastapi import APIRouter, Depends, Query, Request
from fastapi.responses import StreamingResponse

from app.dependencies.auth import AuthContext, get_current_user

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
            q.put_nowait(payload)
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
                    event_type = event.pop("type", "message")
                    yield f"event: {event_type}\ndata: {json.dumps(event)}\n\n"
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
