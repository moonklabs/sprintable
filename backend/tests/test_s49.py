"""S49 AC: Sprint 7 통합 테스트 + Phase B 완주 검증 — S41~S48 라우터 등록 확인."""
from __future__ import annotations

import uuid
from unittest.mock import AsyncMock, MagicMock

import pytest


# ─── helpers ──────────────────────────────────────────────────────────────────

@pytest.fixture
def anyio_backend() -> str:
    return "asyncio"


def _make_client_fixture():
    """test_client conftest fixture 재사용 가능한 팩토리."""
    pass


# ─── Phase B route registration smoke ─────────────────────────────────────────

@pytest.mark.anyio
async def test_phase_b_all_routes_registered():
    """S41~S47 라우터가 FastAPI app에 모두 등록됐는지 확인 (route path 검사)."""
    from app.main import app
    paths = {route.path for route in app.routes}

    # S41 — Agent Deployments
    assert "/api/v2/agent-deployments" in paths
    # S42 — Agent Personas
    assert "/api/v2/agent-personas" in paths
    # S43 — Agent Routing Rules
    assert "/api/v2/agent-routing-rules" in paths
    # S47 — Bridge
    assert "/api/v2/bridge/slack/events" in paths
    assert "/api/v2/bridge/slack/interactions" in paths
    assert "/api/v2/bridge/teams/events" in paths


@pytest.mark.anyio
async def test_phase_b_health_check(test_client, mock_session):
    """Phase B FastAPI 서버 health check."""
    mock_session.execute = AsyncMock(return_value=None)
    resp = await test_client.get("/api/v2/health")
    assert resp.status_code == 200
    assert resp.json()["status"] == "ok"


def _make_full_auth_ctx(org_id: uuid.UUID, project_id: uuid.UUID) -> MagicMock:
    ctx = MagicMock()
    ctx.user_id = uuid.uuid4()
    ctx.claims = {"app_metadata": {"org_id": str(org_id), "project_id": str(project_id)}}
    return ctx


async def _full_client(mock_session: AsyncMock, org_id: uuid.UUID, project_id: uuid.UUID):
    from app.main import app
    from app.dependencies.auth import get_current_user
    from app.dependencies.database import get_db
    from httpx import ASGITransport, AsyncClient

    ctx = _make_full_auth_ctx(org_id, project_id)

    async def _db():
        yield mock_session

    async def _auth():
        return ctx

    app.dependency_overrides[get_db] = _db
    app.dependency_overrides[get_current_user] = _auth
    return AsyncClient(transport=ASGITransport(app=app), base_url="http://test"), app


# ─── S41 — Agent Deployments ──────────────────────────────────────────────────

@pytest.mark.anyio
async def test_s41_list_deployments_integration(mock_session):
    """GET /api/v2/agent-deployments — envelope 포함 200."""
    from unittest.mock import patch
    client, app = await _full_client(mock_session, uuid.uuid4(), uuid.uuid4())
    try:
        with patch(
            "app.services.deployment_lifecycle.DeploymentLifecycleService.build_cards",
            new_callable=AsyncMock,
            return_value=[],
        ):
            async with client as c:
                resp = await c.get("/api/v2/agent-deployments")
        assert resp.status_code == 200
        assert resp.json()["error"] is None
        assert isinstance(resp.json()["data"], list)
    finally:
        app.dependency_overrides.clear()


# ─── S42 — Agent Personas ─────────────────────────────────────────────────────

@pytest.mark.anyio
async def test_s42_list_personas_integration(mock_session):
    """GET /api/v2/agent-personas — 200 + list."""
    client, app = await _full_client(mock_session, uuid.uuid4(), uuid.uuid4())
    try:
        mock_result = MagicMock()
        mock_result.scalars.return_value.all.return_value = []
        mock_session.execute = AsyncMock(return_value=mock_result)
        agent_id = uuid.uuid4()
        async with client as c:
            resp = await c.get(f"/api/v2/agent-personas?agent_id={agent_id}")
        assert resp.status_code == 200
        assert resp.json()["error"] is None
    finally:
        app.dependency_overrides.clear()


# ─── S43 — Agent Routing Rules ────────────────────────────────────────────────

@pytest.mark.anyio
async def test_s43_list_routing_rules_integration(mock_session):
    """GET /api/v2/agent-routing-rules — 200 + list."""
    client, app = await _full_client(mock_session, uuid.uuid4(), uuid.uuid4())
    try:
        mock_result = MagicMock()
        mock_result.scalars.return_value.all.return_value = []
        mock_session.execute = AsyncMock(return_value=mock_result)
        async with client as c:
            resp = await c.get("/api/v2/agent-routing-rules")
        assert resp.status_code == 200
        assert resp.json()["error"] is None
    finally:
        app.dependency_overrides.clear()


# ─── S47 — Bridge ─────────────────────────────────────────────────────────────

@pytest.mark.anyio
async def test_s47_slack_events_url_verification_integration(test_client, mock_session):
    """POST /api/v2/bridge/slack/events — URL verification challenge."""
    import hashlib
    import hmac
    import json
    import os
    import time

    secret = "integration-test-secret"
    body = json.dumps({"type": "url_verification", "challenge": "testchallenge"})
    ts = str(int(time.time()))
    sig = "v0=" + hmac.new(secret.encode(), f"v0:{ts}:{body}".encode(), hashlib.sha256).hexdigest()

    with __import__("unittest.mock", fromlist=["patch"]).patch.dict(os.environ, {"SLACK_SIGNING_SECRET": secret}):
        resp = await test_client.post(
            "/api/v2/bridge/slack/events",
            content=body,
            headers={"x-slack-signature": sig, "x-slack-request-timestamp": ts, "content-type": "application/json"},
        )
    assert resp.status_code == 200
    assert resp.json()["challenge"] == "testchallenge"


@pytest.mark.anyio
async def test_s47_teams_events_conversation_update_integration(test_client, mock_session):
    """POST /api/v2/bridge/teams/events — conversationUpdate 항상 ok."""
    resp = await test_client.post(
        "/api/v2/bridge/teams/events",
        json={"type": "conversationUpdate"},
    )
    assert resp.status_code == 200
    assert resp.json()["ok"] is True


# ─── Phase B 라우터 auth 체크 ─────────────────────────────────────────────────

@pytest.mark.anyio
async def test_phase_b_auth_required_without_claims(mock_session):
    """auth_ctx에 app_metadata 없으면 403 반환 (envelope 검증)."""
    from app.main import app
    from app.dependencies.auth import get_current_user
    from app.dependencies.database import get_db
    from httpx import ASGITransport, AsyncClient

    ctx = MagicMock()
    ctx.user_id = str(uuid.uuid4())
    ctx.claims = {}

    async def _db():
        yield mock_session

    async def _auth():
        return ctx

    app.dependency_overrides[get_db] = _db
    app.dependency_overrides[get_current_user] = _auth

    try:
        async with AsyncClient(transport=ASGITransport(app=app), base_url="http://test") as c:
            resp = await c.get("/api/v2/agent-deployments")
        assert resp.status_code == 403
        assert resp.json()["error"]["code"] == "FORBIDDEN"
    finally:
        app.dependency_overrides.clear()
