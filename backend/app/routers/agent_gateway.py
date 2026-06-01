"""E-AGENT-GATEWAY Phase 0: gateway_seq 기반 SSE 스트림 + ACK.

이중전달 fix: status 변이 폐기 → gateway_seq > start_seq 단조 커서.
start_seq = max(acked_seq DB, Last-Event-ID 헤더)
backfill = live-tail = 동일 쿼리 → 겹침 0.
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

from app.dependencies.auth import AuthContext, get_current_user
from app.core.database import async_session_factory
from app.dependencies.database import get_db
from app.models.agent_gateway import AgentEventCursor, AgentGatewaySession
from app.models.event import Event
from app.models.team import TeamMember
from app.routers.events import _agent_connections, _event_to_payload

router = APIRouter(prefix="/api/v2/agent", tags=["agent-gateway"])

_SSE_HEARTBEAT: float = float(os.getenv("SSE_HEARTBEAT_TIMEOUT", "30"))
_BACKFILL_LIMIT: int = int(os.getenv("AGENT_GATEWAY_BACKFILL_LIMIT", "100"))

# ─── wake_agent: commit 후 큐 알림 ────────────────────────────────────────────

def wake_agent(agent_id: str, seq: int, _from_listener: bool = False) -> None:
    """신규 이벤트 커밋 후 에이전트 SSE 큐에 wake 신호 전송.

    에이전트는 신호 수신 후 gateway_seq > current_seq 조회 (payload 미포함).
    _from_listener=True: pg_notify 재발행 금지.
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
    """gateway_seq > after_seq인 visible 이벤트 반환 (raw rows).

    정렬: gateway_seq ASC. visible이면 전달 — 커서 전진은 호출자가 결정.
    gap-free 보장은 acked_seq 재스캔(caller)이 담당; 이 함수는 단순 조회.
    """
    rows = await session.execute(
        text("""
            SELECT
                e.id::text            AS event_id,
                e.event_type,
                e.gateway_seq,
                e.source_entity_type,
                e.source_entity_id::text AS source_entity_id,
                e.sender_id::text     AS sender_id,
                e.payload,
                e.created_at
            FROM events e
            WHERE e.recipient_id = :agent_id::uuid
              AND e.gateway_seq > :after_seq
            ORDER BY e.gateway_seq ASC
            LIMIT :limit
        """),
        {"agent_id": str(agent_id), "after_seq": after_seq, "limit": limit},
    )
    return rows.fetchall()


def _row_to_payload(row: object) -> dict:
    """_fetch_events row → SSE payload dict."""
    return {
        "event_id": row.event_id,  # type: ignore[attr-defined]
        "event_type": row.event_type,  # type: ignore[attr-defined]
        "gateway_seq": row.gateway_seq,  # type: ignore[attr-defined]
        "source": {
            "type": row.source_entity_type,  # type: ignore[attr-defined]
            "id": row.source_entity_id,  # type: ignore[attr-defined]
        },
        "sender_id": row.sender_id,  # type: ignore[attr-defined]
        "payload": row.payload,  # type: ignore[attr-defined]
        "created_at": row.created_at.isoformat(),  # type: ignore[attr-defined]
    }


# ─── backward compat: 구 _push_to_agent 호환 래퍼 ────────────────────────────

def _push_to_agent_v2(member_id: str, payload: dict, _from_listener: bool = False) -> bool:
    """구 _push_to_agent 호출부 호환 — gateway_seq 있으면 wake_agent로 위임."""
    seq = payload.get("gateway_seq")
    if seq is not None:
        wake_agent(member_id, int(seq), _from_listener=_from_listener)
        return True
    # gateway_seq 없는 경우(레거시 경로): 기존 큐 직접 push fallback
    from app.routers.events import _push_to_agent as _legacy_push
    return _legacy_push(member_id, payload, _from_listener=_from_listener)


# ─── GET /api/v2/agent/stream ─────────────────────────────────────────────────

@router.get("/stream")
async def agent_stream(
    request: Request,
    auth: AuthContext = Depends(get_current_user),
) -> StreamingResponse:
    """gateway_seq 기반 SSE 스트림 (API키 전용).

    Last-Event-ID 헤더 = 마지막 수신 gateway_seq.
    start_seq = max(DB acked_seq, Last-Event-ID).
    """
    is_api_key = bool(auth.claims.get("app_metadata", {}).get("api_key_id"))
    if not is_api_key:
        raise HTTPException(status_code=403, detail="API key required for agent stream")

    agent_id = uuid.UUID(auth.user_id)

    # agent_id 검증
    async with async_session_factory() as db:
        tm = (await db.execute(
            select(TeamMember).where(TeamMember.id == agent_id, TeamMember.type == "agent")
        )).scalar_one_or_none()
        if tm is None:
            raise HTTPException(status_code=404, detail="Agent not found")

        # acked_seq DB 조회
        cursor = (await db.execute(
            select(AgentEventCursor).where(AgentEventCursor.agent_id == agent_id)
        )).scalar_one_or_none()
        acked_seq: int = cursor.acked_seq if cursor else 0

        # 세션 등록
        session_rec = AgentGatewaySession(
            id=uuid.uuid4(),
            agent_id=agent_id,
            connected_at=datetime.now(timezone.utc),
            last_seen_at=datetime.now(timezone.utc),
        )
        db.add(session_rec)
        await db.commit()

    # Last-Event-ID 헤더 파싱 (gateway_seq)
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
        """gap-free ordered-at-least-once SSE 스트림.

        커서 전략: acked_seq(durable) 재스캔.
        - 매 wake마다 `gateway_seq > acked_seq` DB 재스캔 → 늦게 커밋된 낮은 seq도 반드시 잡힘.
        - wake_floor: 이번 wake 내 yield한 최대 seq (같은 wake 안 중복 방지용).
        - acked_seq는 클라이언트 POST /ack 로만 전진 — 서버가 자동 전진 안 함.
        - 클라이언트는 seq 기반 dedup(같은 seq 두 번 받아도 한 번 처리) 필수.
        """
        try:
            yield "event: heartbeat\ndata: {}\n\n"

            # 초기 백필 — acked_seq(=start_seq)부터 재스캔
            async with async_session_factory() as db:
                rows = await _fetch_events(db, agent_id, start_seq, _BACKFILL_LIMIT)

            backfill_floor = start_seq  # 이번 백필 내 중복 방지
            for row in rows:
                data = _row_to_payload(row)
                gseq = row.gateway_seq or 0
                if gseq > backfill_floor:  # 중복 방지
                    _sse = json.dumps({**data, "is_backfill": True})
                    yield f"event: {row.event_type}\nid: {gseq}\ndata: {_sse}\n\n"
                    backfill_floor = gseq

            # 실시간 — wake 신호 → acked_seq부터 DB 재스캔
            while not await request.is_disconnected():
                try:
                    signal = await asyncio.wait_for(queue.get(), timeout=_SSE_HEARTBEAT)
                    if signal.get("__wake__"):
                        # 최신 acked_seq 조회 (클라이언트가 ACK 보냈을 수 있음)
                        async with async_session_factory() as db:
                            cur = (await db.execute(
                                select(AgentEventCursor).where(AgentEventCursor.agent_id == agent_id)
                            )).scalar_one_or_none()
                            scan_from = max(start_seq, cur.acked_seq if cur else 0)
                            new_rows = await _fetch_events(db, agent_id, scan_from, _BACKFILL_LIMIT)

                        wake_floor = scan_from  # 이번 wake 내 중복 방지
                        for row in new_rows:
                            gseq = row.gateway_seq or 0
                            if gseq > wake_floor:
                                data = _row_to_payload(row)
                                _sse = json.dumps({**data, "is_backfill": False})
                                # AC2: 카논 이벤트명 only
                                yield f"event: {row.event_type}\nid: {gseq}\ndata: {_sse}\n\n"
                                wake_floor = gseq
                    else:
                        # 레거시 직접 push (AGENT_GATEWAY_V2 미적용 경로)
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


# ─── POST /api/v2/agent/events/ack ────────────────────────────────────────────

class AckRequest(BaseModel):
    seq: int


@router.post("/events/ack")
async def ack_event(
    body: AckRequest,
    db: AsyncSession = Depends(get_db),
    auth: AuthContext = Depends(get_current_user),
) -> dict:
    """에이전트가 처리 완료한 gateway_seq ACK — agent_event_cursors 갱신."""
    is_api_key = bool(auth.claims.get("app_metadata", {}).get("api_key_id"))
    if not is_api_key:
        raise HTTPException(status_code=403, detail="API key required")

    agent_id = uuid.UUID(auth.user_id)

    # UPSERT acked_seq (더 높은 값만 갱신)
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
