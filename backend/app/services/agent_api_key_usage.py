"""story #2087 — 에이전트 API 키 사용 이력 감사 트레일. 기록(write)+조회(read) 둘 다.

write(`record_api_key_usage`)는 `_resolve_api_key`(auth.py) 성공 경로 말미에서 호출된다 —
`_touch_api_key_last_used`/`record_auth_failure`(story #2457/#2836)와 동형: 전용 단명
세션(caller `db` 트랜잭션과 분리 커밋)+fail-silent(인증 자체는 절대 안 막음). caller 세션을
쓰지 않는 이유는 story #2457 그대로다 — `get_current_user`는 REST 전반의 공용 진입점이라
caller 세션에 write를 얹으면 그 row/트랜잭션이 응답 완료까지 커넥션을 물고, 부하 시 primary
풀을 고갈시킨다(#2457 실측).

⚠️스로틀 없음(의도적) — `_touch_api_key_last_used`(5분 스로틀)와 다르다. 그 스로틀은
last_used_at 값의 대략적 정확도로 충분해 볼륨 절감이 이득이었지만, 이 원장은 «완전성»이
존재 이유(오늘 실제로 그 완전성 부재 때문에 키 유출 인시던트의 악용 여부를 증명도 반증도
못 했다) — 샘플링하면 목적 자체가 무효화된다."""
from __future__ import annotations

import logging
import uuid
from typing import TYPE_CHECKING

from sqlalchemy import select
from sqlalchemy.ext.asyncio import AsyncSession

if TYPE_CHECKING:
    from fastapi import Request

logger = logging.getLogger(__name__)

DEFAULT_LIST_LIMIT = 50
MAX_LIST_LIMIT = 200


async def record_api_key_usage(
    *,
    api_key_id: uuid.UUID,
    org_id: uuid.UUID | None,
    member_id: uuid.UUID | None,
    request: "Request | None",
) -> None:
    try:
        from app.core.database import async_session_factory
        from app.models.agent_api_key_usage_log import AgentApiKeyUsageLog

        from app.core.client_ip import client_ip

        endpoint = request.url.path if request is not None else "unknown"
        method = request.method if request is not None else "unknown"
        # story #4546 AC1: the real client (the one shared rule · #4398) — `request.client.host` on Cloud Run is the front end's own
        # 169.254.x.x for every call, so a Mac and the hosted MCP server looked the same
        remote_ip = client_ip(request) if request is not None else None
        # story #4546 AC2: per row, whether through our MCP client (its X-MCP-Transport) and which tool (X-Sprintable-Tool) — the
        # client's own words, capped (an unbounded header never grows the ledger), absent → NULL
        mcp_transport = _header(request, "x-mcp-transport", 16, lower=True)
        tool_name = _header(request, "x-sprintable-tool", 128)

        async with async_session_factory() as s:
            s.add(AgentApiKeyUsageLog(
                id=uuid.uuid4(), api_key_id=api_key_id, org_id=org_id, member_id=member_id,
                endpoint=endpoint, method=method, remote_ip=remote_ip,
                mcp_transport=mcp_transport, tool_name=tool_name,
            ))
            await s.commit()
    except Exception:
        logger.warning("record_api_key_usage failed api_key_id=%s", api_key_id, exc_info=True)


def _header(request: "Request | None", name: str, cap: int, *, lower: bool = False) -> str | None:
    """A request header as the ledger keeps it — trimmed, capped, NULL when absent or blank."""
    if request is None:
        return None
    value = (request.headers.get(name) or "").strip()
    if not value:
        return None
    value = value[:cap]
    return value.lower() if lower else value


DEFAULT_SUMMARY_DAYS = 7
MAX_SUMMARY_DAYS = 90
SUMMARY_TOP = 10
_UUID_RE = "[0-9a-fA-F]{8}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{12}"


async def summarize_api_key_usage(session: AsyncSession, api_key_id: uuid.UUID, *, days: int = DEFAULT_SUMMARY_DAYS) -> dict:
    """story #4546 AC3 — one key's calls over the last `days`: through our MCP client (by transport) vs direct, and the top paths
    (ids folded to {id}), tools and client addresses, each with its count. Read only, on the caller's session (an owner opens it)."""
    from datetime import timedelta

    from sqlalchemy import func

    from app.models.agent_api_key_usage_log import AgentApiKeyUsageLog as L

    days = min(max(days, 1), MAX_SUMMARY_DAYS)
    in_window = (L.api_key_id == api_key_id, L.occurred_at >= func.now() - timedelta(days=days))
    via_mcp = func.count().filter(L.mcp_transport.is_not(None))

    by_transport = (await session.execute(
        select(L.mcp_transport, func.count()).where(*in_window).group_by(L.mcp_transport)
    )).all()
    path = func.regexp_replace(L.endpoint, _UUID_RE, "{id}", "g").label("path")
    paths = (await session.execute(
        select(L.method, path, func.count().label("n"), via_mcp).where(*in_window)
        .group_by(L.method, path).order_by(func.count().desc(), L.method, path).limit(SUMMARY_TOP)
    )).all()
    tools = (await session.execute(
        select(L.tool_name, func.count().label("n")).where(*in_window, L.tool_name.is_not(None))
        .group_by(L.tool_name).order_by(func.count().desc(), L.tool_name).limit(SUMMARY_TOP)
    )).all()
    addresses = (await session.execute(
        select(L.remote_ip, func.count().label("n"), via_mcp).where(*in_window)
        .group_by(L.remote_ip).order_by(func.count().desc(), L.remote_ip).limit(SUMMARY_TOP)
    )).all()

    mcp_by_transport = {t: n for t, n in by_transport if t is not None}
    direct = sum(n for t, n in by_transport if t is None)
    return {
        "api_key_id": api_key_id,
        "days": days,
        "total": direct + sum(mcp_by_transport.values()),
        "direct": direct,
        "via_mcp": sum(mcp_by_transport.values()),
        "via_mcp_by_transport": mcp_by_transport,
        "top_paths": [{"method": m, "path": p, "count": n, "via_mcp": v} for m, p, n, v in paths],
        "top_tools": [{"tool": t, "count": n} for t, n in tools],
        "top_remote_ips": [{"remote_ip": ip, "count": n, "via_mcp": v} for ip, n, v in addresses],
    }


async def list_api_key_usage(session: AsyncSession, api_key_id: uuid.UUID, *, limit: int = DEFAULT_LIST_LIMIT):
    """읽기 전용 — caller 세션(요청-수명 get_db) 그대로 사용해도 안전(REST 전반 공용 hot-path인
    write와 달리, 이 조회는 admin/owner가 명시로 여는 화면 1건당 1회뿐)."""
    from app.models.agent_api_key_usage_log import AgentApiKeyUsageLog

    limit = min(max(limit, 1), MAX_LIST_LIMIT)
    result = await session.execute(
        select(AgentApiKeyUsageLog)
        .where(AgentApiKeyUsageLog.api_key_id == api_key_id)
        .order_by(AgentApiKeyUsageLog.occurred_at.desc(), AgentApiKeyUsageLog.id.desc())
        .limit(limit)
    )
    return list(result.scalars().all())
