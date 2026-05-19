"""스토리 관련 MCP 도구 (8개)."""
from __future__ import annotations

from mcp.types import CallToolResult, TextContent

from ..api_client import client
from ..response import err, ok
from ..schemas import SprintableInput, StoryPoints, StoryPriority, StoryStatus


class ListStoriesInput(SprintableInput):
    sprint_id: str | None = None
    epic_id: str | None = None
    status: StoryStatus | None = None
    priority: StoryPriority | None = None
    assignee_id: str | None = None


class AddStoryInput(SprintableInput):
    title: str
    epic_id: str | None = None
    sprint_id: str | None = None
    assignee_id: str | None = None
    priority: StoryPriority | None = None
    story_points: StoryPoints | None = None
    description: str | None = None
    acceptance_criteria: str | None = None


class UpdateStoryInput(SprintableInput):
    story_id: str
    title: str | None = None
    priority: StoryPriority | None = None
    story_points: StoryPoints | None = None
    description: str | None = None
    acceptance_criteria: str | None = None
    assignee_id: str | None = None
    epic_id: str | None = None


class DeleteStoryInput(SprintableInput):
    story_id: str


class AssignStoryToSprintInput(SprintableInput):
    story_id: str
    sprint_id: str


class UnassignStoryFromSprintInput(SprintableInput):
    story_id: str


class UpdateStoryStatusInput(SprintableInput):
    story_id: str
    status: StoryStatus


async def list_stories(args: ListStoriesInput) -> list[TextContent]:
    """프로젝트 스토리 목록 조회."""
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
        return ok(await client.get("/api/v2/stories", params=params))
    except Exception as exc:
        return err(str(exc))


async def list_backlog(args: SprintableInput) -> list[TextContent]:
    """백로그 스토리 목록 (스프린트 미배정)."""
    try:
        return ok(await client.get("/api/v2/stories/backlog", params={"project_id": client.project_id}))
    except Exception as exc:
        return err(str(exc))


async def add_story(args: AddStoryInput) -> list[TextContent]:
    """스토리 생성."""
    body: dict = {"title": args.title, "project_id": client.project_id}
    if args.epic_id:
        body["epic_id"] = args.epic_id
    if args.sprint_id:
        body["sprint_id"] = args.sprint_id
    if args.assignee_id:
        body["assignee_id"] = args.assignee_id
    if args.priority:
        body["priority"] = args.priority.value
    if args.story_points:
        body["story_points"] = args.story_points.value
    if args.description:
        body["description"] = args.description
    if args.acceptance_criteria:
        body["acceptance_criteria"] = args.acceptance_criteria
    try:
        return ok(await client.post("/api/v2/stories", json=body))
    except Exception as exc:
        return err(str(exc))


async def update_story(args: UpdateStoryInput) -> list[TextContent]:
    """스토리 수정."""
    updates: dict = {}
    if args.title is not None:
        updates["title"] = args.title
    if args.priority is not None:
        updates["priority"] = args.priority.value
    if args.story_points is not None:
        updates["story_points"] = args.story_points.value
    if args.description is not None:
        updates["description"] = args.description
    if args.acceptance_criteria is not None:
        updates["acceptance_criteria"] = args.acceptance_criteria
    if args.assignee_id is not None:
        updates["assignee_id"] = args.assignee_id
    if args.epic_id is not None:
        updates["epic_id"] = args.epic_id
    try:
        return ok(await client.patch(f"/api/v2/stories/{args.story_id}", json=updates))
    except Exception as exc:
        return err(str(exc))


async def delete_story(args: DeleteStoryInput) -> list[TextContent]:
    """스토리 삭제."""
    try:
        await client.delete(f"/api/v2/stories/{args.story_id}")
        return ok({"deleted": True})
    except Exception as exc:
        return err(str(exc))


async def assign_story_to_sprint(args: AssignStoryToSprintInput) -> list[TextContent]:
    """스토리를 스프린트에 배정."""
    try:
        return ok(await client.patch(f"/api/v2/stories/{args.story_id}", json={"sprint_id": args.sprint_id}))
    except Exception as exc:
        return err(str(exc))


async def unassign_story_from_sprint(args: UnassignStoryFromSprintInput) -> list[TextContent]:
    """스토리를 스프린트에서 제거."""
    try:
        return ok(await client.patch(f"/api/v2/stories/{args.story_id}", json={"sprint_id": None}))
    except Exception as exc:
        return err(str(exc))


async def update_story_status(args: UpdateStoryStatusInput) -> list[TextContent] | CallToolResult:
    """스토리 상태 변경."""
    try:
        return ok(await client.patch(f"/api/v2/stories/{args.story_id}/status", json={"status": args.status.value}))
    except Exception as exc:
        return err(str(exc))
