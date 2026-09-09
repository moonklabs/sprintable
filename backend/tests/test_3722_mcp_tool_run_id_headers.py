"""story #3722(Trust·PR2) — MCP=이름표만. X-Sprintable-Tool(call_tool 훅 contextvar)·
X-Sprintable-Run-Id(env) 두 헤더가 BE tool_call_recording 미들웨어의 tool/run_id 귀속 축
ⓐ를 태운다. test_mcp_per_call_project_85429ee0.py(_project_override)와 동형 harness."""
from __future__ import annotations

from unittest.mock import patch

import pytest


@pytest.fixture
def anyio_backend():
    return "asyncio"


def _seed_client():
    from sprintable_mcp.api_client import client

    client._base_url = "http://x"
    client._api_key = "k"
    client._project_id = "DEFAULT"
    client._org_id = "ORG"
    client._member_id = "MEM"
    return client


class _Resp:
    status_code = 200
    is_success = True
    text = "{}"

    def json(self):
        return {"ok": 1}


class _FakeClient:
    def __init__(self, captured: dict):
        self._captured = captured

    async def __aenter__(self):
        return self

    async def __aexit__(self, *a):
        return False

    async def request(self, method, url, json=None, params=None, headers=None):
        self._captured["headers"] = headers
        return _Resp()


def test_run_id_env_name_contract(monkeypatch):
    """⭐배포 env 이름 계약 고정(test_e_mcp_http_s1.py::test_deploy_relevant_env_names와 동형) —
    필드명 sprintable_run_id ↔ env SPRINTABLE_RUN_ID 일치."""
    from sprintable_mcp.config import McpSettings

    monkeypatch.setenv("SPRINTABLE_RUN_ID", "run-xyz")
    s = McpSettings()
    assert s.sprintable_run_id == "run-xyz"


def test_tool_name_override_contextvar():
    from sprintable_mcp.api_client import reset_tool_name_override, set_tool_name_override

    tok = set_tool_name_override("sprintable_add_task")
    from sprintable_mcp.api_client import _tool_name_override

    assert _tool_name_override.get() == "sprintable_add_task"
    reset_tool_name_override(tok)
    assert _tool_name_override.get() is None
    tok2 = set_tool_name_override(None)  # None → 무회귀
    assert _tool_name_override.get() is None
    reset_tool_name_override(tok2)


@pytest.mark.anyio
async def test_request_sets_x_sprintable_tool_on_override():
    from sprintable_mcp.api_client import (
        client,
        reset_tool_name_override,
        set_tool_name_override,
    )

    _seed_client()
    captured: dict = {}

    with patch("sprintable_mcp.api_client.httpx.AsyncClient", return_value=_FakeClient(captured)):
        # override 없음 → 헤더 미전송(REST 직접 호출·구버전 클라이언트와 무회귀)
        await client.request("GET", "/api/v2/stories")
        assert "X-Sprintable-Tool" not in captured["headers"]

        tok = set_tool_name_override("sprintable_add_task")
        await client.request("GET", "/api/v2/stories")
        assert captured["headers"].get("X-Sprintable-Tool") == "sprintable_add_task"
        reset_tool_name_override(tok)


@pytest.mark.anyio
async def test_request_sets_x_sprintable_run_id_from_env_setting():
    from sprintable_mcp import config
    from sprintable_mcp.api_client import client

    _seed_client()
    captured: dict = {}

    with patch("sprintable_mcp.api_client.httpx.AsyncClient", return_value=_FakeClient(captured)):
        # 미설정(기본값 "") → 헤더 미전송
        await client.request("GET", "/api/v2/stories")
        assert "X-Sprintable-Run-Id" not in captured["headers"]

        # 설정 → 매 요청마다 실린다(개별 override 불요 — 프로세스 수명 동안 고정)
        with patch.object(config.settings, "sprintable_run_id", "run-abc-123"):
            await client.request("GET", "/api/v2/stories")
            assert captured["headers"].get("X-Sprintable-Run-Id") == "run-abc-123"


@pytest.mark.anyio
async def test_flat_wrapper_sets_and_resets_tool_name_override():
    """server.py _flat()의 단일 훅 — fn 호출 동안만 도구 이름이 실리고 끝나면 리셋된다."""
    from pydantic import BaseModel

    from sprintable_mcp.api_client import _tool_name_override
    from sprintable_mcp.server import _flat

    seen: dict = {}

    class _Input(BaseModel):
        x: int = 1

    async def _fn(inp: _Input):
        seen["during"] = _tool_name_override.get()
        return []

    w = _flat("my_tool_name", "doc", _Input, _fn)
    assert _tool_name_override.get() is None  # 호출 전
    with patch("sprintable_mcp.server._load_scope_for", return_value=[]):
        await w(x=1)
    assert seen["during"] == "my_tool_name"  # fn 실행 중엔 실린다
    assert _tool_name_override.get() is None  # 끝나면 리셋(finally)
