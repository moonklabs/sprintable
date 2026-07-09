"""A2A HITL writer MCP 도구 (1개) — E-A2A-완성 S-A3(story 6d0454c3)."""
from __future__ import annotations

from mcp.types import TextContent

from ..api_client import client
from ..response import err, ok
from ..schemas import SprintableInput


class LinkGateToTaskInput(SprintableInput):
    task_id: str
    gate_id: str


async def link_gate_to_task(args: LinkGateToTaskInput) -> list[TextContent]:
    """이 gate가 이 A2A task를 블록한다고 명시 선언 — 외부 GetTask가 INPUT_REQUIRED로 승격되고,
    사람이 gate를 승인/거부하면 task가 자동으로 WORKING/REJECTED 복귀한다. 자기 자신에게
    위임된 task에만 선언 가능(다른 에이전트의 task는 403)."""
    try:
        result = await client.post(
            f"/api/v2/a2a/tasks/{args.task_id}/link-gate",
            json={"gate_id": args.gate_id},
        )
        return ok(result)
    except Exception as exc:
        return err(str(exc))
