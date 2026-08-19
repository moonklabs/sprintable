"""story #2793(2790 P2) — get_workflow_guide respec: `/api/v2/workflow-recipes`(recipes[0]
임의 선택) 대신 `/api/v2/events/onboarding-guide` 단일 호출로 교체. MCP 도구 얇은 래퍼
검증(loops.py::test_get_loop_context 동형 패턴)."""
import json
from unittest.mock import AsyncMock, MagicMock, patch

import pytest

from sprintable_mcp.tools import core as c


@pytest.fixture
def anyio_backend():
    return "asyncio"


def _client(**methods):
    client = MagicMock()
    client.project_id = "proj-1"
    for name, ret in methods.items():
        setattr(client, name, AsyncMock(return_value=ret))
    return client


async def test_get_workflow_guide_calls_onboarding_guide_endpoint_only():
    """⭐가드 — recipes[0] 임의 선택 결함 재발 방지. 이 도구가 부르는 엔드포인트가
    /api/v2/events/onboarding-guide **하나뿐**이어야 한다(구 workflow-recipes 2단계
    호출·recipes[0] 인덱싱이 다시 안 생기게)."""
    payload = {"philosophy": "...", "guide": "# 가이드\n...", "event_count": 3}
    client = _client(get=payload)
    with patch.object(c, "client", client):
        out = await c.get_workflow_guide(c.SprintableInput())
    assert client.get.call_count == 1
    assert client.get.call_args.args[0] == "/api/v2/events/onboarding-guide"
    data = json.loads(out[0].text)
    assert data == payload


async def test_get_workflow_guide_wraps_exception_as_err():
    client = _client()
    client.get = AsyncMock(side_effect=RuntimeError("boom"))
    with patch.object(c, "client", client):
        out = await c.get_workflow_guide(c.SprintableInput())
    assert out[0].text == "Error: boom"


def test_get_workflow_guide_still_always_allowed_ssot_and_vendored():
    """respec이 기존 always-allowed 등록(SSOT+vendored 양쪽)을 안 건드렸는지 — read-only·
    self-pull 도구라는 성질 자체는 안 바뀜."""
    from app.services.mcp_toolset import _ALWAYS_ALLOWED as ssot_always
    from sprintable_mcp.toolset import _ALWAYS_ALLOWED as vendored_always
    assert "sprintable_get_workflow_guide" in ssot_always
    assert "sprintable_get_workflow_guide" in vendored_always
