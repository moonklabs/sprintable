"""Harness-local Advisor MCP tools; model execution remains in the client harness."""
from __future__ import annotations
from mcp.types import TextContent
from ..api_client import client
from ..response import err, ok
from ..schemas import SprintableInput


class AdvisorContextInput(SprintableInput):
    story_id: str
    moment: str = "preflight"
    max_prior_decisions: int = 5

class ReportDoneInput(SprintableInput):
    story_id: str
    stage: str
    context: dict | None = None
    summary: str | None = None
    head_sha: str | None = None
    intent_hash: str | None = None
    self_review: dict | None = None


async def advisor_context(args: AdvisorContextInput) -> list[TextContent]:
    try:
        return ok(
            await client.get(
                "/api/v2/advisor/context",
                params={
                    "story_id": args.story_id,
                    "moment": args.moment,
                    "max_prior_decisions": args.max_prior_decisions,
                },
            )
        )
    except Exception as exc:
        return err(str(exc))


async def report_done(args: ReportDoneInput) -> list[TextContent]:
    if not client.member_id:
        return err("MCP member identity is required")
    try:
        body = {"story_id": args.story_id, "stage": args.stage, "agent_id": client.member_id}
        for key in ("context", "summary", "head_sha", "intent_hash", "self_review"):
            if (value := getattr(args, key)) is not None:
                body[key] = value
        return ok(await client.post("/api/v2/workflow/report-done", json=body))
    except Exception as exc:
        return err(str(exc))
