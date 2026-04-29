import uuid
from datetime import date
from typing import Any

from sqlalchemy import select
from sqlalchemy.ext.asyncio import AsyncSession

from app.models.standup import StandupEntry, StandupFeedback
from app.models.team import TeamMember
from app.repositories.base import BaseRepository


class StandupEntryRepository(BaseRepository[StandupEntry]):
    def __init__(self, session: AsyncSession, org_id: uuid.UUID) -> None:
        super().__init__(StandupEntry, session, org_id)

    async def upsert(self, **data: Any) -> StandupEntry:
        """UNIQUE(project_id, author_id, date) 기반 upsert."""
        existing = await self.session.execute(
            select(StandupEntry).where(
                self._org_filter(),
                StandupEntry.project_id == data["project_id"],
                StandupEntry.author_id == data["author_id"],
                StandupEntry.date == data["date"],
            )
        )
        entry = existing.scalar_one_or_none()
        if entry is not None:
            update_data = {k: v for k, v in data.items() if k not in ("project_id", "author_id", "date")}
            updated = await self.update(entry.id, **update_data)
            assert updated is not None
            return updated
        return await self.create(**data)

    async def get_missing(self, project_id: uuid.UUID, target_date: date) -> list[uuid.UUID]:
        """해당 날짜에 스탠드업을 제출하지 않은 활성 팀 멤버 ID 목록."""
        submitted = await self.session.execute(
            select(StandupEntry.author_id).where(
                self._org_filter(),
                StandupEntry.project_id == project_id,
                StandupEntry.date == target_date,
            )
        )
        submitted_ids = {row[0] for row in submitted.all()}

        all_members = await self.session.execute(
            select(TeamMember.id).where(
                TeamMember.project_id == project_id,
                TeamMember.is_active.is_(True),
                TeamMember.type == "human",
            )
        )
        all_ids = {row[0] for row in all_members.all()}
        return list(all_ids - submitted_ids)


class StandupFeedbackRepository(BaseRepository[StandupFeedback]):
    def __init__(self, session: AsyncSession, org_id: uuid.UUID) -> None:
        super().__init__(StandupFeedback, session, org_id)
