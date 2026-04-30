from __future__ import annotations

import uuid
from datetime import datetime, timedelta, timezone

from sqlalchemy import func, select, text
from sqlalchemy.ext.asyncio import AsyncSession

from app.models.reward import RewardLedger
from app.models.team import TeamMember


class RewardRepository:
    def __init__(self, session: AsyncSession, org_id: uuid.UUID) -> None:
        self.session = session
        self.org_id = org_id

    async def list(self, project_id: uuid.UUID, member_id: uuid.UUID | None = None) -> list[RewardLedger]:
        q = select(RewardLedger).where(
            RewardLedger.org_id == self.org_id,
            RewardLedger.project_id == project_id,
        )
        if member_id is not None:
            q = q.where(RewardLedger.member_id == member_id)
        q = q.order_by(RewardLedger.created_at.desc())
        result = await self.session.execute(q)
        return list(result.scalars().all())

    async def get_balance(self, project_id: uuid.UUID, member_id: uuid.UUID) -> float:
        result = await self.session.execute(
            select(func.coalesce(func.sum(RewardLedger.amount), 0)).where(
                RewardLedger.org_id == self.org_id,
                RewardLedger.project_id == project_id,
                RewardLedger.member_id == member_id,
            )
        )
        return float(result.scalar_one())

    async def grant(
        self,
        project_id: uuid.UUID,
        member_id: uuid.UUID,
        amount: float,
        reason: str,
        granted_by: uuid.UUID,
        reference_type: str | None = None,
        reference_id: uuid.UUID | None = None,
    ) -> RewardLedger | None:
        member_check = await self.session.execute(
            select(TeamMember.id).where(
                TeamMember.id == member_id,
                TeamMember.project_id == project_id,
                TeamMember.org_id == self.org_id,
            )
        )
        if member_check.scalar_one_or_none() is None:
            return None

        entry = RewardLedger(
            org_id=self.org_id,
            project_id=project_id,
            member_id=member_id,
            amount=amount,
            reason=reason,
            granted_by=granted_by,
            reference_type=reference_type,
            reference_id=reference_id,
        )
        self.session.add(entry)
        await self.session.flush()
        await self.session.refresh(entry)
        return entry

    async def leaderboard(
        self,
        project_id: uuid.UUID,
        period: str = "all",
        limit: int = 50,
        cursor: str | None = None,
    ) -> list[dict]:
        limit = min(limit, 100)

        if period == "all":
            q = (
                "SELECT member_id, balance FROM reward_balances"
                " WHERE project_id = :pid"
            )
            params: dict = {"pid": str(project_id), "lim": limit}
            if cursor:
                q += " AND balance < :cursor"
                params["cursor"] = float(cursor)
            q += " ORDER BY balance DESC LIMIT :lim"
            result = await self.session.execute(text(q), params)
            return [{"member_id": r[0], "balance": float(r[1])} for r in result.all()]

        period_seconds = {"daily": 86400, "weekly": 7 * 86400, "monthly": 30 * 86400}
        seconds = period_seconds.get(period, 86400)
        params2: dict = {"pid": str(project_id), "seconds": seconds, "lim": limit}
        q2 = (
            "SELECT member_id, CAST(SUM(amount) AS float) AS balance FROM reward_ledger"
            " WHERE project_id = :pid"
            " AND created_at >= NOW() - (:seconds || ' seconds')::interval"
            " GROUP BY member_id ORDER BY balance DESC LIMIT :lim"
        )
        result2 = await self.session.execute(text(q2), params2)
        return [{"member_id": r[0], "balance": float(r[1])} for r in result2.all()]
