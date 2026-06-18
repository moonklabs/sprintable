"""85429ee0: MCP per-call project_id override(org-agent 멀티프로젝트) — contextvar·X-Project-Id·signature."""
from __future__ import annotations

import inspect
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


def test_project_override_contextvar():
    from sprintable_mcp.api_client import (
        client,
        reset_project_override,
        set_project_override,
    )

    _seed_client()
    assert client.project_id == "DEFAULT"  # override 없음 → 키 default
    tok = set_project_override("OVR")
    assert client.project_id == "OVR"  # override 우선
    reset_project_override(tok)
    assert client.project_id == "DEFAULT"  # reset → default
    tok2 = set_project_override(None)  # None → default(무회귀)
    assert client.project_id == "DEFAULT"
    reset_project_override(tok2)


def test_sprintable_input_has_project_id():
    from sprintable_mcp.schemas import SprintableInput

    assert "project_id" in SprintableInput.model_fields
    assert SprintableInput.model_fields["project_id"].default is None  # optional·무회귀


def test_flat_signature_required_before_default():
    """base project_id(기본값 有)가 subclass 필수필드보다 앞서면 signature 깨짐 → 정렬로 봉합."""
    from sprintable_mcp.server import _flat
    from sprintable_mcp.tools.stories import AddStoryInput, add_story

    w = _flat("add_story", "doc", AddStoryInput, add_story)
    sig = inspect.signature(w)  # 깨지면 여기서 ValueError
    names = list(sig.parameters)
    assert "project_id" in names
    assert names[0] == "title"  # 필수필드가 앞(기본값 없음)
    # 기본값 없는 param 이 기본값 있는 param 보다 앞(inspect.Signature 규칙)
    seen_default = False
    for n in names:
        has_default = sig.parameters[n].default is not inspect.Parameter.empty
        if has_default:
            seen_default = True
        else:
            assert not seen_default, f"non-default '{n}' follows default"


@pytest.mark.anyio
async def test_request_sets_x_project_id_on_override():
    from sprintable_mcp.api_client import (
        client,
        reset_project_override,
        set_project_override,
    )

    _seed_client()
    captured: dict = {}

    class _Resp:
        status_code = 200
        is_success = True
        text = "{}"

        def json(self):
            return {"ok": 1}

    class _FakeClient:
        async def __aenter__(self):
            return self

        async def __aexit__(self, *a):
            return False

        async def request(self, method, url, json=None, params=None, headers=None):
            captured["headers"] = headers
            captured["params"] = params
            captured["json"] = json
            return _Resp()

    with patch("sprintable_mcp.api_client.httpx.AsyncClient", return_value=_FakeClient()):
        # override 없음 → X-Project-Id 미전송·effective=default
        await client.request("GET", "/api/v2/stories", params={"project_id": client.project_id})
        assert "X-Project-Id" not in captured["headers"]
        assert captured["params"]["project_id"] == "DEFAULT"

        # override 있음 → X-Project-Id 전송·effective=override(쿼리·바디)
        tok = set_project_override("OVR")
        await client.request("GET", "/api/v2/stories", params={"project_id": client.project_id})
        assert captured["headers"].get("X-Project-Id") == "OVR"
        assert captured["params"]["project_id"] == "OVR"
        await client.request("POST", "/api/v2/stories", json={"title": "t"})
        assert captured["json"]["project_id"] == "OVR"  # body 주입도 effective
        reset_project_override(tok)
