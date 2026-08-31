"""story #3261 AC5 — 비용 상한(org/일·org/세션, 어드민 가변값). 초과 시 정직한 지연 안내
+사람 에스컬레이션 — Blueprint §4.3 원칙: "조용한 품질 강등 금지"(예: 캡 넘었다고 몰래
Pro→Flash-Lite로 바꿔 응대 품질을 낮추는 것 자체가 금지 대상. 캡을 넘으면 즉시 멈추고
정직하게 알린다, 아무 일 없었다는 듯 계속 응대하지 않는다)."""
from __future__ import annotations

import uuid
from dataclasses import dataclass
from datetime import datetime, timezone

from sqlalchemy import select
from sqlalchemy.ext.asyncio import AsyncSession

from app.config import settings
from app.models import SupportMessage

HONEST_DELAY_MESSAGE = (
    "지금 이 조직의 오늘 자동 응대 한도에 도달했습니다. 잠시 후 다시 시도해 주시거나, "
    "지금 바로 담당자에게 연결해 드릴 수 있습니다."
)


@dataclass(frozen=True)
class CostCapStatus:
    exceeded: bool
    scope: str | None  # 'daily' | 'session' | None


async def _sum_cost(db: AsyncSession, *, org_id: uuid.UUID, conversation_id: uuid.UUID | None, since: datetime) -> float:
    query = select(SupportMessage.cost_usd).where(
        SupportMessage.org_id == org_id,
        SupportMessage.created_at >= since,
        SupportMessage.cost_usd.is_not(None),
    )
    if conversation_id is not None:
        query = query.where(SupportMessage.conversation_id == conversation_id)
    rows = (await db.execute(query)).scalars().all()
    return sum(r for r in rows if r is not None)


async def check_cost_cap(db: AsyncSession, *, org_id: uuid.UUID, conversation_id: uuid.UUID) -> CostCapStatus:
    """호출부(app/interaction.py)가 모델을 부르기 *직전*에 확인한다 — 캡을 이미 넘긴 뒤에
    한 번 더 부르고 나서야 판정하면 캡의 의미가 없다(선제 차단)."""
    today_start = datetime.now(timezone.utc).replace(hour=0, minute=0, second=0, microsecond=0)

    session_total = await _sum_cost(db, org_id=org_id, conversation_id=conversation_id, since=today_start)
    if session_total >= settings.cost_cap_org_session_usd:
        return CostCapStatus(exceeded=True, scope="session")

    daily_total = await _sum_cost(db, org_id=org_id, conversation_id=None, since=today_start)
    if daily_total >= settings.cost_cap_org_daily_usd:
        return CostCapStatus(exceeded=True, scope="daily")

    return CostCapStatus(exceeded=False, scope=None)
