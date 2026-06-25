"""OB-2: 에이전트 connection verify — 합성 이벤트를 실 SSE 라운드트립으로 확증 (블루프린트 §4).

`POST verify-connection` 이 ``onboarding.connection_test`` 합성 Event 를 만들어 **실 /agent/stream
경로**(우회 X·``assign_recipient_seq`` + ``wake_agent`` · single-target)로 보내고, `GET
verification-status` 가 ``acked_seq`` vs 그 seq + 세션 freshness 로 6단계 레일을 도출한다.

신규 테이블 없음 — 합성 Event(=record) + ``AgentEventCursor.acked_seq`` + ``AgentGatewaySession``
재사용. **ack/verified 는 ``acked_seq >= seq`` 권위 신호만**(낙관 0). ``event_delivered`` 는
reachable~ack 사이 active 로 표현한다 — 게이트웨이 ack-커서 모델상 per-event delivered 를 ack 와
별개로 durable 마킹하는 신호가 없고, /agent/stream 핫패스를 건드리지 않는다(AC4·PO 확정).
"""
from __future__ import annotations

import uuid
from datetime import datetime, timedelta, timezone

from sqlalchemy import desc, select
from sqlalchemy.ext.asyncio import AsyncSession

from app.models.agent_gateway import AgentEventCursor, AgentGatewaySession
from app.models.event import Event
from app.services.event_seq import assign_recipient_seq

VERIFY_EVENT_TYPE = "onboarding.connection_test"
# 6단계 canonical 레일(OB-3 1:1·OB-4 vocab 정합). config_copied 는 FE 권위(BE 는 waiting 부터 관측).
RAIL_STATES = ("config_copied", "waiting", "mcp_reachable", "event_delivered", "ack", "verified")


def build_verification_rail(
    *,
    verify_seq: int | None,
    acked_seq: int | None,
    has_fresh_session: bool,
) -> list[dict]:
    """6단계 레일 도출(순수). 각 ``{state, status: pending|active|done}``.

    - ``verify_seq is None``(verify 미시작) → 전 단계 pending.
    - ``acked_seq >= verify_seq``(권위) → waiting~verified 전부 done.
    - fresh session·미-ack → waiting/mcp_reachable done·event_delivered **active**·ack/verified pending.
    - 미-reachable·미-ack → waiting active·이후 pending.
    """
    if verify_seq is None:
        return [{"state": s, "status": "pending"} for s in RAIL_STATES]

    acked = acked_seq is not None and acked_seq >= verify_seq
    rail: list[dict] = [{"state": "config_copied", "status": "done"}]  # verify 시작=copy 선행 간주
    if acked:
        tail = [
            ("waiting", "done"), ("mcp_reachable", "done"),
            ("event_delivered", "done"), ("ack", "done"), ("verified", "done"),
        ]
    elif has_fresh_session:
        tail = [
            ("waiting", "done"), ("mcp_reachable", "done"),
            ("event_delivered", "active"), ("ack", "pending"), ("verified", "pending"),
        ]
    else:
        tail = [
            ("waiting", "active"), ("mcp_reachable", "pending"),
            ("event_delivered", "pending"), ("ack", "pending"), ("verified", "pending"),
        ]
    rail += [{"state": s, "status": st} for s, st in tail]
    return rail


async def start_verification(
    db: AsyncSession, *, agent_id: uuid.UUID, org_id: uuid.UUID, project_id: uuid.UUID
) -> int:
    """합성 connection_test Event INSERT + per-recipient seq 발급. 호출자가 commit + wake_agent.

    single-target(AC3): recipient = 해당 agent 1명만. fire_webhooks / org 브로드캐스트 미사용.
    """
    event = Event(
        project_id=project_id,
        org_id=org_id,
        event_type=VERIFY_EVENT_TYPE,
        source_entity_type="agent",
        source_entity_id=agent_id,
        sender_id=None,
        recipient_id=agent_id,
        recipient_type="agent",
        payload={"kind": "connection_test", "agent_id": str(agent_id)},
        status="pending",
    )
    db.add(event)
    await db.flush()
    return await assign_recipient_seq(db, event)


async def _has_fresh_session(db: AsyncSession, agent_id: uuid.UUID) -> bool:
    """에이전트가 현재 /agent/stream 연결 중인지(= mcp_reachable). 게이트웨이의 동일 freshness TTL 사용."""
    from app.routers.agent_gateway import _SESSION_FRESH_TTL  # lazy: 순환 import 회피

    cutoff = datetime.now(timezone.utc) - timedelta(seconds=_SESSION_FRESH_TTL)
    row = (await db.execute(
        select(AgentGatewaySession.id).where(
            AgentGatewaySession.agent_id == agent_id,
            AgentGatewaySession.last_seen_at >= cutoff,
        ).limit(1)
    )).first()
    return row is not None


async def get_verification_state(db: AsyncSession, agent_id: uuid.UUID) -> dict:
    """최신 verify Event seq + acked_seq + 세션 freshness → 레일/verified."""
    verify_seq = (await db.execute(
        select(Event.recipient_seq).where(
            Event.recipient_id == agent_id,
            Event.event_type == VERIFY_EVENT_TYPE,
            Event.recipient_seq.isnot(None),
        ).order_by(desc(Event.recipient_seq)).limit(1)
    )).scalar_one_or_none()

    acked_seq = (await db.execute(
        select(AgentEventCursor.acked_seq).where(AgentEventCursor.agent_id == agent_id)
    )).scalar_one_or_none()

    fresh = await _has_fresh_session(db, agent_id) if verify_seq is not None else False
    rail = build_verification_rail(
        verify_seq=verify_seq, acked_seq=acked_seq, has_fresh_session=fresh
    )
    verified = (
        verify_seq is not None and acked_seq is not None and acked_seq >= verify_seq
    )
    return {"verify_seq": verify_seq, "acked_seq": acked_seq, "verified": verified, "rail": rail}
