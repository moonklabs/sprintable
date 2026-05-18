"""코어 유틸리티 MCP 도구 (2개)."""
from __future__ import annotations

from mcp.types import TextContent

from ..api_client import client
from ..response import err, ok
from ..schemas import SprintableInput


class DashboardInput(SprintableInput):
    member_id: str | None = None


async def list_team_members(args: SprintableInput) -> list[TextContent]:
    """프로젝트 팀 멤버 목록 조회."""
    params: dict = {"project_id": client.project_id}
    try:
        return ok(await client.get("/api/v2/members", params=params))
    except Exception as exc:
        return err(str(exc))


async def my_dashboard(args: DashboardInput) -> list[TextContent]:
    """팀원 대시보드 요약 조회."""
    member = args.member_id or client.member_id
    params: dict = {"member_id": member, "project_id": client.project_id}
    try:
        return ok(await client.get("/api/v2/dashboard", params=params))
    except Exception as exc:
        return err(str(exc))
