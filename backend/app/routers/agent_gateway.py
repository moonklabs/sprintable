"""E-AGENT-GATEWAY Phase 0: per-recipient dense seq ê¸°ë° SSE ì¤í¸ë¦¼ + ACK.

ì´ì¤ì ë¬ fix: per-recipient dense commit-ordered seq (recipient_seq).
start_seq = max(acked_seq DB, Last-Event-ID í¤ë)
backfill = live-tail = ëì¼ ì¿¼ë¦¬ â ê²¹ì¹¨ 0.
"""
from __future__ import annotations

import asyncio
import json
import os
import uuid
from datetime import datetime, timezone

from fastapi import APIRouter, Depends, HTTPException, Query, Request
from fastapi.responses import StreamingResponse
from pydantic import BaseModel
from sqlalchemy import select, text, update
from sqlalchemy.ext.asyncio import AsyncSession

from app.dependencies.auth import AuthContext, get_current_user, get_current_user_streaming
from app.core.database import async_session_factory
from app.dependencies.database import get_db
from app.models.agent_gateway import AgentEventCursor, AgentGatewaySession
from app.models.event import Event
from app.models.team import TeamMember
from app.routers.events import _agent_connections, _event_to_payload

router = APIRouter(prefix="/api/v2/agent", tags=["agent-gateway"])

_SSE_HEARTBEAT: float = float(os.getenv("SSE_HEARTBEAT_TIMEOUT", "30"))
_BACKFILL_LIMIT: int = int(os.getenv("AGENT_GATEWAY_BACKFILL_LIMIT", "100"))

# âââ wake_agent: commit í í ìë¦¼ ââââââââââââââââââââââââââââââââââââââââââââ

def wake_agent(agent_id: str, seq: int, _from_listener: bool = False) -> None:
    """ì ê· ì´ë²¤í¸ ì»¤ë° í ìì´ì í¸ SSE íì wake ì í¸ ì ì¡.

    ìì´ì í¸ë ì í¸ ìì  í recipient_seq > cursor ì¡°í (payload ë¯¸í¬í¨).
    _from_listener=True: pg_notify ì¬ë°í ê¸ì§.
    """
    payload = {"__wake__": True, "seq": seq}
    queues = _agent_connections.get(agent_id)
    if queues:
        dead = []
        for q in list(queues):
            try:
                q.put_nowait(payload)
            except asyncio.QueueFull:
                dead.append(q)
        for q in dead:
            queues.discard(q)
    if not _from_listener:
        try:
            from app.services.pg_pubsub import pg_notify
            asyncio.get_running_loop().create_task(
                pg_notify("agent", agent_id, "__wake__", {"seq": seq})
            )
        except RuntimeError:
            pass



async def _fetch_events(
    session: AsyncSession,
    agent_id: uuid.UUID,
    after_seq: int,
    limit: int,
) -> list:
    """recipient_seq > after_seqì¸ visible ì´ë²¤í¸ ë°í (raw rows).

    ì ë ¬: recipient_seq ASC. per-recipient dense â gap-free.
    gap-free ë³´ì¥ì acked_seq ì¬ì¤ìº(caller)ì´ ë´ë¹; ì´ í¨ìë ë¨ì ì¡°í.
    """
    rows = await session.execute(
        text("""
            SELECT
                e.id::text            AS event_id,
                e.event_type,
                e.recipient_seq,
                e.source_entity_type,
                e.source_entity_id::text AS source_entity_id,
                e.sender_id::text     AS sender_id,
                e.payload,
                e.created_at
            FROM events e
            WHERE e.recipient_id = CAST(:agent_id AS uuid)
              AND e.recipient_seq > :after_seq
            ORDER BY e.recipient_seq ASC
            LIMIT :limit
        """),
        {"agent_id": str(agent_id), "after_seq": after_seq, "limit": limit},
    )
    return rows.fetchall()


def _row_to_payload(row: object) -> dict:
    """_fetch_events row â SSE payload dict."""
    _payload = (json.loads(row.payload)  # type: ignore[attr-defined]
               if isinstance(row.payload, str) else row.payload)
    return {
        "event_id": row.event_id,  # type: ignore[attr-defined]
        "event_type": row.event_type,  # type: ignore[attr-defined]
        "recipient_seq": row.recipient_seq,  # type: ignore[attr-defined]
        "source": {
            "type": row.source_entity_type,  # type: ignore[attr-defined]
            "id": row.source_entity_id,  # type: ignore[attr-defined]
        },
        "sender_id": row.sender_id,  # type: ignore[attr-defined]
        "payload": _payload,
        # E-EVENT-INJECT S1: content를 SSE top-level로 노출 → connector 드롭 방지.
        "content": (_payload or {}).get("content"),
        "created_at": row.created_at.isoformat(),  # type: ignore[attr-defined]
    }


# âââ backward compat: êµ¬ _push_to_agent í¸í ëí¼ ââââââââââââââââââââââââââââ

def _push_to_agent_v2(member_id: str, payload: dict, _from_listener: bool = False) -> bool:
    """êµ¬ _push_to_agent í¸ì¶ë¶ í¸í â gateway_seq ìì¼ë©´ wake_agentë¡ ìì."""
    seq = payload.get("recipient_seq") or payload.get("gateway_seq")
    if seq is not None:
        wake_agent(member_id, int(seq), _from_listener=_from_listener)
        return True
    # gateway_seq ìë ê²½ì°(ë ê±°ì ê²½ë¡): ê¸°ì¡´ í ì§ì  push fallback
    from app.routers.events import _push_to_agent as _legacy_push
    return _legacy_push(member_id, payload, _from_listener=_from_listener)


# âââ GET /api/v2/agent/stream âââââââââââââââââââââââââââââââââââââââââââââââââ

@router.get("/stream")
async def agent_stream(
    request: Request,
    # P0(#abaf6279 íì): SSE long-lived ìì²­ì´ get_db ì¸ìì ì ì íë©´ API key í´ì
    # team_members ì¿¼ë¦¬ ì»¤ë¥ìì´ idle-in-transaction ìì¡´ → ë¹ì ì  streaming ë³í ì¬ì©.
    auth: AuthContext = Depends(get_current_user_streaming),
) -> StreamingResponse:
    """gateway_seq ê¸°ë° SSE ì¤í¸ë¦¼ (APIí¤ ì ì©).

    Last-Event-ID í¤ë = ë§ì§ë§ ìì  gateway_seq.
    start_seq = max(DB acked_seq, Last-Event-ID).
    """
    is_api_key = bool(auth.claims.get("app_metadata", {}).get("api_key_id"))
    if not is_api_key:
        raise HTTPException(status_code=403, detail="API key required for agent stream")

    agent_id = uuid.UUID(auth.user_id)

    # agent_id ê²ì¦
    async with async_session_factory() as db:
        tm = (await db.execute(
            select(TeamMember).where(TeamMember.id == agent_id, TeamMember.type == "agent")
        )).scalar_one_or_none()
        if tm is None:
            raise HTTPException(status_code=404, detail="Agent not found")

        # acked_seq DB ì¡°í
        cursor = (await db.execute(
            select(AgentEventCursor).where(AgentEventCursor.agent_id == agent_id)
        )).scalar_one_or_none()
        acked_seq: int = cursor.acked_seq if cursor else 0

        # ì¸ì ë±ë¡
        session_rec = AgentGatewaySession(
            id=uuid.uuid4(),
            agent_id=agent_id,
            connected_at=datetime.now(timezone.utc),
            last_seen_at=datetime.now(timezone.utc),
        )
        db.add(session_rec)
        await db.commit()

    # Last-Event-ID í¤ë íì± (gateway_seq)
    last_event_id_hdr = request.headers.get("Last-Event-ID") or request.headers.get("last-event-id")
    header_seq: int = 0
    if last_event_id_hdr:
        try:
            header_seq = int(last_event_id_hdr)
        except (ValueError, TypeError):
            pass

    start_seq = max(acked_seq, header_seq)
    agent_id_str = str(agent_id)

    queue: asyncio.Queue[dict] = asyncio.Queue(maxsize=200)
    _agent_connections[agent_id_str].add(queue)

    async def generate():
        """gap-free ordered-at-least-once SSE ì¤í¸ë¦¼.

        ì»¤ì ì ëµ: acked_seq(durable) ì¬ì¤ìº.
        - ë§¤ wakeë§ë¤ `gateway_seq > acked_seq` DB ì¬ì¤ìº â ë¦ê² ì»¤ë°ë ë®ì seqë ë°ëì ì¡í.
        - wake_floor: ì´ë² wake ë´ yieldí ìµë seq (ê°ì wake ì ì¤ë³µ ë°©ì§ì©).
        - acked_seqë í´ë¼ì´ì¸í¸ POST /ack ë¡ë§ ì ì§ â ìë²ê° ìë ì ì§ ì í¨.
        - í´ë¼ì´ì¸í¸ë seq ê¸°ë° dedup(ê°ì seq ë ë² ë°ìë í ë² ì²ë¦¬) íì.
        """
        try:
            yield "event: heartbeat\ndata: {}\n\n"

            # ì´ê¸° ë°±í â acked_seq(=start_seq)ë¶í° ì¬ì¤ìº
            async with async_session_factory() as db:
                rows = await _fetch_events(db, agent_id, start_seq, _BACKFILL_LIMIT)

            backfill_floor = start_seq  # ì´ë² ë°±í ë´ ì¤ë³µ ë°©ì§
            for row in rows:
                data = _row_to_payload(row)
                gseq = row.recipient_seq or 0
                if gseq > backfill_floor:  # ì¤ë³µ ë°©ì§
                    _sse = json.dumps({**data, "is_backfill": True})
                    yield f"event: {row.event_type}\nid: {gseq}\ndata: {_sse}\n\n"
                    backfill_floor = gseq

            # ì¤ìê° â wake ì í¸ â acked_seqë¶í° DB ì¬ì¤ìº
            while not await request.is_disconnected():
                try:
                    signal = await asyncio.wait_for(queue.get(), timeout=_SSE_HEARTBEAT)
                    if signal.get("__wake__"):
                        # ìµì  acked_seq ì¡°í (í´ë¼ì´ì¸í¸ê° ACK ë³´ëì ì ìì)
                        async with async_session_factory() as db:
                            cur = (await db.execute(
                                select(AgentEventCursor).where(AgentEventCursor.agent_id == agent_id)
                            )).scalar_one_or_none()
                            scan_from = max(start_seq, cur.acked_seq if cur else 0)
                            new_rows = await _fetch_events(db, agent_id, scan_from, _BACKFILL_LIMIT)

                        wake_floor = scan_from  # ì´ë² wake ë´ ì¤ë³µ ë°©ì§
                        for row in new_rows:
                            gseq = row.recipient_seq or 0
                            if gseq > wake_floor:
                                data = _row_to_payload(row)
                                _sse = json.dumps({**data, "is_backfill": False})
                                # AC2: ì¹´ë¼ ì´ë²¤í¸ëª only
                                yield f"event: {row.event_type}\nid: {gseq}\ndata: {_sse}\n\n"
                                wake_floor = gseq
                    else:
                        # ë ê±°ì ì§ì  push (AGENT_GATEWAY_V2 ë¯¸ì ì© ê²½ë¡)
                        event_type = signal.get("event_type", "message")
                        _live_id = signal.get("event_id") or str(uuid.uuid4())
                        _sse = json.dumps({**signal, "is_backfill": False})
                        yield f"event: {event_type}\nid: {_live_id}\ndata: {_sse}\n\n"
                except asyncio.TimeoutError:
                    yield "event: heartbeat\ndata: {}\n\n"
                    if await request.is_disconnected():
                        break
        except (asyncio.CancelledError, GeneratorExit):
            pass
        finally:
            _agent_connections[agent_id_str].discard(queue)
            if not _agent_connections[agent_id_str]:
                _agent_connections.pop(agent_id_str, None)

    return StreamingResponse(
        generate(),
        media_type="text/event-stream",
        headers={
            "Cache-Control": "no-cache",
            "X-Accel-Buffering": "no",
            "Connection": "keep-alive",
        },
    )


# âââ POST /api/v2/agent/events/ack ââââââââââââââââââââââââââââââââââââââââââââ

class AckRequest(BaseModel):
    seq: int


@router.post("/events/ack")
async def ack_event(
    body: AckRequest,
    db: AsyncSession = Depends(get_db),
    auth: AuthContext = Depends(get_current_user),
) -> dict:
    """ìì´ì í¸ê° ì²ë¦¬ ìë£í gateway_seq ACK â agent_event_cursors ê°±ì ."""
    is_api_key = bool(auth.claims.get("app_metadata", {}).get("api_key_id"))
    if not is_api_key:
        raise HTTPException(status_code=403, detail="API key required")

    agent_id = uuid.UUID(auth.user_id)

    # UPSERT acked_seq (ë ëì ê°ë§ ê°±ì )
    existing = (await db.execute(
        select(AgentEventCursor).where(AgentEventCursor.agent_id == agent_id)
    )).scalar_one_or_none()

    if existing is None:
        db.add(AgentEventCursor(agent_id=agent_id, acked_seq=body.seq))
    elif body.seq > existing.acked_seq:
        existing.acked_seq = body.seq
        existing.updated_at = datetime.now(timezone.utc)

    await db.commit()
    return {"acked_seq": body.seq}
