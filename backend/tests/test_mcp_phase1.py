"""E-MCP-PYTHON Phase 1 통합 검증 — S1-1~S1-4."""
from __future__ import annotations

import json
import uuid
from datetime import datetime, timezone
from unittest.mock import AsyncMock, MagicMock, patch

import pytest

from sprintable_mcp.api_client import SprintableApiError, SprintableClient
from sprintable_mcp.response import err, ok


# ─── AC1/AC2: env fail-fast ────────────────────────────────────────────────

def test_configure_raises_without_api_url():
    c = SprintableClient()
    with pytest.raises(ValueError, match="api_url"):
        c.configure("", "sk_live_test")


def test_configure_raises_without_api_key():
    c = SprintableClient()
    with pytest.raises(ValueError, match="api_key"):
        c.configure("https://api.sprintable.ai", "")


# ─── AC3: 401 → SprintableApiError(status=401) ────────────────────────────

@pytest.mark.anyio
async def test_resolve_auth_context_401():
    c = SprintableClient()
    c.configure("https://api.sprintable.ai", "sk_invalid")

    mock_resp = MagicMock()
    mock_resp.is_success = False
    mock_resp.status_code = 401
    mock_resp.json.return_value = {"error": "Unauthorized"}

    with patch("httpx.AsyncClient.request", new_callable=AsyncMock, return_value=mock_resp):
        with pytest.raises(SprintableApiError) as exc_info:
            await c.resolve_auth_context()
    assert exc_info.value.status == 401


# ─── S1-3: resolve_auth_context 정상 캐시 ──────────────────────────────────

@pytest.mark.anyio
async def test_resolve_auth_context_caches_ids():
    c = SprintableClient()
    c.configure("https://api.sprintable.ai", "sk_live_test")

    member_id = str(uuid.uuid4())
    org_id = str(uuid.uuid4())
    project_id = str(uuid.uuid4())

    mock_resp = MagicMock()
    mock_resp.is_success = True
    mock_resp.json.return_value = {
        "member_id": member_id,
        "org_id": org_id,
        "project_id": project_id,
    }

    with patch("httpx.AsyncClient.request", new_callable=AsyncMock, return_value=mock_resp):
        result = await c.resolve_auth_context()

    assert c.member_id == member_id
    assert c.org_id == org_id
    assert c.project_id == project_id
    assert result == {"member_id": member_id, "org_id": org_id, "project_id": project_id}


# ─── S1-3: context 자동 주입 ───────────────────────────────────────────────

@pytest.mark.anyio
async def test_post_injects_context_fields():
    c = SprintableClient()
    c.configure("https://api.sprintable.ai", "sk_live_test")
    c._org_id = "org-123"
    c._project_id = "proj-456"
    c._member_id = "member-789"

    captured: dict = {}

    mock_resp = MagicMock()
    mock_resp.is_success = True
    mock_resp.json.return_value = {"data": {"id": "story-1"}}

    async def fake_request(method, url, **kwargs):
        captured.update(kwargs.get("json", {}))
        return mock_resp

    with patch("httpx.AsyncClient.request", new_callable=AsyncMock, side_effect=fake_request):
        await c.post("/api/v2/stories", json={"title": "Test"})

    assert captured["org_id"] == "org-123"
    assert captured["project_id"] == "proj-456"
    assert captured["created_by"] == "member-789"


# ─── S1-4: ok() 포맷 ───────────────────────────────────────────────────────

def test_ok_returns_text_content():
    result = ok({"key": "value"})
    assert len(result) == 1
    assert result[0].type == "text"
    parsed = json.loads(result[0].text)
    assert parsed == {"key": "value"}


def test_ok_serializes_datetime():
    dt = datetime(2026, 5, 18, 8, 0, 0, tzinfo=timezone.utc)
    result = ok({"ts": dt})
    parsed = json.loads(result[0].text)
    assert parsed["ts"] == "2026-05-18T08:00:00+00:00"


def test_ok_serializes_uuid():
    uid = uuid.UUID("12345678-1234-5678-1234-567812345678")
    result = ok({"id": uid})
    parsed = json.loads(result[0].text)
    assert parsed["id"] == "12345678-1234-5678-1234-567812345678"


# ─── S1-4: err() 포맷 ──────────────────────────────────────────────────────

def test_err_returns_call_tool_result_with_is_error():
    result = err("something went wrong")
    assert result.isError is True
    assert len(result.content) == 1
    assert result.content[0].type == "text"
    assert result.content[0].text == "Error: something went wrong"
