"""스탠드업 + 레트로 유틸리티 MCP 도구 (8개)."""
from __future__ import annotations

from mcp.types import TextContent
from pydantic import Field

from ..api_client import client
from ..response import err, ok
from ..schemas import SprintableInput


class StandupDateInput(SprintableInput):
    date: str


class StandupHistoryInput(SprintableInput):
    limit: int | None = None
    # story #2412 AC3 — 예전엔 여기 없는 `days`를 보내도(SprintableInput.extra="ignore" +
    # FastMCP 내부 arg_model 둘 다 관대) 조용히 무시됐다(AC2 lockdown 후로는 애초에 미선언 인자가
    # 전부 거부되지만, "최근 N일"은 실제 수요라 진짜 필드로 만든다). BE `/standups/history`의
    # date>=오늘-(days-1) 필터로 전달(제출 시각이 아니라 스탠드업 실제 날짜 기준). ge=1 —
    # BE(`Query(..., ge=1)`)와 경계를 맞춘다. 안 맞추면 days=0/음수가 MCP는 조용히 통과하고
    # BE에서만 422로 막혀, 호출자에게 raw HTTP 에러 문자열이 그대로 새 나간다(올리베이라군
    # 지적 — 배포 뒤 반드시 볼 것 ②).
    days: int | None = Field(default=None, ge=1)


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
    title: str | None = None  # 새로 만들어야 할 때만 쓰임(생략 시 서버가 "{스프린트} 회고")


class UpdateRetroActionStatusInput(SprintableInput):
    session_id: str  # story #2281 AC2 — 실제 서버 경로가 세션 id를 요구해 추가(누락이 원 결함)
    action_id: str
    status: str  # open | done


class CheckinSprintInput(SprintableInput):
    sprint_id: str
    date: str


async def standup_missing(args: StandupDateInput) -> list[TextContent]:
    """스탠드업 미제출 멤버 조회."""
    try:
        return ok(await client.get("/api/v2/standups/missing", params={"project_id": client.require_project_id(), "date": args.date}))
    except Exception as exc:
        return err(str(exc))


async def standup_history(args: StandupHistoryInput) -> list[TextContent]:
    """최근 스탠드업 히스토리 조회."""
    try:
        params: dict = {"project_id": client.require_project_id()}
        if args.limit is not None:
            params["limit"] = str(args.limit)
        if args.days is not None:
            params["days"] = str(args.days)
        return ok(await client.get("/api/v2/standups/history", params=params))
    except Exception as exc:
        return err(str(exc))


async def get_standup(args: GetStandupInput) -> list[TextContent]:
    """멤버+날짜 기준 스탠드업 조회."""
    try:
        # standups.py:34 author_id 파라미터 (MCP 입력은 member_id → author_id 매핑)
        params: dict = {"author_id": args.member_id, "date": args.date, "project_id": client.require_project_id()}
        return ok(await client.get("/api/v2/standups", params=params))
    except Exception as exc:
        return err(str(exc))


async def save_standup(args: SaveStandupInput) -> list[TextContent]:
    """스탠드업 저장/업데이트.

    1c2be9db: org-level 기본 — project_id를 강제 주입하지 않는다(이전엔 project-level
    행을 강제). project_id 생략 → BE 가 org-level 엔트리 1건으로 upsert 하고 작성자 접근
    프로젝트로 자동 링크(projection). (org_id/author_id 는 BE 가 canonical 처리.) 의도적으로
    require_project_id()를 쓰지 않음(ambiguous 키도 org-level 저장은 가능해야 함).
    """
    body: dict = {"author_id": args.author_id, "date": args.date}
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
        return ok(await client.get("/api/v2/standups", params={"project_id": client.require_project_id(), "date": args.date}))
    except Exception as exc:
        return err(str(exc))


async def get_retro_session(args: GetRetroSessionInput) -> list[TextContent]:
    """스프린트 레트로 세션 조회(없으면 생성) — story #2281 AC3ⓐ: 부르던 경로/메커니즘
    자체가 서버에 없었다(#2271). `POST /api/v2/retros/by-sprint`를 신설해 고쳤다."""
    try:
        body: dict = {"sprint_id": args.sprint_id}
        if args.title:
            body["title"] = args.title
        return ok(await client.post("/api/v2/retros/by-sprint", json=body))
    except Exception as exc:
        return err(str(exc))


async def update_retro_action_status(args: UpdateRetroActionStatusInput) -> list[TextContent]:
    """레트로 액션 아이템 상태 변경 (open|done) — story #2281 AC2: 경로에 세션 id가
    빠져 있었다(입력 스키마 자체에 필드가 없었음)."""
    try:
        return ok(await client.patch(
            f"/api/v2/retros/{args.session_id}/actions/{args.action_id}", json={"status": args.status}
        ))
    except Exception as exc:
        return err(str(exc))


async def checkin_sprint(args: CheckinSprintInput) -> list[TextContent]:
    """스프린트 체크인 — 진행률 + 스탠드업 미제출 현황."""
    try:
        return ok(await client.get(f"/api/v2/sprints/{args.sprint_id}/checkin", params={"date": args.date}))
    except Exception as exc:
        return err(str(exc))
