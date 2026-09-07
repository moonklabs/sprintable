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
async def test_tools_list_matches_registered_tool_count():
    """tools/list 응답이 등록된 도구 전량을 낸다.

    story #3657(카디르 3648② 재QA 발견) — 이 자리가 원래 `== 89`로 하드코딩돼 있었다.
    도구는 스토리마다 계속 늘어나는 값이라(2026-09-07 실측 시점 126개) 고정 상수는
    등록될 때마다 다시 stale해지는 게 예정된 결함 클래스 — "몇 개인가"를 박아 두는
    대신 "subprocess(STDIO transport)로 받은 목록이 in-process로 직접 부른
    `mcp.list_tools()`와 정확히 같은 집합인가"를 잰다(등록 루프가 조용히 일부를
    빠뜨리는 진짜 회귀는 여전히 잡되, 정상적인 도구 추가엔 무반응 — story #3631류
    신규 그룹/도구 추가가 이 테스트를 매번 다시 고장내지 않는다)."""
    from sprintable_mcp.server import mcp as _in_process_mcp

    in_process_tools = await _in_process_mcp.list_tools()
    in_process_names = {t.name for t in in_process_tools}
    assert in_process_names, "in-process 등록 도구 0건 — _TOOL_DEFS 등록 루프 자체가 비어 있다"

    async with stdio_client(_SERVER_PARAMS) as (read, write):
        async with ClientSession(read, write) as session:
            await session.initialize()
            result = await session.list_tools()
            tool_names = {t.name for t in result.tools}
            assert tool_names == in_process_names, (
                f"subprocess(STDIO) tools/list이 in-process 등록 목록과 다르다 — "
                f"subprocess에만 있음: {tool_names - in_process_names} · "
                f"in-process에만 있음: {in_process_names - tool_names}"
            )


@pytest.mark.anyio
async def test_read_only_tools_succeed():
    """read-only 도구(READ_ONLY_TOOLS, 위 정의) dev 백엔드 실호출 — 200 응답 확인.

    story #3657 — 이 docstring이 "21개"라고 고정 적혀 있었는데 실제 리스트는 19개였다
    (같은 stale-count 클래스, 어차피 개수 자체를 코드가 안 쓰므로 리스트 자체를 그대로
    인용해 다시 안 어긋나게 한다)."""
    async with stdio_client(_SERVER_PARAMS) as (read, write):
        async with ClientSession(read, write) as session:
            await session.initialize()
            failed: list[str] = []
            for tool_name, args in READ_ONLY_TOOLS:
                try:
                    result = await session.call_tool(tool_name, args)
                    # story #2772(mcp 2.0 이관) — CallToolResult.isError → is_error(camelCase→
                    # snake_case 전수 개명, 실측: mcp.types.CallToolResult.model_fields).
                    if result.is_error:
                        failed.append(f"{tool_name}: is_error=True — {result.content[0].text[:200] if result.content else ''}")
                except Exception as exc:
                    failed.append(f"{tool_name}: exception — {exc}")
            assert not failed, f"실호출 실패 도구:\n" + "\n".join(failed)
