import uuid

from sqlalchemy import delete, select
from sqlalchemy.ext.asyncio import AsyncSession

from app.models.story_assignee import StoryAssignee
from app.repositories.base import BaseRepository


class StoryAssigneeRepository(BaseRepository[StoryAssignee]):
    """E-BOARD S5: 복수 assignee join. participation 패턴과 동형 — Story에 relationship을
    걸지 않고 명시적 쿼리로 읽어 async lazy-load(MissingGreenlet) 트랩을 회피한다."""

    def __init__(self, session: AsyncSession, org_id: uuid.UUID) -> None:
        super().__init__(StoryAssignee, session, org_id)

    async def list_member_ids(self, story_id: uuid.UUID) -> list[uuid.UUID]:
        result = await self.session.execute(
            select(StoryAssignee.member_id)
            .where(
                StoryAssignee.org_id == self.org_id,
                StoryAssignee.story_id == story_id,
            )
            .order_by(StoryAssignee.created_at)
        )
        return list(result.scalars().all())

    async def map_member_ids(
        self, story_ids: list[uuid.UUID]
    ) -> dict[uuid.UUID, list[uuid.UUID]]:
        """여러 스토리의 assignee member_id를 한 쿼리로 모아 N+1 회피."""
        if not story_ids:
            return {}
        result = await self.session.execute(
            select(StoryAssignee.story_id, StoryAssignee.member_id)
            .where(
                StoryAssignee.org_id == self.org_id,
                StoryAssignee.story_id.in_(story_ids),
            )
            .order_by(StoryAssignee.created_at)
        )
        out: dict[uuid.UUID, list[uuid.UUID]] = {}
        for sid, mid in result.all():
            out.setdefault(sid, []).append(mid)
        return out

    async def set_for_story(self, story_id: uuid.UUID, member_ids: list[uuid.UUID]) -> list[uuid.UUID]:
        """replace 방식 — 기존 행 전체 삭제 후 신규 삽입 (멱등). 삽입 순서(=member_ids) 보존.
        반환: 실제 저장된 dedup 멤버 목록."""
        await self.session.execute(
            delete(StoryAssignee).where(
                StoryAssignee.org_id == self.org_id,
                StoryAssignee.story_id == story_id,
            )
        )
        saved: list[uuid.UUID] = []
        seen: set[uuid.UUID] = set()
        for mid in member_ids:
            if mid in seen:
                continue
            seen.add(mid)
            saved.append(mid)
            self.session.add(
                StoryAssignee(org_id=self.org_id, story_id=story_id, member_id=mid)
            )
        await self.session.flush()
        return saved

    async def delete_by_story(self, story_id: uuid.UUID) -> None:
        await self.session.execute(
            delete(StoryAssignee).where(
                StoryAssignee.org_id == self.org_id,
                StoryAssignee.story_id == story_id,
            )
        )
        await self.session.flush()
