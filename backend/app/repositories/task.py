import uuid
from datetime import datetime

from sqlalchemy import func, select
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
        status_ne: str | None = None,
        limit: int | None = None,
        cursor: datetime | None = None,
    ) -> tuple[list[Task], int]:
        """d3e5ca89(SEC fast-follow): org-wide task 조회를 caller 접근권 project 집합으로
        result-level 스코프. Task엔 project_id 컬럼이 없어(story_id NN) Story JOIN으로 project를
        환원한다. project_ids가 비면(접근권 0개) 빈 리스트 — org 전체 task title/assignee_id/
        status가 새던 result-level 누출을 봉인. assignee_id/status는 추가 narrowing 필터.

        story #2428 PR③(⓪tasks ⓐ, 라이브 실측 667건): (tasks, total)로 확장 —
        story.py::list()가 세운 규약(#2537 docstring: "count는 필터 適用 後·limit 適用 前
        계산 — cursor 필터까지 포함해야 「이 필터 조건에서 남은 전체 건수」가 정확하다")
        그대로(새 규약 발명 0). ⚠️페드루 AC 리뷰(2026-08-17) 지적 — 최초 구현은 cursor를
        count_q 앞에 안 넣어 2페이지째부터 total이 «cursor 이전 포함 grand total»로
        고정돼 마지막 페이지에서도 has_more=True가 영구 참이 되는 결함이었다(BaseRepository.
        list_paginated()의 "페이지 무관 grand total" 시맨틱을 무심코 따라간 것 — 이 메서드는
        JOIN이 있어 그 범용 메서드를 안 쓰므로 story.py 규약을 직접 재현해야 했다). cursor를
        conds에 포함시켜 count_q/q 둘 다 같은 조건을 보게 고쳤다.

        status_ne: get_overdue_tasks MCP 도구가 이미 `status_ne=done`을 보내고 있었으나
        (sprintable_mcp/tools/analytics.py) 이 라우터가 그 파라미터를 아예 안 받아 FastAPI가
        조용히 버렸다(완료 포함 전체가 나가던 기존 결함 — 이번 PR로 실제 배선)."""
        if not project_ids:
            return [], 0
        conds = [
            self._org_filter(),
            Task.deleted_at.is_(None),
            Story.project_id.in_(project_ids),
        ]
        if assignee_id is not None:
            conds.append(Task.assignee_id == assignee_id)
        if status is not None:
            conds.append(Task.status == status)
        if status_ne is not None:
            conds.append(Task.status != status_ne)
        if cursor is not None:
            conds.append(Task.created_at < cursor)

        count_q = select(func.count()).select_from(Task).join(Story, Story.id == Task.story_id).where(*conds)
        total = int((await self.session.execute(count_q)).scalar_one() or 0)

        q = (
            select(Task)
            .join(Story, Story.id == Task.story_id)
            .where(*conds)
            .order_by(Task.created_at.desc(), Task.id.desc())
            .limit(limit if limit is not None else 1000)
        )
        result = await self.session.execute(q)
        return list(result.scalars().all()), total
