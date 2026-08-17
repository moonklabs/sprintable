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
    limit: int | None = None
    cursor: str | None = None  # 이전 호출의 X-Next-Cursor 헤더 값을 그대로 넘기면 다음 페이지.


async def emit_event(args: EmitEventInput) -> list[TextContent]:
    """에이전트 런 이벤트 발행."""
    try:
        body: dict = {
            "agent_id": args.agent_id, "trigger": args.trigger,
            "project_id": client.require_project_id(),  # E-MCP-OPT ff6cb90d: try 안에서 호출(가이드 에러 캡처).
        }
        for field in ("model", "story_id", "memo_id", "result_summary", "status",
                      "error_message", "input_tokens", "output_tokens", "started_at", "finished_at"):
            val = getattr(args, field)
            if val is not None:
                body[field] = val
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
    """에이전트 수신 대기 이벤트 폴링. 더 있으면(has_more) 다음 페이지 안내가 별도 텍스트
    블록으로 붙는다 — 단 이 도구는 순수 read(이 MCP 계층엔 mark_delivered를 부르는 도구가
    없음)라 다른 list_* 도구와 달리 cursor 없이 그냥 다시 부르면 같은 상위 N건이 그대로
    다시 온다(«비워지지» 않음). 안내 문구가 그 함정을 명시한다."""
    from .stories import _has_more_from_headers

    recipient = args.recipient_id or client.member_id
    params: dict = {"recipient_id": recipient}
    if args.event_type:
        params["event_type"] = args.event_type
    if args.limit:
        params["limit"] = args.limit
    if args.cursor:
        params["cursor"] = args.cursor
    try:
        items, headers = await client.get_with_headers("/api/v2/events/pending", params=params)
        has_more, next_cursor = _has_more_from_headers(headers, items)
        blocks = ok(items)
        if has_more:
            cursor_hint = f'cursor="{next_cursor}"' if next_cursor else "cursor(서버가 next_cursor를 안 줌 — 호출부 확인 필요)"
            blocks.append(TextContent(
                type="text",
                text=(
                    f"※ 더 있음 — 이 응답은 {len(items)}건까지만 포함(전량 아님). "
                    f"이 도구는 mark_delivered를 부르지 않는 순수 read라 cursor 없이 다시 불러도 같은 상위 "
                    f"{len(items)}건이 그대로 다시 온다(pending이 비워지지 않음) — 나머지를 보려면 "
                    f"poll_events를 {cursor_hint}로 다시 호출."
                ),
            ))
        return blocks
    except Exception as exc:
        return err(str(exc))
