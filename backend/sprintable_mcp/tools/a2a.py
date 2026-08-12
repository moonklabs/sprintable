"""A2A MCP 도구(2개) — E-A2A-완성 S-A3(story 6d0454c3) + S-A5(story c140977f) +
E-AGENT-ONBOARD·A2A발견 P0-1(story #2597, 문서 e-a2a-discovery-spike-design 갭 A).

story #2597: 발견 도구(list_agent_cards) 신설 전엔 이 파일에 `link_gate_to_task` 1개뿐이었다
— `GET /api/v2/a2a/members`(백엔드 `app/routers/a2a.py:471`, story 5578a8e2 S3)는 이미
org 내 활성 agent 전원의 AgentCard(+`?skill=` 필터)를 정확히 반환하는데, 이를 감싸는 MCP
도구가 없어 MCP만 쓰는 에이전트는 "누가 QA인지" 같은 발견을 할 방법이 구조적으로 없었다
(스파이크 doc 갭 A). 백엔드 라우터/스키마는 변경하지 않는다 — 이미 spec 정합(story 480e81fb).
"""
from __future__ import annotations

from mcp.types import TextContent

from ..api_client import client
from ..response import err, ok
from ..schemas import SprintableInput


class LinkGateToTaskInput(SprintableInput):
    task_id: str
    gate_id: str
    # S-A5: "auth"로 선언하면 INPUT_REQUIRED 대신 AUTH_REQUIRED로 전이("외부 크리덴셜 필요"
    # 명시 신호). 생략(None) = 기존 S-A3 동작 그대로(INPUT_REQUIRED, 무회귀).
    reason: str | None = None


async def link_gate_to_task(args: LinkGateToTaskInput) -> list[TextContent]:
    """이 gate가 이 A2A task를 블록한다고 명시 선언 — 외부 GetTask가 INPUT_REQUIRED(또는
    reason="auth"면 AUTH_REQUIRED)로 승격되고, 사람이 gate를 승인/거부하면 task가 자동으로
    WORKING/REJECTED 복귀한다. 자기 자신에게 위임된 task에만 선언 가능(다른 에이전트의 task는
    403)."""
    try:
        payload = {"gate_id": args.gate_id}
        if args.reason is not None:
            payload["reason"] = args.reason
        result = await client.post(
            f"/api/v2/a2a/tasks/{args.task_id}/link-gate",
            json=payload,
        )
        return ok(result)
    except Exception as exc:
        return err(str(exc))


class ListAgentCardsInput(SprintableInput):
    # story #2597 AC3: 서버측 `_skill_matches`(a2a.py) 로 그대로 전달 — id/tags/name/
    # description 부분일치(대소문자 무시). 생략 시 org 내 활성 agent 전원 반환.
    skill: str | None = None


async def list_agent_cards(args: ListAgentCardsInput) -> list[TextContent]:
    """지금 이 org에서 "누구에게 청할지" 발견한다 — org 내 활성 agent 전원의 A2A AgentCard
    (표준 규격: name/skills/security 등)를 열거한다. `skill`을 주면(예: "qa", "backend")
    서버가 각 카드의 skill id/name/description/tags를 부분일치로 걸러 후보만 돌려준다 —
    "이 작업엔 누가 적임자인가"를 사람이 미리 알려주지 않아도 스스로 찾을 때 쓴다(예: PR을
    올린 뒤 QA 담당을 모를 때 `skill="qa"`로 조회해 반환된 member_id에게
    sprintable_send_chat_message 로 청한다). 자기 자신의 크리덴셜(org 스코프)로만 조회되며,
    타 org의 카드는 보이지 않는다."""
    try:
        params: dict = {}
        if args.skill:
            params["skill"] = args.skill
        result = await client.get("/api/v2/a2a/members", params=params or None)
        return ok(result)
    except Exception as exc:
        return err(str(exc))
