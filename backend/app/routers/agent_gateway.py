"""E-AGENT-GATEWAY Phase 0: per-recipient dense seq ê¸°ë° SSE ì¤í¸ë¦¼ + ACK.

ì´ì¤ì ë¬ fix: per-recipient dense commit-ordered seq (recipient_seq).
start_seq = max(acked_seq DB, Last-Event-ID í¤ë)
backfill = live-tail = ëì¼ ì¿¼ë¦¬ â ê²¹ì¹¨ 0.
"""
from __future__ import annotations

import asyncio
import json
import logging
import os
import uuid
from datetime import datetime, timedelta, timezone

from fastapi import APIRouter, Depends, HTTPException, Query, Request
from fastapi.responses import StreamingResponse
from pydantic import BaseModel
from sqlalchemy import delete, select, text, update
from sqlalchemy.ext.asyncio import AsyncSession

from app.dependencies.auth import AuthContext, get_current_user, get_current_user_streaming
from app.core.database import async_session_factory
from app.dependencies.database import get_db
from app.models.agent_gateway import AgentEventCursor, AgentGatewaySession
from app.models.event import Event
from app.models.organization import Organization
from app.models.team import TeamMember
from app.routers.events import _agent_connections, _event_to_payload

logger = logging.getLogger(__name__)

router = APIRouter(prefix="/api/v2/agent", tags=["agent-gateway"])

_SSE_HEARTBEAT: float = float(os.getenv("SSE_HEARTBEAT_TIMEOUT", "30"))
_BACKFILL_LIMIT: int = int(os.getenv("AGENT_GATEWAY_BACKFILL_LIMIT", "100"))

# 49fed0a1 P1: presence를 실제 SSE 연결에 배선 — online/offline 진실화.
# SSE dial-out 에이전트(Hermes 등)는 MCP heartbeat를 호출하지 않으므로 연결 lifecycle에서
# presence(last_seen_at/agent_status)를 직접 갱신해야 "연결 중 online·끊으면 offline"이 진실해진다.
# - 연결 유지 중 최소 갱신 주기(초). wake 빈발로 timeout heartbeat가 안 떠도 last_seen이 stale되지 않게
#   매 loop iteration에서 경과 체크 후 throttle write(에이전트당 최대 1회/주기).
_PRESENCE_TICK_INTERVAL: float = _SSE_HEARTBEAT
# - AgentGatewaySession이 "활성"으로 간주되는 last_seen 무갱신 허용 시간(초). 주기 갱신(_PRESENCE_TICK_INTERVAL)
#   대비 여유(3×)를 둬 정상 연결이 잠깐 느려도 stale 오판하지 않게. 인스턴스 크래시로 finally 미실행된
#   좀비 세션은 이 TTL 밖이 되어 disconnect cleanup의 "잔여 활성 세션" 판정에서 제외된다(멀티인스턴스 정합).
_SESSION_FRESH_TTL: float = _SSE_HEARTBEAT * 3


async def _mark_agent_online(agent_id: uuid.UUID, session_id: uuid.UUID) -> None:
    """49fed0a1 AC1/AC2: SSE 연결 중 presence online 갱신.

    AgentGatewaySession.last_seen_at(연결 추적·멀티인스턴스 queryable) + 프로필 presence
    (last_seen_at/agent_status — team_members 뷰가 agent_project_profiles서 읽음)를 함께 NOW로 갱신.
    long-lived 스트림은 get_db 커넥션을 idle-hold 하면 안 되므로 독립 세션 사용. best-effort
    (presence 갱신 실패가 스트림을 끊지 않도록 예외 삼킴·로깅).
    """
    now = datetime.now(timezone.utc)
    try:
        async with async_session_factory() as db:
            await db.execute(
                update(AgentGatewaySession)
                .where(AgentGatewaySession.id == session_id)
                .values(last_seen_at=now)
            )
            from app.services.agent_anchor_sync import sync_agent_profile_presence
            await sync_agent_profile_presence(
                db, agent_id, last_seen_at=now, agent_status="online"
            )
            await db.commit()
    except Exception:
        logger.warning("presence online tick failed agent=%s", agent_id, exc_info=True)


async def _mark_agent_disconnected(agent_id: uuid.UUID, session_id: uuid.UUID) -> None:
    """49fed0a1 AC2/AC3: SSE 연결 종료 cleanup — 연결-도출 offline 강등.

    이 세션 행 삭제 후, 같은 에이전트의 **다른 활성(last_seen TTL 이내) 세션**이 없으면 presence를
    offline로 강등. 같은 API Key의 멀티세션(멀티인스턴스 Cloud Run)은 한 presence 그룹이므로
    **마지막 연결이 끊길 때만** offline (AC2). last_seen_at=None → presence_status 즉시 offline
    (schema 단락). MCP heartbeat·재연결 시 online 복귀(self-heal). finally 호출이라 예외 비전파.
    """
    now = datetime.now(timezone.utc)
    fresh_cutoff = now - timedelta(seconds=_SESSION_FRESH_TTL)
    try:
        async with async_session_factory() as db:
            # 이 세션 + 같은 에이전트의 좀비 세션(크래시로 finally 미실행 → last_seen stale) 정리.
            # 멀티인스턴스서 테이블 무한증식 방지 + 아래 "잔여 활성" 판정을 신뢰 가능하게.
            await db.execute(
                delete(AgentGatewaySession).where(
                    (AgentGatewaySession.id == session_id)
                    | (
                        (AgentGatewaySession.agent_id == agent_id)
                        & (AgentGatewaySession.last_seen_at < fresh_cutoff)
                    )
                )
            )
            remaining = (await db.execute(
                select(AgentGatewaySession.id).where(
                    AgentGatewaySession.agent_id == agent_id,
                    AgentGatewaySession.last_seen_at >= fresh_cutoff,
                ).limit(1)
            )).scalar_one_or_none()
            if remaining is None:
                from app.services.agent_anchor_sync import sync_agent_profile_presence
                await sync_agent_profile_presence(
                    db, agent_id, last_seen_at=None, agent_status="offline"
                )
                # d5de8e08 안전망: 연결 완전 종료 → 이 에이전트의 chat working 신호도 즉시 정리
                # (offline 인데 "...typing" 잔존 방지·TTL backstop 기다리지 않음).
                from app.services import chat_presence
                chat_presence.clear_member(str(agent_id))
            await db.commit()
    except Exception:
        logger.warning("presence disconnect cleanup failed agent=%s", agent_id, exc_info=True)

# E-INFRA S4: /agent/stream 전역 연결 cap (legacy /events/stream S20 미러).
# 무제한 agent stream 연결이 인스턴스 메모리/큐(=connection당 Queue maxsize=200)를 고갈시키는 것 방지.
# ⚠️ legacy /events/stream(_MAX_SSE_CONNECTIONS)과 **별도 카운터** — 두 엔드포인트는 클라이언트
#   특성(agent API key·장수명 dial-out vs 휴먼 브라우저 SSE)과 수명이 달라 독립 튜닝이 적절하고,
#   legacy /events/stream은 폐기 수순이라 카운터 통합 시 잘못된 상호 제약이 생긴다. → 분리 유지.
_MAX_AGENT_SSE_CONNECTIONS: int = int(os.getenv("MAX_AGENT_SSE_CONNECTIONS", "100"))
_agent_sse_connection_count: int = 0

# E-INFRA S5: per-API-key(=agent) 동시 스트림 제한 (tier-aware, abuse/fair-use).
# 한 키가 무제한 스트림을 열어 메모리/큐를 독점하는 것 방지. per-key 카운트 = _agent_connections[agent_id] size.
# ⚠️ tier 출처: agent 키는 sk_live_(ApiKey 모델)라 dependencies/rate_limit._resolve_tier
#   (pk_live_/ProjectApiKey 전용)에 안 맞는다. agent의 올바른 tier 출처는 **org.plan**(free/team/pro)
#   이므로 그것으로 tier 해소(TIER_LIMITS 패턴·429+Retry-After 응답 shape 재사용).
_AGENT_STREAM_TIER_LIMITS: dict[str, int] = {
    "free": int(os.getenv("AGENT_STREAM_LIMIT_FREE", "3")),
    "team": int(os.getenv("AGENT_STREAM_LIMIT_TEAM", "15")),
    "pro": int(os.getenv("AGENT_STREAM_LIMIT_PRO", "30")),
}
_AGENT_STREAM_DEFAULT_LIMIT: int = int(os.getenv("AGENT_STREAM_LIMIT_DEFAULT", "3"))
_AGENT_STREAM_RETRY_AFTER: int = int(os.getenv("AGENT_STREAM_RETRY_AFTER", "5"))

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
                e.created_at,
                e.project_id::text    AS project_id,
                e.org_id::text        AS org_id,
                c.title               AS conversation_title
            FROM events e
            -- d0bca260: conversation_title 도출. payload.conversation_id가 uuid 형태일 때만 join
            -- (비-대화 이벤트는 NULL → 안전). 36자 uuid 패턴 가드로 ::uuid 캐스트 에러 0.
            LEFT JOIN conversations c
                ON e.payload->>'conversation_id' ~ '^[0-9a-fA-F-]{36}$'
               AND c.id = (e.payload->>'conversation_id')::uuid
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
        # d0bca260: BYOA 어댑터 컨텍스트 — project_id·org_id·conversation_title top-level(additive).
        # Event는 project_id·org_id 보유(미직렬화였음)·title은 conversations join. BYOA 온보딩 매끄러움.
        "project_id": getattr(row, "project_id", None),
        "org_id": getattr(row, "org_id", None),
        "conversation_title": getattr(row, "conversation_title", None),
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

        # E-INFRA S5: tier(=org.plan) 해소 — per-key 동시 스트림 cap 산정용 (free<paid)
        org_plan = (await db.execute(
            select(Organization.plan).where(Organization.id == tm.org_id)
        )).scalar_one_or_none() or "free"

        # acked_seq DB ì¡°í
        cursor = (await db.execute(
            select(AgentEventCursor).where(AgentEventCursor.agent_id == agent_id)
        )).scalar_one_or_none()
        acked_seq: int = cursor.acked_seq if cursor else 0

        # ì¸ì ë±ë¡
        # 49fed0a1: 세션 등록 + presence online은 cap 체크 통과 후 generate() 내부에서 수행
        # (거부된 429/503 연결이 세션 행/presence를 남기지 않도록 — setup/teardown을 스트림 lifecycle에 대칭).

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

    # E-INFRA S5: per-key(agent) 동시 스트림 제한 (tier-aware) — 초과 시 429 + Retry-After.
    # per-key 카운트 = _agent_connections[agent_id] (현재 동시 스트림 수). 새 연결은 아직 미등록 상태이므로
    # >= limit 이면 이번 연결이 (limit+1)번째 → 거부. global cap(503)보다 먼저 검사(키 단위 quota가 우선 신호).
    _per_key_limit = _AGENT_STREAM_TIER_LIMITS.get(org_plan, _AGENT_STREAM_DEFAULT_LIMIT)
    if len(_agent_connections[agent_id_str]) >= _per_key_limit:
        raise HTTPException(
            status_code=429,
            detail={
                "code": "AGENT_STREAM_LIMITED",
                "message": f"Concurrent agent stream limit ({_per_key_limit}) reached for this key",
                "retry_after": _AGENT_STREAM_RETRY_AFTER,
            },
            headers={"Retry-After": str(_AGENT_STREAM_RETRY_AFTER)},
        )

    # E-INFRA S4: 전역 agent stream 연결 cap — 초과 시 503 (legacy events.py:234-237 미러).
    # 증가 직후 진입하는 generate()의 finally에서 반드시 decrement (disconnect/GeneratorExit 누수 방지).
    global _agent_sse_connection_count
    if _agent_sse_connection_count >= _MAX_AGENT_SSE_CONNECTIONS:
        raise HTTPException(status_code=503, detail="Agent stream connection limit reached")
    _agent_sse_connection_count += 1

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
        session_id = uuid.uuid4()
        _presence_wired = False
        try:
            # 49fed0a1 AC1: cap 통과 후 세션 등록 + presence online. SSE dial-out 에이전트는 MCP
            # heartbeat를 호출하지 않아 이 배선이 없으면 붙어 일해도 offline(거짓)이었다. 독립 세션 사용
            # (long-lived 스트림이 get_db 커넥션을 idle-hold 하지 않도록).
            async with async_session_factory() as _pdb:
                _pdb.add(AgentGatewaySession(
                    id=session_id,
                    agent_id=agent_id,
                    connected_at=datetime.now(timezone.utc),
                    last_seen_at=datetime.now(timezone.utc),
                ))
                from app.services.agent_anchor_sync import sync_agent_profile_presence
                await sync_agent_profile_presence(
                    _pdb, agent_id, last_seen_at=datetime.now(timezone.utc), agent_status="online"
                )
                await _pdb.commit()
            _presence_wired = True

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
            # 49fed0a1 AC1: 연결 유지 중 presence를 주기적으로 online 갱신. wake가 잦으면 timeout
            # heartbeat가 안 떠도(매번 wait_for가 일찍 반환) last_seen이 stale → 거짓 offline 되므로,
            # 매 iteration 경과를 체크해 _PRESENCE_TICK_INTERVAL마다 throttle write(busy/idle 무관 갱신 보장).
            last_presence_tick = datetime.now(timezone.utc)
            while not await request.is_disconnected():
                _now = datetime.now(timezone.utc)
                if (_now - last_presence_tick).total_seconds() >= _PRESENCE_TICK_INTERVAL:
                    await _mark_agent_online(agent_id, session_id)
                    last_presence_tick = _now
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
            # E-INFRA S4: 연결 cap decrement (legacy events.py:380-381 미러) — 항상 실행.
            global _agent_sse_connection_count
            _agent_sse_connection_count -= 1
            _agent_connections[agent_id_str].discard(queue)
            if not _agent_connections[agent_id_str]:
                _agent_connections.pop(agent_id_str, None)
            # 49fed0a1 AC2/AC3: 연결 종료 → 세션 행 삭제 + 마지막 세션이면 presence offline 강등.
            # (presence 배선 성공한 연결만 — 세션 미생성 시 타 세션 presence 오염 방지.)
            if _presence_wired:
                await _mark_agent_disconnected(agent_id, session_id)

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
