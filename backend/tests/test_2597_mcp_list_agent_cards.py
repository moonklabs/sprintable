"""story #2597(E-AGENT-ONBOARD·A2A발견 P0-1, 문서 e-a2a-discovery-spike-design 갭 A):
MCP sprintable_list_agent_cards — GET /api/v2/a2a/members 래퍼(순수 배선, 신규 백엔드
로직 없음). AC1(도구 존재)·AC3(skill 필터 전달)·AC5(unit test)를 이 파일이 커버한다.
AC2(agent 크리덴셜 org 스코프)는 기존 client 인증 배선을 그대로 타므로 재검증 대상 아님
(client.get이 이미 sk_live_ Bearer를 항상 싣는다, 다른 모든 MCP 도구와 동형)."""
from __future__ import annotations

import json
from unittest.mock import AsyncMock, patch

import pytest


@pytest.fixture
def anyio_backend():
    return "asyncio"


@pytest.mark.anyio
async def test_list_agent_cards_without_skill_calls_bare_endpoint():
    from sprintable_mcp.tools.a2a import ListAgentCardsInput, list_agent_cards

    cards = [
        {"name": "카디르", "skills": [{"id": "qa-automation", "name": "QA Automation 엔지니어",
                                       "description": "...", "tags": []}]},
    ]
    calls: list[tuple[str, dict | None]] = []

    async def fake_get(path, params=None):
        calls.append((path, params))
        return cards

    with patch("sprintable_mcp.tools.a2a.client") as mock_client:
        mock_client.get = AsyncMock(side_effect=fake_get)
        out = await list_agent_cards(ListAgentCardsInput())

    assert calls == [("/api/v2/a2a/members", None)]
    parsed = json.loads(out[0].text)
    assert parsed == cards


@pytest.mark.anyio
async def test_list_agent_cards_with_skill_passes_filter_param():
    from sprintable_mcp.tools.a2a import ListAgentCardsInput, list_agent_cards

    calls: list[tuple[str, dict | None]] = []

    async def fake_get(path, params=None):
        calls.append((path, params))
        return []

    with patch("sprintable_mcp.tools.a2a.client") as mock_client:
        mock_client.get = AsyncMock(side_effect=fake_get)
        await list_agent_cards(ListAgentCardsInput(skill="qa"))

    assert calls == [("/api/v2/a2a/members", {"skill": "qa"})]


@pytest.mark.anyio
async def test_list_agent_cards_empty_skill_string_treated_as_no_filter():
    """빈 문자열("")은 필터 의도가 아니다 — None과 동일하게 취급(서버 쿼리파람 오염 방지)."""
    from sprintable_mcp.tools.a2a import ListAgentCardsInput, list_agent_cards

    calls: list[tuple[str, dict | None]] = []

    async def fake_get(path, params=None):
        calls.append((path, params))
        return []

    with patch("sprintable_mcp.tools.a2a.client") as mock_client:
        mock_client.get = AsyncMock(side_effect=fake_get)
        await list_agent_cards(ListAgentCardsInput(skill=""))

    assert calls == [("/api/v2/a2a/members", None)]


@pytest.mark.anyio
async def test_list_agent_cards_error_surfaces():
    from sprintable_mcp.tools.a2a import ListAgentCardsInput, list_agent_cards

    with patch("sprintable_mcp.tools.a2a.client") as mock_client:
        mock_client.get = AsyncMock(side_effect=Exception("401 Unauthorized"))
        out = await list_agent_cards(ListAgentCardsInput())

    assert "error" in out[0].text.lower()


def test_tool_registered_in_mcp_server():
    from sprintable_mcp.server import _TOOL_DEFS

    names = {name for name, *_ in _TOOL_DEFS}
    assert "sprintable_list_agent_cards" in names


def test_tool_always_allowed_regardless_of_scoped_key():
    """role_template.default_tool_groups가 이 도구의 그룹을 안 가진 스코프 키(예: qa-automation의
    ["stories","tasks","chat","docs","retro"])로도 호출 가능해야 한다 — 「누구에게 청할지」
    발견은 어떤 role이든 필요한 cross-cutting 유틸이라 _ALWAYS_ALLOWED(core) 취급이 필수."""
    from app.services.mcp_toolset import is_tool_allowed

    narrow_scope = ["stories", "tasks", "chat", "docs", "retro"]
    assert is_tool_allowed("sprintable_list_agent_cards", narrow_scope) is True


def test_backend_and_vendored_toolset_stay_in_sync():
    from app.services import mcp_toolset as backend
    from sprintable_mcp import toolset as vendored

    assert "sprintable_list_agent_cards" in backend._ALWAYS_ALLOWED
    assert "sprintable_list_agent_cards" in vendored._ALWAYS_ALLOWED
    assert "sprintable_list_agent_cards" in backend.ALL_TOOL_NAMES
