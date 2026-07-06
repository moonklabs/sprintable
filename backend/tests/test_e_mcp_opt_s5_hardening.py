"""E-MCP-OPT S5 (34e69685): S2+S3 QA MINOR 하드닝 모음.

#4: verify-connection — project 미배정 에이전트는 transport 무관 동일하게 400(http 조기 return이
    이 가드보다 먼저였던 비대칭 수정).
#5: 첫인증 텔레메트리(_persist_first_auth_seen) transport 하드코딩 제거 — MCP 클라이언트 자기신고
    (X-MCP-Transport 헤더) 기반으로 동적화.
"""
from __future__ import annotations

import uuid
from types import SimpleNamespace
from unittest.mock import AsyncMock, MagicMock, patch

import pytest

import app.routers.agents as ag


@pytest.fixture
def anyio_backend():
    return "asyncio"


def _scalar(v):
    r = MagicMock()
    r.scalar_one_or_none.return_value = v
    return r


# ── #4: project 미배정 → transport 무관 동일 400 ──────────────────────────────
@pytest.mark.anyio
async def test_verify_connection_unassigned_agent_400_via_stdio():
    member = SimpleNamespace(id=uuid.uuid4(), project_id=None)
    db = AsyncMock()
    db.execute = AsyncMock(return_value=_scalar(member))
    from fastapi import HTTPException
    with patch.object(ag, "assert_agent_owner", new=AsyncMock(return_value=member)):
        with pytest.raises(HTTPException) as ei:
            await ag.verify_agent_connection(
                member.id, transport=None, session=db, auth=MagicMock(user_id=str(uuid.uuid4())), org_id=uuid.uuid4(),
            )
    assert ei.value.status_code == 400


@pytest.mark.anyio
async def test_verify_connection_unassigned_agent_400_via_http_too():
    """회귀 가드 — 이전엔 http 조기 return이 이 가드를 건너뛰어 200이 났었다(까심 QA #4)."""
    member = SimpleNamespace(id=uuid.uuid4(), project_id=None)
    db = AsyncMock()
    db.execute = AsyncMock(return_value=_scalar(member))
    from fastapi import HTTPException
    with patch.object(ag, "assert_agent_owner", new=AsyncMock(return_value=member)):
        with pytest.raises(HTTPException) as ei:
            await ag.verify_agent_connection(
                member.id, transport="http", session=db, auth=MagicMock(user_id=str(uuid.uuid4())), org_id=uuid.uuid4(),
            )
    assert ei.value.status_code == 400


@pytest.mark.anyio
async def test_verify_connection_assigned_agent_http_still_skips_sse(monkeypatch):
    """project 배정된 에이전트는 http에서 여전히 합성이벤트/wake 스킵(#4가 이 동작을 안 건드림)."""
    member = SimpleNamespace(id=uuid.uuid4(), project_id=uuid.uuid4())
    db = AsyncMock()
    db.execute = AsyncMock(return_value=_scalar(member))
    with patch.object(ag, "assert_agent_owner", new=AsyncMock(return_value=member)), \
         patch.object(ag, "start_verification", new=AsyncMock()) as start, \
         patch.object(ag, "get_verification_state", new=AsyncMock(
             return_value={"verified": True, "rail": [], "verify_seq": None},
         )), \
         patch("app.routers.agent_gateway.wake_agent", new=MagicMock()) as wake:
        out = await ag.verify_agent_connection(
            member.id, transport="http", session=db, auth=MagicMock(user_id=str(uuid.uuid4())), org_id=uuid.uuid4(),
        )
    assert out["verified"] is True
    start.assert_not_awaited()
    wake.assert_not_called()


# ── #5: 첫인증 텔레메트리 transport 동적화 ────────────────────────────────────
class _FakeSession:
    async def __aenter__(self):
        return self
    async def __aexit__(self, *a):
        return False
    async def execute(self, *a, **kw):
        m = MagicMock()
        m.first.return_value = None  # dedup: 아직 기록 없음
        return m
    async def commit(self):
        return None


@pytest.mark.anyio
async def test_persist_first_auth_seen_uses_passed_transport():
    from app.dependencies import auth as authmod

    captured = {}

    async def _fake_record(s, *, event, agent_id, org_id, project_id, runtime, transport):
        captured["transport"] = transport

    with patch("app.core.database.async_session_factory", new=lambda: _FakeSession()), \
         patch("app.services.onboarding_funnel.record_onboarding_event", new=_fake_record):
        await authmod._persist_first_auth_seen(uuid.uuid4(), None, None, transport="http")
    assert captured["transport"] == "http"


@pytest.mark.anyio
async def test_persist_first_auth_seen_falls_back_to_stdio_when_no_header():
    """회귀 가드 — 헤더 미전송(구버전 클라이언트 등) 시 기존과 동일하게 'stdio'."""
    from app.dependencies import auth as authmod

    captured = {}

    async def _fake_record(s, *, event, agent_id, org_id, project_id, runtime, transport):
        captured["transport"] = transport

    with patch("app.core.database.async_session_factory", new=lambda: _FakeSession()), \
         patch("app.services.onboarding_funnel.record_onboarding_event", new=_fake_record):
        await authmod._persist_first_auth_seen(uuid.uuid4(), None, None, transport=None)
    assert captured["transport"] == "stdio"


@pytest.mark.anyio
async def test_get_current_user_passes_x_mcp_transport_header_through():
    from app.dependencies.auth import get_current_user

    with patch("app.dependencies.auth._resolve_api_key", new=AsyncMock()) as resolve:
        await get_current_user(
            credentials=None, x_agent_api_key="sk_live_abc", x_mcp_transport="http",
            db=AsyncMock(),
        )
    resolve.assert_awaited_once_with("sk_live_abc", resolve.await_args.args[1], transport="http")


def test_mcp_client_sends_x_mcp_transport_header(monkeypatch):
    """sprintable_mcp 쪽 — 매 요청마다 자기신고 헤더가 실제로 실린다(both transport 값)."""
    from sprintable_mcp import api_client as ac
    from sprintable_mcp.config import settings as mcp_settings

    monkeypatch.setattr(mcp_settings, "mcp_transport", "http", raising=False)
    client = ac.SprintableClient()
    client.configure("https://x", "envkey")

    captured = {}

    async def _fake_request(method, url, **kw):
        captured["headers"] = kw.get("headers", {})
        class R:
            status_code = 200
            is_success = True
            headers = {"content-type": "application/json"}
            def json(self): return {}
            @property
            def text(self): return "{}"
        return R()

    import asyncio
    from unittest.mock import patch as _patch
    with _patch("httpx.AsyncClient.request", new=AsyncMock(side_effect=_fake_request)):
        asyncio.run(client.get("/x"))
    assert captured["headers"]["X-MCP-Transport"] == "http"
