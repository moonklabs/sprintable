"""코어 유틸리티 MCP 도구 (4개)."""
from __future__ import annotations

from mcp.types import TextContent

from ..api_client import client
from ..response import err, ok
from ..schemas import SprintableInput


class DashboardInput(SprintableInput):
    member_id: str | None = None


class ClaimStoryInput(SprintableInput):
    story_id: str


class LockFilesInput(SprintableInput):
    file_paths: list[str]
    story_id: str | None = None


class UnlockFilesInput(SprintableInput):
    file_paths: list[str]


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


async def claim_story(args: ClaimStoryInput) -> list[TextContent]:
    """현재 작업 중인 스토리를 claim — active_story_id 갱신."""
    if not client.member_id:
        return err("member_id not resolved")
    try:
        result = await client.post(
            f"/api/v2/team-members/{client.member_id}/claim",
            json={"story_id": args.story_id},
        )
        return ok(result)
    except Exception as exc:
        return err(str(exc))


async def lock_files(args: LockFilesInput) -> list[TextContent]:
    """파일 작업 시작 선언 — 동시 수정 충돌 경고 반환."""
    if not client.member_id:
        return err("member_id not resolved")
    try:
        body: dict = {"file_paths": args.file_paths}
        if args.story_id:
            body["story_id"] = args.story_id
        result = await client.post(
            f"/api/v2/team-members/{client.member_id}/file-lock",
            json=body,
        )
        return ok(result)
    except Exception as exc:
        return err(str(exc))


async def unlock_files(args: UnlockFilesInput) -> list[TextContent]:
    """파일 작업 완료 선언 — lock 해제."""
    if not client.member_id:
        return err("member_id not resolved")
    try:
        result = await client.post(
            f"/api/v2/team-members/{client.member_id}/file-unlock",
            json={"file_paths": args.file_paths},
        )
        return ok(result)
    except Exception as exc:
        return err(str(exc))


async def get_workflow_guide(args: SprintableInput) -> list[TextContent]:
    """현재 프로젝트 워크플로우 가이드 텍스트 반환 (에이전트 system prompt 주입용)."""
    try:
        recipes = await client.get(
            "/api/v2/workflow-recipes",
            params={"project_id": client.project_id},
        )
        if not recipes:
            return ok({"guide": "등록된 워크플로우 레시피가 없습니다.", "recipes": []})
        first = recipes[0]
        recipe_id = first.get("id") or first.get("slug")
        guide_data = await client.get(f"/api/v2/workflow-recipes/{recipe_id}/guide")
        return ok(guide_data)
    except Exception as exc:
        return err(str(exc))


async def unclaim_story(args: SprintableInput) -> list[TextContent]:
    """작업 중인 스토리 claim 해제 — active_story_id = NULL."""
    if not client.member_id:
        return err("member_id not resolved")
    try:
        result = await client.post(
            f"/api/v2/team-members/{client.member_id}/unclaim",
            json={},
        )
        return ok(result)
    except Exception as exc:
        return err(str(exc))
