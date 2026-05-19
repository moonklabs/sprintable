"""감사 로그 MCP 도구 (1개)."""
from __future__ import annotations

from mcp.types import TextContent

from ..api_client import client
from ..response import err, ok
from ..schemas import SprintableInput


class ListAuditLogsInput(SprintableInput):
    limit: int | None = None
    cursor: str | None = None


async def list_audit_logs(args: ListAuditLogsInput) -> list[TextContent]:
    """권한 감사 로그 조회 (Admin/Owner 전용)."""
    params: dict = {}
    if args.limit is not None:
        params["limit"] = str(args.limit)
    if args.cursor:
        params["cursor"] = args.cursor
    try:
        return ok(await client.get("/api/v2/audit-logs", params=params))
    except Exception as exc:
        return err(str(exc))
