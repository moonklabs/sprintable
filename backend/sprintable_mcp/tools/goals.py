"""목표(구 에픽) 관련 MCP 도구 (3개) — E-SECURITY SEC-S1 확장: delete_goal 제거(에이전트
hard-delete 차단, delete_story와 동형 조치. 까심 적대적 QA 발견 갭 — cascade로 소속 stories까지
물리삭제).

계층 리네이밍 B1(story 1925): 구 tools/epics.py — REST 호출 대상을 신 경로(/api/v2/goals)로
전환. tool 이름 자체는 server.py의 _TOOL_DEFS가 신(sprintable_*_goal)+구(sprintable_*_epic)
양쪽으로 별칭 등록(같은 함수 재사용, 로직 복제 0) — hierarchy-rename-alias-mechanism-design §1.
"""
from __future__ import annotations

from mcp.types import TextContent
from pydantic import AliasChoices, ConfigDict, Field

from ..api_client import client
from ..response import err, ok
from ..schemas import GoalStatus, SprintableInput, StoryPriority


class ListGoalsInput(SprintableInput):
    pass


class AddGoalInput(SprintableInput):
    title: str
    priority: StoryPriority | None = None
    description: str | None = None
    objective: str | None = None
    success_criteria: str | None = None
    target_sp: int | None = None
    target_date: str | None = None


class UpdateGoalInput(SprintableInput):
    # ⚠️deprecated 별칭(sprintable_update_epic)도 같은 스키마 재사용 — 구 필드명 epic_id도
    # 계속 받아야 무중단(hierarchy-rename-alias-mechanism-design §1/§3 동형).
    model_config = ConfigDict(extra="ignore", populate_by_name=True)
    goal_id: str = Field(validation_alias=AliasChoices("goal_id", "epic_id"))
    title: str | None = None
    status: GoalStatus | None = None
    priority: StoryPriority | None = None
    description: str | None = None
    objective: str | None = None
    success_criteria: str | None = None
    target_sp: int | None = None
    target_date: str | None = None


async def list_goals(args: ListGoalsInput) -> list[TextContent]:
    """목표 목록 조회."""
    try:
        return ok(await client.get("/api/v2/goals", params={"project_id": client.require_project_id()}))
    except Exception as exc:
        return err(str(exc))


async def add_goal(args: AddGoalInput) -> list[TextContent]:
    """목표 생성."""
    try:
        body: dict = {"title": args.title, "project_id": client.require_project_id()}
        if args.priority:
            body["priority"] = args.priority.value
        for field in ("description", "objective", "success_criteria", "target_date"):
            val = getattr(args, field)
            if val is not None:
                body[field] = val
        if args.target_sp is not None:
            body["target_sp"] = args.target_sp
        return ok(await client.post("/api/v2/goals", json=body))
    except Exception as exc:
        return err(str(exc))


async def update_goal(args: UpdateGoalInput) -> list[TextContent]:
    """목표 수정."""
    updates: dict = {}
    if args.title is not None:
        updates["title"] = args.title
    if args.status is not None:
        updates["status"] = args.status.value
    if args.priority is not None:
        updates["priority"] = args.priority.value
    for field in ("description", "objective", "success_criteria", "target_date"):
        val = getattr(args, field)
        if val is not None:
            updates[field] = val
    if args.target_sp is not None:
        updates["target_sp"] = args.target_sp
    try:
        return ok(await client.patch(f"/api/v2/goals/{args.goal_id}", json=updates))
    except Exception as exc:
        return err(str(exc))
