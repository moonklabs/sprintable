"""A2A HITL writer MCP 도구 (1개) — E-A2A-완성 S-A3(story 6d0454c3) + S-A5(story c140977f)."""
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
