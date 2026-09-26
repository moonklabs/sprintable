"""story #2268(E-CONNECT) — dashboard.py의 my_stories/my_tasks 쿼리를 재사용 가능한
서비스 함수로 뽑는다(재구현 0). session_context_core.py가 이 함수를 그대로 불러 쓴다 —
member 존재/활성 검증·project_id 해석 로직을 두 번째로 다시 짜지 않는다.

⛔dashboard.py의 원 로직·주석(prod 핫픽스 cross-org 차단 근거)은 그대로 옮겼다 — 동작 변경 0.
"""
from __future__ import annotations

import uuid
from collections.abc import Collection

from sqlalchemy import select
from sqlalchemy.ext.asyncio import AsyncSession

from app.models.pm import Story, Task
from app.models.team import TeamMember
from app.schemas.dashboard import StoryItem, TaskItem


class MemberNotFoundError(ValueError):
    """member_id가 caller org 소속 활성 멤버가 아님 — 호출 라우터가 404로 번역한다."""


async def get_my_work(
    session: AsyncSession, *, org_id: uuid.UUID, member_id: uuid.UUID, project_id: uuid.UUID | None,
    accessible_project_ids: Collection[uuid.UUID],
) -> tuple[list[StoryItem], list[TaskItem]]:
    """dashboard.get_dashboard와 동일 쿼리(cross-org 차단 검증 포함). project_id=None이면
    member의 소속 project로 해석한다(dashboard.py 원 로직 그대로).

    story #4350 — `accessible_project_ids`는 **부르는 사람**(caller)이 접근 가능한 프로젝트. 다른 구성원(member_id)의 일을 볼 수는
    있지만(PO 확인 — 프로젝트 협업 시야) caller가 접근 못 하는 프로젝트의 스토리 · 과제는 싣지 않는다(SEC-S8 선생님 확정). 과제는
    project_id가 없어 소속 스토리의 project로 거른다."""
    member_check = await session.execute(
        select(TeamMember.project_id).where(
            TeamMember.id == member_id, TeamMember.org_id == org_id, TeamMember.is_active.is_(True)
        ).limit(1)
    )
    member_project_id = member_check.scalar_one_or_none()
    if member_project_id is None:
        raise MemberNotFoundError(f"member {member_id} not found or inactive in org {org_id}")
    if project_id is None:
        project_id = member_project_id

    allowed = list(accessible_project_ids)
    stories_r = await session.execute(
        select(Story.id, Story.title, Story.status, Story.story_points).where(
            Story.project_id == project_id,
            Story.project_id.in_(allowed),
            Story.assignee_id == member_id,
            Story.status != "done",
            Story.deleted_at.is_(None),
        )
    )
    story_rows = stories_r.all()

    tasks_r = await session.execute(
        select(Task.id, Task.title, Task.status)
        .join(Story, Story.id == Task.story_id)
        .where(
            Story.project_id.in_(allowed),
            Task.assignee_id == member_id,
            Task.status != "done",
            Task.deleted_at.is_(None),
        )
    )
    task_rows = tasks_r.all()

    return (
        [StoryItem(id=r[0], title=r[1], status=r[2], story_points=r[3]) for r in story_rows],
        [TaskItem(id=r[0], title=r[1], status=r[2]) for r in task_rows],
    )
