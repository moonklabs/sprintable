"""스프린트 관련 MCP 도구 (1개) — 목록 조회만 남는다. story 4811: 만들기 · 고치기 · 활성화 · 종료 · 요약 · 벨로시티 · 체크인은
에이전트 표면에서 걷었다(사람은 웹 스프린트 화면에서 한다). E-SECURITY SEC-S8: delete_sprint는 그 전에 이미 제거(에이전트 hard-delete 차단)."""
from __future__ import annotations

from mcp.types import TextContent

from ..api_client import client
from ..response import err, ok_paginated
from ..schemas import SprintStatus, SprintableInput
from .stories import _has_more_from_headers


class ListSprintsInput(SprintableInput):
    status: SprintStatus | None = None
    limit: int | None = None
    cursor: str | None = None  # 이전 호출의 X-Next-Cursor 헤더 값을 그대로 넘기면 다음 페이지.


async def list_sprints(args: ListSprintsInput) -> list[TextContent]:
    """스프린트 목록 조회."""
    try:
        params: dict = {"project_id": client.require_project_id()}
        if args.status:
            params["status"] = args.status.value
        if args.limit:
            params["limit"] = args.limit
        if args.cursor:
            params["cursor"] = args.cursor
        items, headers = await client.get_with_headers("/api/v2/sprints", params=params)
        has_more, next_cursor = _has_more_from_headers(headers, items)
        return ok_paginated(items, has_more=has_more, next_cursor=next_cursor, tool_name="sprintable_list_sprints")
    except Exception as exc:
        return err(exc)
