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
    """프로젝트 팀 멤버 목록 조회. story #2428 ⓑ: limit 없음(의도) — 팀 로스터 크기가
    자연 상한(standup_missing과 동형 축, 페드루 확定 2026-08-17)."""
    try:
        params: dict = {"project_id": client.require_project_id()}
        return ok(await client.get("/api/v2/members", params=params))
    except Exception as exc:
        return err(str(exc))


async def my_dashboard(args: DashboardInput) -> list[TextContent]:
    """팀원 대시보드 요약 조회."""
    try:
        member = args.member_id or client.member_id
        params: dict = {"member_id": member, "project_id": client.require_project_id()}
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
    """운영 가이드 텍스트 반환(에이전트 system prompt 자가-pull용) — story #2793(2790 P2)
    respec. 구 `/api/v2/workflow-recipes`(recipes[0] 임의 선택 결함)를 완전히 대체하고
    `/api/v2/events/onboarding-guide`(story #2792 P1의 stage_metadata가 실 데이터 소스)
    단일 호출로 교체 — "0번째" 개념 자체가 없다."""
    try:
        return ok(await client.get("/api/v2/events/onboarding-guide"))
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
