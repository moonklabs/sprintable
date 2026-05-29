"""스탠드업 + 레트로 유틸리티 MCP 도구 (8개)."""
from __future__ import annotations

from mcp.types import TextContent

from ..api_client import client
from ..response import err, ok
from ..schemas import SprintableInput


class StandupDateInput(SprintableInput):
    date: str


class StandupHistoryInput(SprintableInput):
    limit: int | None = None


class GetStandupInput(SprintableInput):
    member_id: str
    date: str


class SaveStandupInput(SprintableInput):
    author_id: str
    date: str
    done: str | None = None
    plan: str | None = None
    blockers: str | None = None


class ListStandupEntriesInput(SprintableInput):
    date: str


class GetRetroSessionInput(SprintableInput):
    sprint_id: str
    org_id: str | None = None
    initiator_id: str | None = None


class UpdateRetroActionStatusInput(SprintableInput):
    action_id: str
    status: str  # open | done


class CheckinSprintInput(SprintableInput):
    sprint_id: str
    date: str


async def standup_missing(args: StandupDateInput) -> list[TextContent]:
    """스탠드업 미제출 멤버 조회."""
    try:
        return ok(await client.get("/api/v2/standups/missing", params={"project_id": client.project_id, "date": args.date}))
    except Exception as exc:
        return err(str(exc))


async def standup_history(args: StandupHistoryInput) -> list[TextContent]:
    """최근 스탠드업 히스토리 조회."""
    params: dict = {"project_id": client.project_id}
    if args.limit is not None:
        params["limit"] = str(args.limit)
    try:
        return ok(await client.get("/api/v2/standups/history", params=params))
    except Exception as exc:
        return err(str(exc))


async def get_standup(args: GetStandupInput) -> list[TextContent]:
    """멤버+날짜 기준 스탠드업 조회."""
    # standups.py:34 author_id 파라미터 (MCP 입력은 member_id → author_id 매핑)
    params: dict = {"author_id": args.member_id, "date": args.date, "project_id": client.project_id}
    try:
        return ok(await client.get("/api/v2/standups", params=params))
    except Exception as exc:
        return err(str(exc))


async def save_standup(args: SaveStandupInput) -> list[TextContent]:
    """스탠드업 저장/업데이트."""
    body: dict = {"author_id": args.author_id, "date": args.date, "project_id": client.project_id}
    for field in ("done", "plan", "blockers"):
        val = getattr(args, field)
        if val is not None:
            body[field] = val
    try:
        return ok(await client.post("/api/v2/standups", json=body))
    except Exception as exc:
        return err(str(exc))


async def list_standup_entries(args: ListStandupEntriesInput) -> list[TextContent]:
    """날짜 기준 스탠드업 목록 조회."""
    try:
        return ok(await client.get("/api/v2/standups", params={"project_id": client.project_id, "date": args.date}))
    except Exception as exc:
        return err(str(exc))


async def get_retro_session(args: GetRetroSessionInput) -> list[TextContent]:
    """스프린트 레트로 세션 조회 (없으면 생성)."""
    params: dict = {"project_id": client.project_id}
    if args.org_id:
        params["org_id"] = args.org_id
    if args.initiator_id:
        params["initiator_id"] = args.initiator_id
    try:
        return ok(await client.get(f"/api/v2/retro/{args.sprint_id}", params=params))
    except Exception as exc:
        return err(str(exc))


async def update_retro_action_status(args: UpdateRetroActionStatusInput) -> list[TextContent]:
    """레트로 액션 아이템 상태 변경 (open|done)."""
    try:
        return ok(await client.patch(f"/api/v2/retro/actions/{args.action_id}", json={"status": args.status}))
    except Exception as exc:
        return err(str(exc))


async def checkin_sprint(args: CheckinSprintInput) -> list[TextContent]:
    """스프린트 체크인 — 진행률 + 스탠드업 미제출 현황."""
    try:
        return ok(await client.get(f"/api/v2/sprints/{args.sprint_id}/checkin", params={"date": args.date}))
    except Exception as exc:
        return err(str(exc))
