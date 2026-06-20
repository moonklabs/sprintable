from __future__ import annotations

import uuid
from datetime import datetime, timedelta, timezone

from sqlalchemy import case, func, select
from sqlalchemy.ext.asyncio import AsyncSession

from app.models.pm import Story
from app.repositories.base import BaseRepository
from app.schemas.story import STATUS_TRANSITIONS

_PRIORITY_ORDER = case(
    (Story.priority == "critical", 0),
    (Story.priority == "high", 1),
    (Story.priority == "medium", 2),
    (Story.priority == "low", 3),
    else_=4,
)


class StoryRepository(BaseRepository[Story]):
    def __init__(self, session: AsyncSession, org_id: uuid.UUID) -> None:
        super().__init__(Story, session, org_id)

    async def list_board(
        self,
        project_id: uuid.UUID,
        status: str,
        limit: int = 20,
        cursor: datetime | None = None,
        sprint_id: uuid.UUID | None = None,
        assignee_id: uuid.UUID | None = None,
        reporter_id: uuid.UUID | None = None,
    ) -> tuple[list[Story], int]:
        """CB-S4: 보드 상태별 쿼리 — created_at DESC + priority 보조 정렬 + cursor 페이징.

        done: 최근 7일 + limit 10 고정.
        """
        q = select(Story).where(
            self._org_filter(),
            Story.project_id == project_id,
            Story.status == status,
            Story.deleted_at.is_(None),
        )
        if sprint_id:
            q = q.where(Story.sprint_id == sprint_id)
        if assignee_id:
            q = q.where(Story.assignee_id == assignee_id)
        if reporter_id:  # 9f25e74a: '내가 등록한'(reporter) 서버필터 — 보드 done cursor 집합 기준.
            q = q.where(Story.reporter_id == reporter_id)

        # done: 최근 7일 제한
        if status == "done":
            cutoff = datetime.now(timezone.utc) - timedelta(days=7)
            q = q.where(Story.created_at >= cutoff)
            limit = min(limit, 10)

        # cursor 기반 페이징 (created_at < cursor)
        if cursor:
            q = q.where(Story.created_at < cursor)

        count_q = select(func.count()).select_from(q.subquery())
        total = (await self.session.execute(count_q)).scalar_one()

        q = q.order_by(Story.created_at.desc(), _PRIORITY_ORDER).limit(limit)
        stories = list((await self.session.execute(q)).scalars().all())
        return stories, total

    async def list_backlog(self, project_id: uuid.UUID, limit: int = 1000) -> list[Story]:
        """sprint 미배정 + 삭제되지 않은 스토리만 서버사이드 필터."""
        result = await self.session.execute(
            select(Story).where(
                self._org_filter(),
                Story.project_id == project_id,
                Story.sprint_id.is_(None),
                Story.deleted_at.is_(None),
            ).limit(limit)
        )
        return list(result.scalars().all())

    async def transition_status(self, id: uuid.UUID) -> Story:
        story = await self.get(id)
        if story is None:
            raise ValueError(f"Story {id} not found")
        next_status = STATUS_TRANSITIONS.get(story.status)
        if next_status is None:
            raise ValueError(f"No forward transition from status: {story.status}")
        updated = await self.update(id, status=next_status)
        assert updated is not None
        return updated

    async def set_status(
        self, id: uuid.UUID, new_status: str, violation_level: str = "block"
    ) -> Story:
        story = await self.get(id)
        if story is None:
            raise ValueError(f"Story {id} not found")

        from app.schemas.story import STORY_STATUSES
        if new_status not in STORY_STATUSES:
            raise ValueError(f"Invalid status: {new_status}")

        if new_status == story.status:
            return story

        current_idx = list(STORY_STATUSES).index(story.status)
        new_idx = list(STORY_STATUSES).index(new_status)
        if new_idx != current_idx + 1:
            # AC1: warn 모드이면 hard block 우회 → 전이 허용 (violation 이벤트는 caller에서 발행)
            if violation_level != "warn":
                raise ValueError(
                    f"Non-sequential transition not allowed: {story.status} → {new_status}"
                )

        updated = await self.update(id, status=new_status)
        assert updated is not None
        return updated
