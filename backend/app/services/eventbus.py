"""E-EVENTBUS S4: 메모 → 이벤트버스 연동 헬퍼.

EVENTBUS_ENABLED=true 환경에서만 활성화. 기존 웹훅 디스패치와 완전 병행.
"""
from __future__ import annotations

import uuid
from datetime import datetime, timezone

from sqlalchemy import select
from sqlalchemy.ext.asyncio import AsyncSession

from app.core.config import settings
from app.models.event import Event
from app.models.team import TeamMember
from app.routers.events import _event_to_payload, _push_to_agent


async def dispatch_memo_event(
    db: AsyncSession,
    *,
    org_id: uuid.UUID,
    project_id: uuid.UUID,
    event_type: str,
    source_entity_id: uuid.UUID,
    sender_id: uuid.UUID | None,
    recipient_ids: list[uuid.UUID],
    payload: dict,
) -> None:
    """메모 이벤트를 이벤트버스에 발행한다.

    EVENTBUS_ENABLED=false면 즉시 반환 (prod 환경).
    recipient_ids 중 team_members에 존재하는 대상만 처리.
    """
    if not settings.eventbus_enabled:
        return

    if not recipient_ids:
        return

    try:
        result = await db.execute(
            select(TeamMember.id, TeamMember.type).where(
                TeamMember.id.in_(recipient_ids),
                TeamMember.org_id == org_id,
            )
        )
        members = result.all()
        if not members:
            return

        now = datetime.now(timezone.utc)
        dispatches: list[tuple[Event, str, uuid.UUID]] = []  # (event, member_type, member_id)
        for member_id, member_type in members:
            event = Event(
                id=uuid.uuid4(),
                org_id=org_id,
                project_id=project_id,
                event_type=event_type,
                source_entity_type="memo",
                source_entity_id=source_entity_id,
                sender_id=sender_id,
                recipient_id=member_id,
                recipient_type=member_type,
                payload=payload,
                status="pending",
                created_at=now,
            )
            dispatches.append((event, member_type, member_id))
            db.add(event)

        await db.flush()

        # SSE 라우팅: 연결 중인 에이전트에게 즉시 enqueue (delivered 마킹은 SSE yield 후 처리)
        for event, member_type, member_id in dispatches:
            if member_type == "agent":
                _push_to_agent(str(member_id), _event_to_payload(event))

    except Exception:
        pass
