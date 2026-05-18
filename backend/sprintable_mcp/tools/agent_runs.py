"""에이전트 런 MCP 도구 (3개)."""
from __future__ import annotations

from typing import Literal

from mcp.types import TextContent

from ..api_client import client
from ..response import err, ok
from ..schemas import SprintableInput

RunStatus = Literal["running", "completed", "failed"]


class EmitEventInput(SprintableInput):
    agent_id: str
    trigger: str
    model: str | None = None
    story_id: str | None = None
    memo_id: str | None = None
    result_summary: str | None = None
    status: RunStatus | None = None
    error_message: str | None = None
    input_tokens: int | None = None
    output_tokens: int | None = None
    started_at: str | None = None
    finished_at: str | None = None


class UpdateRunStatusInput(SprintableInput):
    run_id: str
    status: RunStatus
    error_message: str | None = None
    result_summary: str | None = None
    input_tokens: int | None = None
    output_tokens: int | None = None
    cost_usd: float | None = None
    started_at: str | None = None
    finished_at: str | None = None


class PollEventsInput(SprintableInput):
    recipient_id: str | None = None
    event_type: str | None = None


async def emit_event(args: EmitEventInput) -> list[TextContent]:
    """에이전트 런 이벤트 발행."""
    body: dict = {"agent_id": args.agent_id, "trigger": args.trigger, "project_id": client.project_id}
    for field in ("model", "story_id", "memo_id", "result_summary", "status",
                  "error_message", "input_tokens", "output_tokens", "started_at", "finished_at"):
        val = getattr(args, field)
        if val is not None:
            body[field] = val
    try:
        return ok(await client.post("/api/v2/agent-runs", json=body))
    except Exception as exc:
        return err(str(exc))


async def update_run_status(args: UpdateRunStatusInput) -> list[TextContent]:
    """에이전트 런 상태 업데이트."""
    body: dict = {"status": args.status}
    for field in ("error_message", "result_summary", "input_tokens", "output_tokens",
                  "cost_usd", "started_at", "finished_at"):
        val = getattr(args, field)
        if val is not None:
            body[field] = val
    try:
        return ok(await client.patch(f"/api/v2/agent-runs/{args.run_id}", json=body))
    except Exception as exc:
        return err(str(exc))


async def poll_events(args: PollEventsInput) -> list[TextContent]:
    """에이전트 수신 대기 이벤트 폴링."""
    recipient = args.recipient_id or client.member_id
    params: dict = {"recipient_id": recipient}
    if args.event_type:
        params["event_type"] = args.event_type
    try:
        data = await client.get("/api/v2/events/pending", params=params)
        return ok(data or [])
    except Exception as exc:
        return err(str(exc))
