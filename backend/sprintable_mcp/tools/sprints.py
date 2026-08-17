"""스프린트 관련 MCP 도구 (7개) — E-SECURITY SEC-S8 확장: delete_sprint 제거(에이전트
hard-delete 차단, delete_story와 동형 조치. 까심 적대적 QA 발견 갭)."""
from __future__ import annotations

from mcp.types import TextContent

from ..api_client import client
from ..response import err, ok, ok_paginated
from ..schemas import SprintStatus, SprintableInput
from .stories import _has_more_from_headers


class ListSprintsInput(SprintableInput):
    status: SprintStatus | None = None
    limit: int | None = None
    cursor: str | None = None  # 이전 호출의 X-Next-Cursor 헤더 값을 그대로 넘기면 다음 페이지.


class SprintIdInput(SprintableInput):
    sprint_id: str


class CreateSprintInput(SprintableInput):
    title: str
    start_date: str | None = None
    end_date: str | None = None
    team_size: int | None = None


class UpdateSprintInput(SprintableInput):
    sprint_id: str
    title: str | None = None
    start_date: str | None = None
    end_date: str | None = None
    team_size: int | None = None


async def list_sprints(args: ListSprintsInput) -> list[TextContent]:
    """스프린트 목록 조회."""
    try:
        params: dict = {"project_id": client.require_project_id()}
        if args.status:
            params["status"] = args.status.value
        if args.limit:
            params["limit"] = args.limit
        if args.cursor:
            params["cursor"] = args.cursor
        items, headers = await client.get_with_headers("/api/v2/sprints", params=params)
        has_more, next_cursor = _has_more_from_headers(headers, items)
        return ok_paginated(items, has_more=has_more, next_cursor=next_cursor, tool_name="sprintable_list_sprints")
    except Exception as exc:
        return err(str(exc))


async def sprint_summary(args: SprintIdInput) -> list[TextContent]:
    """스프린트 스토리 상태별 요약."""
    try:
        return ok(await client.get(f"/api/v2/sprints/{args.sprint_id}/summary"))
    except Exception as exc:
        return err(str(exc))


async def activate_sprint(args: SprintIdInput) -> list[TextContent]:
    """스프린트 활성화 (planning → active)."""
    try:
        return ok(await client.post(f"/api/v2/sprints/{args.sprint_id}/activate"))
    except Exception as exc:
        return err(str(exc))


async def close_sprint(args: SprintIdInput) -> list[TextContent]:
    """스프린트 종료 (active → closed)."""
    try:
        return ok(await client.post(f"/api/v2/sprints/{args.sprint_id}/close"))
    except Exception as exc:
        return err(str(exc))


async def get_velocity(args: SprintIdInput) -> list[TextContent]:
    """스프린트 벨로시티 조회."""
    try:
        return ok(await client.get(f"/api/v2/sprints/{args.sprint_id}/velocity"))
    except Exception as exc:
        return err(str(exc))


async def create_sprint(args: CreateSprintInput) -> list[TextContent]:
    """스프린트 생성."""
    try:
        body: dict = {"title": args.title, "project_id": client.require_project_id()}
        if args.start_date:
            body["start_date"] = args.start_date
        if args.end_date:
            body["end_date"] = args.end_date
        if args.team_size is not None:
            body["team_size"] = args.team_size
        return ok(await client.post("/api/v2/sprints", json=body))
    except Exception as exc:
        return err(str(exc))


async def update_sprint(args: UpdateSprintInput) -> list[TextContent]:
    """스프린트 수정."""
    updates: dict = {}
    if args.title is not None:
        updates["title"] = args.title
    if args.start_date is not None:
        updates["start_date"] = args.start_date
    if args.end_date is not None:
        updates["end_date"] = args.end_date
    if args.team_size is not None:
        updates["team_size"] = args.team_size
    try:
        return ok(await client.patch(f"/api/v2/sprints/{args.sprint_id}", json=updates))
    except Exception as exc:
        return err(str(exc))
