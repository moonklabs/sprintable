import uuid
from datetime import datetime

from sqlalchemy import func, select
from sqlalchemy.ext.asyncio import AsyncSession

from app.models.pm import Sprint, Story
from app.repositories.base import BaseRepository


class SprintRepository(BaseRepository[Sprint]):
    def __init__(self, session: AsyncSession, org_id: uuid.UUID) -> None:
        super().__init__(Sprint, session, org_id)

    async def list_in_projects(
        self,
        project_ids: list[uuid.UUID],
        *,
        status: str | None = None,
        limit: int | None = None,
        cursor: datetime | None = None,
    ) -> tuple[list[Sprint], int]:
        """story #2428 PR④(ⓐ) — list_sprints의 project_id 미지정(org-wide) 분기 전용.
        기존 코드는 `repo.list()`로 org 전체를 끌어온 뒤 Python에서 accessible project_id로
        post-filter했다(SEC-S8) — DB-level limit/cursor를 곧이곧대로 얹으면 그 post-filter가
        페이지 건수를 다시 줄여 X-Total-Count/has_more가 어긋난다(TaskRepository.
        list_in_projects()가 이미 겪은 것과 동형 함정, 거긴 Story JOIN이 필요했지만 Sprint는
        project_id 컬럼이 있어 직접 IN). cursor는 conds에 포함(count_q/q 공유) — story.py
        규약 그대로(#2537), 3157/base.py list_paginated() fix와 동일 모양."""
        if not project_ids:
            return [], 0
        conds = [self._org_filter(), Sprint.project_id.in_(project_ids)]
        if status is not None:
            conds.append(Sprint.status == status)
        if cursor is not None:
            conds.append(Sprint.created_at < cursor)

        count_q = select(func.count()).select_from(Sprint).where(*conds)
        total = int((await self.session.execute(count_q)).scalar_one() or 0)

        q = (
            select(Sprint).where(*conds)
            .order_by(Sprint.created_at.desc(), Sprint.id.desc())
            .limit(limit if limit is not None else 1000)
        )
        result = await self.session.execute(q)
        return list(result.scalars().all()), total

    async def activate(self, id: uuid.UUID) -> Sprint:
        sprint = await self.get(id)
        if sprint is None:
            raise ValueError(f"Sprint {id} not found")
        if sprint.status != "planning":
            raise ValueError(f"Cannot activate sprint with status: {sprint.status}")

        result = await self.session.execute(
            select(Sprint).where(
                Sprint.org_id == self.org_id,
                Sprint.project_id == sprint.project_id,
                Sprint.status == "active",
            )
        )
        if result.scalar_one_or_none() is not None:
            raise ValueError("Active sprint already exists for this project")

        updated = await self.update(id, status="active")
        assert updated is not None
        return updated

    async def close(self, id: uuid.UUID) -> Sprint:
        sprint = await self.get(id)
        if sprint is None:
            raise ValueError(f"Sprint {id} not found")
        # E-DG S26: review 선택 단계 도입 → active 또는 review 에서 마감 가능(review→done).
        if sprint.status not in ("active", "review"):
            raise ValueError(f"Cannot close sprint with status: {sprint.status}")

        all_result = await self.session.execute(
            select(Story).where(
                Story.sprint_id == id,
                Story.deleted_at.is_(None),
            )
        )
        all_stories = all_result.scalars().all()
        done_stories = [s for s in all_stories if s.status == "done"]
        velocity = sum(s.story_points or 0 for s in done_stories)

        # E-OUTCOME-LOOP S3: velocity 계산 직후 채점 (비파괴 — 기존 close 로직 무변경)
        from app.services.outcome_scorer import score_sprint_outcome
        backlog_remaining = len([s for s in all_stories if s.status != "done"])
        total_points = sum(s.story_points or 0 for s in all_stories)
        scoring = score_sprint_outcome(
            sprint.metric_definition, velocity, backlog_remaining, total_points
        )
        extra = scoring if scoring is not None else {}

        updated = await self.update(id, status="closed", velocity=velocity, **extra)
        assert updated is not None
        return updated
