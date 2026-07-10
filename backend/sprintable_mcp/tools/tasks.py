"""태스크 관련 MCP 도구 (6개) — E-SECURITY SEC-S1 확장: delete_task 제거(에이전트 hard-delete 차단,
delete_story와 동형 조치. 까심 적대적 QA 발견 갭)."""
from __future__ import annotations

from mcp.types import TextContent

from ..api_client import client
from ..response import err, ok
from ..schemas import SprintableInput, TaskStatus


class ListTasksInput(SprintableInput):
    story_id: str | None = None
    assignee_id: str | None = None
    status: TaskStatus | None = None


class ListMyTasksInput(SprintableInput):
    assignee_id: str | None = None


class GetTaskInput(SprintableInput):
    task_id: str


class AddTaskInput(SprintableInput):
    story_id: str
    title: str
    assignee_id: str | None = None
    story_points: int | None = None
    status: TaskStatus | None = None


class UpdateTaskInput(SprintableInput):
    task_id: str
    title: str | None = None
    assignee_id: str | None = None
    story_points: int | None = None


class UpdateTaskStatusInput(SprintableInput):
    task_id: str
    status: TaskStatus


async def list_tasks(args: ListTasksInput) -> list[TextContent]:
    """태스크 목록 조회."""
    params: dict = {"project_id": client.project_id}
    if args.story_id:
        params["story_id"] = args.story_id
    if args.assignee_id:
        params["assignee_id"] = args.assignee_id
    if args.status:
        params["status"] = args.status.value
    try:
        return ok(await client.get("/api/v2/tasks", params=params))
    except Exception as exc:
        return err(str(exc))


async def list_my_tasks(args: ListMyTasksInput) -> list[TextContent]:
    """내 태스크 목록 조회."""
    assignee = args.assignee_id or client.member_id
    params: dict = {"assignee_id": assignee, "project_id": client.project_id}
    try:
        return ok(await client.get("/api/v2/tasks", params=params))
    except Exception as exc:
        return err(str(exc))


async def get_task(args: GetTaskInput) -> list[TextContent]:
    """태스크 단건 조회."""
    try:
        return ok(await client.get(f"/api/v2/tasks/{args.task_id}"))
    except Exception as exc:
        return err(str(exc))


async def add_task(args: AddTaskInput) -> list[TextContent]:
    """태스크 생성."""
    body: dict = {"story_id": args.story_id, "title": args.title}
    if args.assignee_id:
        body["assignee_id"] = args.assignee_id
    if args.story_points is not None:
        body["story_points"] = args.story_points
    if args.status:
        body["status"] = args.status.value
    try:
        return ok(await client.post("/api/v2/tasks", json=body))
    except Exception as exc:
        return err(str(exc))


async def update_task(args: UpdateTaskInput) -> list[TextContent]:
    """태스크 수정."""
    updates: dict = {}
    if args.title is not None:
        updates["title"] = args.title
    if args.assignee_id is not None:
        updates["assignee_id"] = args.assignee_id
    if args.story_points is not None:
        updates["story_points"] = args.story_points
    try:
        return ok(await client.patch(f"/api/v2/tasks/{args.task_id}", json=updates))
    except Exception as exc:
        return err(str(exc))


async def update_task_status(args: UpdateTaskStatusInput) -> list[TextContent]:
    """태스크 상태 변경."""
    try:
        return ok(await client.patch(f"/api/v2/tasks/{args.task_id}", json={"status": args.status.value}))
    except Exception as exc:
        return err(str(exc))
