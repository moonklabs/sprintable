"""태스크 관련 MCP 도구 (6개) — E-SECURITY SEC-S1 확장: delete_task 제거(에이전트 hard-delete 차단,
delete_story와 동형 조치. 까심 적대적 QA 발견 갭)."""
from __future__ import annotations

from mcp.types import TextContent

from ..api_client import client
from ..response import err, ok, ok_paginated
from ..schemas import SprintableInput, TaskStatus
from .stories import _has_more_from_headers


class ListTasksInput(SprintableInput):
    story_id: str | None = None
    assignee_id: str | None = None
    status: TaskStatus | None = None
    limit: int | None = None
    cursor: str | None = None  # 이전 호출의 X-Next-Cursor 헤더 값을 그대로 넘기면 다음 페이지.


class ListMyTasksInput(SprintableInput):
    assignee_id: str | None = None
    limit: int | None = None
    cursor: str | None = None


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
    try:
        params: dict = {"project_id": client.require_project_id()}
        if args.story_id:
            params["story_id"] = args.story_id
        if args.assignee_id:
            params["assignee_id"] = args.assignee_id
        if args.status:
            params["status"] = args.status.value
        if args.limit:
            params["limit"] = args.limit
        if args.cursor:
            params["cursor"] = args.cursor
        items, headers = await client.get_with_headers("/api/v2/tasks", params=params)
        has_more, next_cursor = _has_more_from_headers(headers, items)
        return ok_paginated(items, has_more=has_more, next_cursor=next_cursor, tool_name="sprintable_list_tasks")
    except Exception as exc:
        return err(str(exc))


async def list_my_tasks(args: ListMyTasksInput) -> list[TextContent]:
    """내 태스크 목록 조회."""
    try:
        assignee = args.assignee_id or client.member_id
        params: dict = {"assignee_id": assignee, "project_id": client.require_project_id()}
        if args.limit:
            params["limit"] = args.limit
        if args.cursor:
            params["cursor"] = args.cursor
        items, headers = await client.get_with_headers("/api/v2/tasks", params=params)
        has_more, next_cursor = _has_more_from_headers(headers, items)
        return ok_paginated(items, has_more=has_more, next_cursor=next_cursor, tool_name="sprintable_list_my_tasks")
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
