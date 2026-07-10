"""에픽 관련 MCP 도구 (3개) — E-SECURITY SEC-S1 확장: delete_epic 제거(에이전트 hard-delete 차단,
delete_story와 동형 조치. 까심 적대적 QA 발견 갭 — cascade로 소속 stories까지 물리삭제)."""
from __future__ import annotations

from mcp.types import TextContent

from ..api_client import client
from ..response import err, ok
from ..schemas import EpicStatus, SprintableInput, StoryPriority


class ListEpicsInput(SprintableInput):
    pass


class AddEpicInput(SprintableInput):
    title: str
    priority: StoryPriority | None = None
    description: str | None = None
    objective: str | None = None
    success_criteria: str | None = None
    target_sp: int | None = None
    target_date: str | None = None


class UpdateEpicInput(SprintableInput):
    epic_id: str
    title: str | None = None
    status: EpicStatus | None = None
    priority: StoryPriority | None = None
    description: str | None = None
    objective: str | None = None
    success_criteria: str | None = None
    target_sp: int | None = None
    target_date: str | None = None


async def list_epics(args: ListEpicsInput) -> list[TextContent]:
    """에픽 목록 조회."""
    try:
        return ok(await client.get("/api/v2/epics", params={"project_id": client.project_id}))
    except Exception as exc:
        return err(str(exc))


async def add_epic(args: AddEpicInput) -> list[TextContent]:
    """에픽 생성."""
    body: dict = {"title": args.title, "project_id": client.project_id}
    if args.priority:
        body["priority"] = args.priority.value
    for field in ("description", "objective", "success_criteria", "target_date"):
        val = getattr(args, field)
        if val is not None:
            body[field] = val
    if args.target_sp is not None:
        body["target_sp"] = args.target_sp
    try:
        return ok(await client.post("/api/v2/epics", json=body))
    except Exception as exc:
        return err(str(exc))


async def update_epic(args: UpdateEpicInput) -> list[TextContent]:
    """에픽 수정."""
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
        return ok(await client.patch(f"/api/v2/epics/{args.epic_id}", json=updates))
    except Exception as exc:
        return err(str(exc))
