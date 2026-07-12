import uuid

from sqlalchemy import select
from sqlalchemy.ext.asyncio import AsyncSession

from app.models.pm import Story, Task
from app.repositories.base import BaseRepository


class TaskRepository(BaseRepository[Task]):
    def __init__(self, session: AsyncSession, org_id: uuid.UUID) -> None:
        super().__init__(Task, session, org_id)

    async def list_in_projects(
        self,
        project_ids: list[uuid.UUID],
        *,
        assignee_id: uuid.UUID | None = None,
        status: str | None = None,
        limit: int = 1000,
    ) -> list[Task]:
        """d3e5ca89(SEC fast-follow): org-wide task 조회를 caller 접근권 project 집합으로
        result-level 스코프. Task엔 project_id 컬럼이 없어(story_id NN) Story JOIN으로 project를
        환원한다. project_ids가 비면(접근권 0개) 빈 리스트 — org 전체 task title/assignee_id/
        status가 새던 result-level 누출을 봉인. assignee_id/status는 추가 narrowing 필터."""
        if not project_ids:
            return []
        q = (
            select(Task)
            .join(Story, Story.id == Task.story_id)
            .where(
                self._org_filter(),
                Task.deleted_at.is_(None),
                Story.project_id.in_(project_ids),
            )
        )
        if assignee_id is not None:
            q = q.where(Task.assignee_id == assignee_id)
        if status is not None:
            q = q.where(Task.status == status)
        result = await self.session.execute(q.limit(limit))
        return list(result.scalars().all())
