"""스토리 관련 MCP 도구."""
from __future__ import annotations

from mcp.types import TextContent

from ..api_client import client
from ..response import err, ok
from ..schemas import SprintableInput, StoryPriority, StoryStatus


class ListStoriesInput(SprintableInput):
    """list_stories 입력 스키마.

    project_id/org_id는 context에서 자동 주입.
    Optional 필드는 MCP schema required에서 제외.
    """

    sprint_id: str | None = None
    epic_id: str | None = None
    status: StoryStatus | None = None
    priority: StoryPriority | None = None
    assignee_id: str | None = None


async def list_stories(args: ListStoriesInput) -> list[TextContent]:
    """프로젝트의 스토리 목록 조회."""
    params: dict = {"project_id": client.project_id}
    if client.org_id:
        params["org_id"] = client.org_id
    if args.sprint_id:
        params["sprint_id"] = args.sprint_id
    if args.epic_id:
        params["epic_id"] = args.epic_id
    if args.status:
        params["status"] = args.status.value
    if args.priority:
        params["priority"] = args.priority.value
    if args.assignee_id:
        params["assignee_id"] = args.assignee_id

    try:
        data = await client.get("/api/v2/stories", params=params)
        return ok(data)
    except Exception as exc:
        return err(str(exc))
