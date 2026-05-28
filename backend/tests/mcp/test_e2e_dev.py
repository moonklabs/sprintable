"""S4-1: Python MCP 서버 subprocess stdio E2E 실호출 검증.

SPRINTABLE_API_URL + AGENT_API_KEY 환경변수 미설정 시 자동 skip.
dev 백엔드 기준 read-only 도구 20개 이상 실호출 확인.
"""
from __future__ import annotations

import os
import sys
from pathlib import Path

import pytest
from mcp import ClientSession
from mcp.client.stdio import StdioServerParameters, stdio_client

_API_URL = os.environ.get("SPRINTABLE_API_URL", "")
_API_KEY = os.environ.get("AGENT_API_KEY", "")
_CI = os.environ.get("CI", "")
_BACKEND_DIR = str(Path(__file__).parents[2])  # backend/

pytestmark = pytest.mark.skipif(
    not (_API_URL and _API_KEY) or bool(_CI),
    reason="SPRINTABLE_API_URL + AGENT_API_KEY 미설정 또는 CI 환경 — dev E2E skip",
)

_SERVER_PARAMS = StdioServerParameters(
    command=sys.executable,
    args=["-m", "sprintable_mcp"],
    env={"SPRINTABLE_API_URL": _API_URL, "AGENT_API_KEY": _API_KEY},
    cwd=_BACKEND_DIR,
)

# read-only 도구 20개 이상 (인수 없거나 project_id만 필요)
READ_ONLY_TOOLS = [
    ("ping", {}),
    ("sprintable_list_stories", {}),
    ("sprintable_list_backlog", {}),
    ("sprintable_list_tasks", {}),
    ("sprintable_list_epics", {}),
    ("sprintable_list_sprints", {}),
    ("sprintable_list_docs", {}),
    ("sprintable_get_project_overview", {}),
    ("sprintable_get_project_health", {}),
    ("sprintable_get_sprint_velocity_history", {}),
    ("sprintable_list_team_members", {}),
    ("sprintable_list_meetings", {}),
    ("sprintable_list_retro_sessions", {}),
    ("sprintable_list_audit_logs", {}),
    ("sprintable_check_notifications", {}),
    ("sprintable_standup_history", {}),
    ("sprintable_get_recent_activity", {}),
    ("sprintable_my_dashboard", {}),
    ("sprintable_search_stories", {"query": "test"}),
]


@pytest.mark.anyio
async def test_tools_list_89_tools():
    """tools/list 응답에서 89개 도구 전량 확인."""
    async with stdio_client(_SERVER_PARAMS) as (read, write):
        async with ClientSession(read, write) as session:
            await session.initialize()
            result = await session.list_tools()
            tool_names = {t.name for t in result.tools}
            assert len(tool_names) == 89, f"도구 수 불일치: {len(tool_names)}"


@pytest.mark.anyio
async def test_read_only_tools_succeed():
    """read-only 도구 21개 dev 백엔드 실호출 — 200 응답 확인."""
    async with stdio_client(_SERVER_PARAMS) as (read, write):
        async with ClientSession(read, write) as session:
            await session.initialize()
            failed: list[str] = []
            for tool_name, args in READ_ONLY_TOOLS:
                try:
                    result = await session.call_tool(tool_name, args)
                    if result.isError:
                        failed.append(f"{tool_name}: isError=True — {result.content[0].text[:200] if result.content else ''}")
                except Exception as exc:
                    failed.append(f"{tool_name}: exception — {exc}")
            assert not failed, f"실호출 실패 도구:\n" + "\n".join(failed)
