"""목표(구 에픽) 관련 MCP 도구 (4개) — E-SECURITY SEC-S1 확장: delete_goal 제거(에이전트
hard-delete 차단, delete_story와 동형 조치. 까심 적대적 QA 발견 갭 — cascade로 소속 stories까지
물리삭제).

계층 리네이밍 B1(story 1925): 구 tools/epics.py — REST 호출 대상을 신 경로(/api/v2/goals)로
전환. tool 이름 자체는 server.py의 _TOOL_DEFS가 신(sprintable_*_goal)+구(sprintable_*_epic)
양쪽으로 별칭 등록(같은 함수 재사용, 로직 복제 0) — hierarchy-rename-alias-mechanism-design §1.

story #2010: transition_goal(신규) 추가 — 목표 lifecycle 전이(draft/active/done/archived) 전용
도구. update_goal의 status 필드는 백엔드가 422로 거부(FSM 우회 방지, goals.py:280 주석 "use POST
/transition instead")하므로 이 도구를 통해서만 전이 가능. transition_goal은 rename(B1) 이후
신설이라 구 sprintable_*_epic 별칭 없음(server.py 참고).
"""
from __future__ import annotations

from mcp.types import TextContent
from pydantic import AliasChoices, ConfigDict, Field

from ..api_client import client
from ..response import err, ok
from ..schemas import GoalStatus, SprintableInput, StoryPriority


class ListGoalsInput(SprintableInput):
    pass


class AddGoalInput(SprintableInput):
    title: str
    priority: StoryPriority | None = None
    description: str | None = None
    objective: str | None = None
    success_criteria: str | None = None
    target_sp: int | None = None
    target_date: str | None = None


class UpdateGoalInput(SprintableInput):
    # ⚠️deprecated 별칭(sprintable_update_epic)도 같은 스키마 재사용 — 구 필드명 epic_id도
    # 계속 받아야 무중단(hierarchy-rename-alias-mechanism-design §1/§3 동형).
    model_config = ConfigDict(extra="ignore", populate_by_name=True)
    goal_id: str = Field(validation_alias=AliasChoices("goal_id", "epic_id"))
    title: str | None = None
    status: GoalStatus | None = None
    priority: StoryPriority | None = None
    description: str | None = None
    objective: str | None = None
    success_criteria: str | None = None
    target_sp: int | None = None
    target_date: str | None = None


async def list_goals(args: ListGoalsInput) -> list[TextContent]:
    """목표 목록 조회."""
    try:
        return ok(await client.get("/api/v2/goals", params={"project_id": client.require_project_id()}))
    except Exception as exc:
        return err(str(exc))


async def add_goal(args: AddGoalInput) -> list[TextContent]:
    """목표 생성."""
    try:
        body: dict = {"title": args.title, "project_id": client.require_project_id()}
        if args.priority:
            body["priority"] = args.priority.value
        for field in ("description", "objective", "success_criteria", "target_date"):
            val = getattr(args, field)
            if val is not None:
                body[field] = val
        if args.target_sp is not None:
            body["target_sp"] = args.target_sp
        return ok(await client.post("/api/v2/goals", json=body))
    except Exception as exc:
        return err(str(exc))


async def update_goal(args: UpdateGoalInput) -> list[TextContent]:
    """목표 수정."""
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
        return ok(await client.patch(f"/api/v2/goals/{args.goal_id}", json=updates))
    except Exception as exc:
        return err(str(exc))


class TransitionGoalInput(SprintableInput):
    goal_id: str
    status: GoalStatus


async def transition_goal(args: TransitionGoalInput) -> list[TextContent]:
    """목표 상태 전이(lifecycle transition) — draft/active/done/archived. update_goal의 status 필드는
    422로 거부되므로(FSM 우회 방지), 상태 전이는 이 도구를 써야 한다.

    ⚠️결재 게이트 주의: draft→active·active→done 은 line overlay-gated 전이라 라인이 enforcing이면
    백엔드가 200을 반환하면서도 실제 status는 바꾸지 않고(게이트 생성·결재 대기) 그대로 둔다(요청
    실패가 아니라 '보류'). 이 도구는 응답의 status가 요청한 status와 다르면 이를 감지해
    transitioned=False + 안내 메시지로 명시한다 — 겉보기 200 성공과 절대 혼동하지 말 것.
    """
    try:
        resp = await client.post(
            f"/api/v2/goals/{args.goal_id}/transition", json={"status": args.status.value}
        )
        actual_status = resp.get("status") if isinstance(resp, dict) else None
        if actual_status is not None and actual_status != args.status.value:
            return ok({
                **resp,
                "transitioned": False,
                "requested_status": args.status.value,
                "note": (
                    "결재 게이트가 생성되어 status가 변경되지 않았습니다(결재 대기) — "
                    f"현재 status는 여전히 '{actual_status}'입니다. 게이트가 승인되면 자동으로 "
                    f"'{args.status.value}'로 전이됩니다. 이 응답은 성공이 아니라 보류 상태입니다."
                ),
            })
        return ok({**resp, "transitioned": True}) if isinstance(resp, dict) else ok(resp)
    except Exception as exc:
        return err(str(exc))
