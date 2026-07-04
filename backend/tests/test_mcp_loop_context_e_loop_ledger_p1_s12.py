"""E-LOOP-LEDGER P1-S12: sprintable_get_loop_context MCP 도구 테스트(블루프린트 §2/§P1).

GET /loops/{id}/context-pack의 얇은 HTTP 래퍼(get_hypothesis와 동형 패턴) + always-allowed
등록(get_workflow_guide 동형, SSOT↔vendored 양쪽 일치) 검증.
"""
import json
from unittest.mock import AsyncMock, MagicMock, patch

import pytest

from sprintable_mcp.tools import loops as l


@pytest.fixture
def anyio_backend():
    return "asyncio"


def _client(**methods):
    c = MagicMock()
    c.project_id = "proj-1"
    for name, ret in methods.items():
        setattr(c, name, AsyncMock(return_value=ret))
    return c


async def test_get_loop_context_calls_correct_path_and_returns_data():
    payload = {"items": [{"entity_type": "loop", "similarity": 0.9}], "embed_available": True}
    client = _client(get=payload)
    with patch.object(l, "client", client):
        out = await l.get_loop_context(l.GetLoopContextInput(loop_id="loop-1"))
    assert client.get.call_args.args[0] == "/api/v2/loops/loop-1/context-pack"
    data = json.loads(out[0].text)
    assert data == payload


async def test_get_loop_context_wraps_exception_as_err():
    client = _client()
    client.get = AsyncMock(side_effect=RuntimeError("boom"))
    with patch.object(l, "client", client):
        out = await l.get_loop_context(l.GetLoopContextInput(loop_id="loop-1"))
    assert out[0].text == "Error: boom"


# ── always-allowed 등록(SSOT+vendored 양쪽) ─────────────────────────────────────

def test_get_loop_context_always_allowed_ssot_and_vendored():
    from app.services.mcp_toolset import _ALWAYS_ALLOWED as ssot_always
    from sprintable_mcp.toolset import _ALWAYS_ALLOWED as vendored_always
    assert "sprintable_get_loop_context" in ssot_always
    assert "sprintable_get_loop_context" in vendored_always


def test_get_loop_context_is_tool_allowed_regardless_of_scope():
    from app.services.mcp_toolset import is_tool_allowed as ssot_allowed
    from sprintable_mcp.toolset import is_tool_allowed as vendored_allowed
    # 어떤 scope를 줘도(심지어 무관한 그룹만) 항상 허용돼야 한다.
    assert ssot_allowed("sprintable_get_loop_context", ["stories"])
    assert vendored_allowed("sprintable_get_loop_context", ["stories"])
    assert ssot_allowed("sprintable_get_loop_context", [])
    assert vendored_allowed("sprintable_get_loop_context", [])


def test_get_loop_context_registered_in_all_tool_names():
    from app.services.mcp_toolset import ALL_TOOL_NAMES
    assert "sprintable_get_loop_context" in ALL_TOOL_NAMES


def test_vendored_drift_fixed_workflow_guide_team_members_poll_events_also_always_allowed():
    """P1-S12 발견 즉시 수정 — vendored _ALWAYS_ALLOWED가 SSOT 대비 3건 누락돼있던 드리프트.
    두 파일이 이 3건+신규 get_loop_context까지 동일해야 한다."""
    from app.services.mcp_toolset import _ALWAYS_ALLOWED as ssot_always
    from sprintable_mcp.toolset import _ALWAYS_ALLOWED as vendored_always
    for tool in ("sprintable_get_workflow_guide", "sprintable_list_team_members", "sprintable_poll_events"):
        assert tool in ssot_always
        assert tool in vendored_always
