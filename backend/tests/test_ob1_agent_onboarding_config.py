"""OB-1: agent_onboarding_config SSOT generator 가드 (블루프린트 §2/§7).

AC1: stdio .mcp.json(type=stdio·uvx·sprintable-mcp·env{SPRINTABLE_API_URL=backend-direct,
AGENT_API_KEY})·AGENT_ID/WS_URL/port 미포함. backend-direct URL=env(FASTAPI_URL)·CF 금지·local fallback.
"""
from __future__ import annotations

import json

import pytest

from app.services import agent_onboarding_config as gen


def test_stdio_shape_with_key():
    cfg = gen.build_agent_mcp_config(api_key_plaintext="sk_live_abc")
    server = cfg["mcpServers"]["sprintable"]
    assert server["type"] == "stdio"
    assert server["command"] == "uvx"
    assert server["args"] == ["sprintable-mcp"]
    assert server["env"]["AGENT_API_KEY"] == "sk_live_abc"
    assert "SPRINTABLE_API_URL" in server["env"]


def test_no_phantom_keys():
    """AC1: SPRINTABLE_AGENT_ID/WS_URL/port 미포함(phantom 키 0)."""
    cfg = gen.build_agent_mcp_config(api_key_plaintext="k")
    blob = json.dumps(cfg)
    for phantom in ("SPRINTABLE_AGENT_ID", "WS_URL", "WEBSOCKET", "\"port\"", "fakechat"):
        assert phantom not in blob, f"{phantom} 가 아티팩트에 노출되면 안 됨"
    server = cfg["mcpServers"]["sprintable"]
    assert set(server.keys()) == {"type", "command", "args", "env"}


def test_key_omitted_when_absent():
    """api_key 없으면 AGENT_API_KEY 키 생략(미발급 시 비노출·AC4 호환)."""
    cfg = gen.build_agent_mcp_config(api_key_plaintext=None)
    env = cfg["mcpServers"]["sprintable"]["env"]
    assert "AGENT_API_KEY" not in env
    assert "SPRINTABLE_API_URL" in env  # URL 은 항상


def test_url_from_fastapi_url_env(monkeypatch):
    """backend-direct URL = FASTAPI_URL env(배포 주입)·trailing slash 제거."""
    monkeypatch.setenv("FASTAPI_URL", "https://sprintable-backend-dev-x.run.app/")
    cfg = gen.build_agent_mcp_config(api_key_plaintext="k")
    assert cfg["mcpServers"]["sprintable"]["env"]["SPRINTABLE_API_URL"] == \
        "https://sprintable-backend-dev-x.run.app"


def test_url_local_fallback(monkeypatch):
    """env 미설정 → localhost fallback(로컬 dev)."""
    monkeypatch.delenv("FASTAPI_URL", raising=False)
    monkeypatch.delenv("SPRINTABLE_API_URL", raising=False)
    assert gen.resolve_backend_direct_url() == "http://localhost:8000"


def test_url_sprintable_api_url_fallback(monkeypatch):
    """FASTAPI_URL 없고 SPRINTABLE_API_URL 있으면 그걸 사용(2순위)."""
    monkeypatch.delenv("FASTAPI_URL", raising=False)
    monkeypatch.setenv("SPRINTABLE_API_URL", "https://backend-direct.run.app")
    assert gen.resolve_backend_direct_url() == "https://backend-direct.run.app"


# ─── AC3: GET /agents/{id}/connection-artifact 엔드포인트 ──────────────────────

import uuid  # noqa: E402
from types import SimpleNamespace  # noqa: E402
from unittest.mock import AsyncMock, MagicMock  # noqa: E402


def _db_returning(member):
    res = MagicMock()
    res.scalar_one_or_none.return_value = member
    db = AsyncMock()
    db.execute = AsyncMock(return_value=res)
    return db


@pytest.mark.anyio
async def test_connection_artifact_returns_stdio_with_placeholder():
    from app.routers.agents import get_agent_connection_artifact

    agent_id = uuid.uuid4()
    db = _db_returning(SimpleNamespace(id=agent_id))
    out = await get_agent_connection_artifact(
        agent_id, runtime="claude-code", session=db, auth=MagicMock(), org_id=uuid.uuid4()
    )
    # BE↔FE 계약 락: {filename, content(=문자열), agent_id, runtime}
    assert out["filename"] == ".mcp.json"
    assert out["agent_id"] == str(agent_id)
    assert out["runtime"] == "claude-code"
    assert isinstance(out["content"], str), "content 는 paste-ready json 문자열이어야(dict 아님)"
    parsed = json.loads(out["content"])
    server = parsed["mcpServers"]["sprintable"]
    assert server["type"] == "stdio"
    assert server["env"]["AGENT_API_KEY"] == "<YOUR_AGENT_API_KEY>"  # placeholder


@pytest.mark.anyio
async def test_connection_artifact_unsupported_runtime_400():
    from fastapi import HTTPException

    from app.routers.agents import get_agent_connection_artifact
    with pytest.raises(HTTPException) as ei:
        await get_agent_connection_artifact(
            uuid.uuid4(), runtime="cursor", session=AsyncMock(), auth=MagicMock(), org_id=uuid.uuid4()
        )
    assert ei.value.status_code == 400


@pytest.mark.anyio
async def test_connection_artifact_not_found_404():
    from fastapi import HTTPException

    from app.routers.agents import get_agent_connection_artifact
    db = _db_returning(None)
    with pytest.raises(HTTPException) as ei:
        await get_agent_connection_artifact(
            uuid.uuid4(), runtime="claude-code", session=db, auth=MagicMock(), org_id=uuid.uuid4()
        )
    assert ei.value.status_code == 404
