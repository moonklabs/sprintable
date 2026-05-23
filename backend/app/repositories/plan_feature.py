from __future__ import annotations

from sqlalchemy import select
from sqlalchemy.ext.asyncio import AsyncSession

from app.models.plan_feature import PlanFeature


class PlanFeatureRepository:
    def __init__(self, session: AsyncSession) -> None:
        self.session = session

    async def list_all(self) -> list[PlanFeature]:
        result = await self.session.execute(
            select(PlanFeature).order_by(PlanFeature.tier, PlanFeature.code)
        )
        return list(result.scalars().all())

    async def list_by_tier(self, tier: str) -> list[PlanFeature]:
        result = await self.session.execute(
            select(PlanFeature)
            .where(PlanFeature.tier == tier)
            .order_by(PlanFeature.code)
        )
        return list(result.scalars().all())
