"""분석 관련 MCP 도구 (11개)."""
from __future__ import annotations

from mcp.types import TextContent

from ..api_client import client
from ..response import err, ok
from ..schemas import SprintableInput


class MemberIdInput(SprintableInput):
    member_id: str


class WorkloadInput(SprintableInput):
    member_id: str


class SprintFilterInput(SprintableInput):
    sprint_id: str | None = None


class OverdueMemberInput(SprintableInput):
    member_id: str | None = None


class ActivityInput(SprintableInput):
    limit: int | None = None


class EpicProgressInput(SprintableInput):
    epic_id: str


class AgentStatsInput(SprintableInput):
    agent_id: str


class SearchStoriesInput(SprintableInput):
    query: str


async def get_project_overview(args: SprintableInput) -> list[TextContent]:
    """프로젝트 개요 통계 조회."""
    try:
        return ok(await client.get("/api/v2/analytics/overview", params={"project_id": client.project_id}))
    except Exception as exc:
        return err(str(exc))


async def get_member_workload(args: WorkloadInput) -> list[TextContent]:
    """팀원 워크로드 조회."""
    try:
        return ok(await client.get("/api/v2/analytics/workload", params={"project_id": client.project_id, "member_id": args.member_id}))
    except Exception as exc:
        return err(str(exc))


async def get_sprint_velocity_history(args: SprintableInput) -> list[TextContent]:
    """스프린트 벨로시티 히스토리 조회."""
    try:
        return ok(await client.get("/api/v2/analytics/velocity-history", params={"project_id": client.project_id}))
    except Exception as exc:
        return err(str(exc))


async def search_stories(args: SearchStoriesInput) -> list[TextContent]:
    """스토리 제목 검색."""
    try:
        return ok(await client.get("/api/v2/stories", params={"project_id": client.project_id, "q": args.query}))
    except Exception as exc:
        return err(str(exc))


async def get_blocked_stories(args: SprintFilterInput) -> list[TextContent]:
    """in-review 상태 스토리 목록 (블로킹 스토리)."""
    params: dict = {"project_id": client.project_id, "status": "in-review"}
    if args.sprint_id:
        params["sprint_id"] = args.sprint_id
    try:
        return ok(await client.get("/api/v2/stories", params=params))
    except Exception as exc:
        return err(str(exc))


async def get_unassigned_stories(args: SprintFilterInput) -> list[TextContent]:
    """담당자 미지정 스토리 목록."""
    params: dict = {"project_id": client.project_id, "unassigned": "true"}
    if args.sprint_id:
        params["sprint_id"] = args.sprint_id
    try:
        return ok(await client.get("/api/v2/stories", params=params))
    except Exception as exc:
        return err(str(exc))


async def get_overdue_tasks(args: OverdueMemberInput) -> list[TextContent]:
    """미완료 태스크 목록."""
    params: dict = {"project_id": client.project_id, "status_ne": "done"}
    if args.member_id:
        params["assignee_id"] = args.member_id
    try:
        return ok(await client.get("/api/v2/tasks", params=params))
    except Exception as exc:
        return err(str(exc))


async def get_recent_activity(args: ActivityInput) -> list[TextContent]:
    """최근 프로젝트 활동 조회."""
    params: dict = {"project_id": client.project_id}
    if args.limit is not None:
        params["limit"] = str(args.limit)
    try:
        return ok(await client.get("/api/v2/analytics/activity", params=params))
    except Exception as exc:
        return err(str(exc))


async def get_epic_progress(args: EpicProgressInput) -> list[TextContent]:
    """에픽 진행 현황 조회."""
    try:
        return ok(await client.get("/api/v2/analytics/epic-progress", params={"project_id": client.project_id, "epic_id": args.epic_id}))
    except Exception as exc:
        return err(str(exc))


async def get_agent_stats(args: AgentStatsInput) -> list[TextContent]:
    """에이전트 성과 통계 조회."""
    try:
        return ok(await client.get("/api/v2/analytics/agent-stats", params={"project_id": client.project_id, "agent_id": args.agent_id}))
    except Exception as exc:
        return err(str(exc))


async def get_project_health(args: SprintableInput) -> list[TextContent]:
    """프로젝트 전체 건강도 조회."""
    try:
        return ok(await client.get("/api/v2/analytics/health", params={"project_id": client.project_id}))
    except Exception as exc:
        return err(str(exc))
