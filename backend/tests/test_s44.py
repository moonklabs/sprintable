"""S44 AC: Agent Sessions Lifecycle — FastAPI /api/v2/agent-sessions/**"""
from __future__ import annotations

import uuid
from datetime import datetime, timezone
from unittest.mock import AsyncMock, MagicMock, patch

import pytest

ORG_ID = uuid.uuid4()
PROJECT_ID = uuid.uuid4()
AGENT_ID = uuid.uuid4()
SESSION_ID = uuid.uuid4()


@pytest.fixture
def anyio_backend() -> str:
    return "asyncio"


async def _client():
    from app.main import app
    ctx = MagicMock()
    ctx.user_id = str(uuid.uuid4())
    ctx.email = "test@example.com"
    ctx.claims = {"app_metadata": {"org_id": str(ORG_ID), "project_id": str(PROJECT_ID)}, "sub": ctx.user_id}
    mock_session = AsyncMock()
    async def override_db():
        yield mock_session
    async def override_auth():
        return ctx
    from app.dependencies.auth import get_current_user
    from app.dependencies.database import get_db
    app.dependency_overrides[get_db] = override_db
    app.dependency_overrides[get_current_user] = override_auth
    from httpx import ASGITransport, AsyncClient
    return AsyncClient(transport=ASGITransport(app=app), base_url="http://test"), mock_session, app


def _make_session(status: str = "active") -> "AgentSessionResponse":
    from app.schemas.agent_session import AgentSessionResponse
    now = datetime.now(timezone.utc)
    return AgentSessionResponse(
        id=SESSION_ID,
        org_id=ORG_ID,
        project_id=PROJECT_ID,
        agent_id=AGENT_ID,
        persona_id=None,
        deployment_id=None,
        session_key="memo:abc123",
        channel="memo",
        title="Test Session",
        status=status,
        context_window_tokens=None,
        session_metadata={},
        context_snapshot={},
        created_by=None,
        started_at=now,
        last_activity_at=now,
        idle_at=None,
        suspended_at=None,
        ended_at=None,
        terminated_at=None,
        created_at=now,
        updated_at=now,
    )


@pytest.mark.anyio
async def test_list_sessions_200():
    client, session, app = await _client()
    try:
        with patch("app.repositories.agent_session.AgentSessionRepository.list", new_callable=AsyncMock) as mock_list:
            mock_list.return_value = [_make_session()]
            async with client as c:
                resp = await c.get("/api/v2/agent-sessions")
            assert resp.status_code == 200
            body = resp.json()
            assert len(body["data"]["sessions"]) == 1
            assert body["data"]["sessions"][0]["status"] == "active"
            assert body["error"] is None
    finally:
        app.dependency_overrides.clear()


@pytest.mark.anyio
async def test_list_sessions_with_filters_200():
    client, session, app = await _client()
    try:
        with patch("app.repositories.agent_session.AgentSessionRepository.list", new_callable=AsyncMock) as mock_list:
            mock_list.return_value = []
            async with client as c:
                resp = await c.get(f"/api/v2/agent-sessions?agent_id={AGENT_ID}&status=idle&limit=10")
            assert resp.status_code == 200
            assert resp.json()["data"]["sessions"] == []
            mock_list.assert_called_once()
    finally:
        app.dependency_overrides.clear()


@pytest.mark.anyio
async def test_transition_session_active_200():
    client, session, app = await _client()
    try:
        with patch("app.repositories.agent_session.AgentSessionRepository.transition", new_callable=AsyncMock) as mock_tx:
            mock_tx.return_value = _make_session("active")
            async with client as c:
                resp = await c.patch(f"/api/v2/agent-sessions/{SESSION_ID}", json={"status": "active"})
            assert resp.status_code == 200
            body = resp.json()
            assert body["data"]["session"]["status"] == "active"
            assert body["data"]["resumptions"] == []
    finally:
        app.dependency_overrides.clear()


@pytest.mark.anyio
async def test_transition_session_suspended_200():
    client, session, app = await _client()
    try:
        with patch("app.repositories.agent_session.AgentSessionRepository.transition", new_callable=AsyncMock) as mock_tx:
            s = _make_session("suspended")
            s.suspended_at = datetime.now(timezone.utc)
            mock_tx.return_value = s
            async with client as c:
                resp = await c.patch(f"/api/v2/agent-sessions/{SESSION_ID}", json={"status": "suspended", "reason": "manual test"})
            assert resp.status_code == 200
            assert resp.json()["data"]["session"]["status"] == "suspended"
    finally:
        app.dependency_overrides.clear()


@pytest.mark.anyio
async def test_transition_session_not_found_404():
    client, session, app = await _client()
    try:
        from app.repositories.agent_session import AgentSessionError
        with patch("app.repositories.agent_session.AgentSessionRepository.transition", new_callable=AsyncMock) as mock_tx:
            mock_tx.side_effect = AgentSessionError("SESSION_NOT_FOUND", 404, "Session not found")
            async with client as c:
                resp = await c.patch(f"/api/v2/agent-sessions/{SESSION_ID}", json={"status": "active"})
            assert resp.status_code == 404
            assert resp.json()["error"]["code"] == "SESSION_NOT_FOUND"
    finally:
        app.dependency_overrides.clear()


@pytest.mark.anyio
async def test_transition_session_terminated_200():
    client, session, app = await _client()
    try:
        with patch("app.repositories.agent_session.AgentSessionRepository.transition", new_callable=AsyncMock) as mock_tx:
            s = _make_session("terminated")
            s.ended_at = datetime.now(timezone.utc)
            s.terminated_at = datetime.now(timezone.utc)
            mock_tx.return_value = s
            async with client as c:
                resp = await c.patch(f"/api/v2/agent-sessions/{SESSION_ID}", json={"status": "terminated"})
            assert resp.status_code == 200
            assert resp.json()["data"]["session"]["status"] == "terminated"
    finally:
        app.dependency_overrides.clear()
