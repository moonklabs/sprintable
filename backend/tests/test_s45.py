"""S45 AC: HITL Policy + Requests — FastAPI /api/v2/hitl/**"""
from __future__ import annotations

import uuid
from unittest.mock import AsyncMock, MagicMock, patch

import pytest

ORG_ID = uuid.uuid4()
PROJECT_ID = uuid.uuid4()
AGENT_ID = uuid.uuid4()
REQUEST_ID = uuid.uuid4()
USER_ID = uuid.uuid4()


@pytest.fixture
def anyio_backend() -> str:
    return "asyncio"


async def _client():
    from app.main import app
    ctx = MagicMock()
    ctx.user_id = USER_ID
    ctx.email = "test@example.com"
    ctx.claims = {"app_metadata": {"org_id": str(ORG_ID), "project_id": str(PROJECT_ID)}, "sub": str(USER_ID)}
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
    return AsyncClient(transport=ASGITransport(app=app), base_url="http://test"), mock_session, app, ctx


def _make_snapshot_dict():
    return {
        "schema_version": 1,
        "high_risk_actions": [
            {"key": "destructive_change", "severity": "critical", "default_request_type": "approval", "default_timeout_class": "fast", "prompt_label": "Destructive change"},
        ],
        "approval_rules": [
            {"key": "manual_hitl_request", "request_type": "approval", "timeout_class": "standard", "approval_required": True},
        ],
        "timeout_classes": [
            {"key": "standard", "duration_minutes": 1440, "reminder_minutes_before": 60, "escalation_mode": "timeout_memo"},
        ],
        "prompt_summary": "HITL policy\n...",
    }


def _make_request_dict():
    return {
        "id": str(REQUEST_ID),
        "org_id": str(ORG_ID),
        "project_id": str(PROJECT_ID),
        "agent_id": str(AGENT_ID),
        "deployment_id": None,
        "session_id": None,
        "run_id": None,
        "request_type": "approval",
        "title": "Test HITL",
        "prompt": "Please approve",
        "requested_for": str(USER_ID),
        "status": "pending",
        "response_text": None,
        "responded_by": None,
        "responded_at": None,
        "expires_at": None,
        "hitl_metadata": {},
        "created_at": "2026-04-30T00:00:00+00:00",
        "updated_at": "2026-04-30T00:00:00+00:00",
        "agent_name": None,
        "requested_for_name": None,
        "source_memo_id": None,
        "hitl_memo_id": None,
    }


# --- Policy ---

@pytest.mark.anyio
async def test_get_hitl_policy_returns_snapshot():
    client, session, app, ctx = await _client()
    try:
        snapshot = MagicMock()
        snapshot.model_dump.return_value = _make_snapshot_dict()
        with patch("app.repositories.hitl.HitlRepository.get_policy", new_callable=AsyncMock) as mock_get:
            mock_get.return_value = snapshot
            async with client as c:
                resp = await c.get("/api/v2/hitl/policy")
        assert resp.status_code == 200
        body = resp.json()
        assert body["error"] is None
        assert body["data"]["schema_version"] == 1
        assert "approval_rules" in body["data"]
    finally:
        app.dependency_overrides.clear()


@pytest.mark.anyio
async def test_patch_hitl_policy_saves_and_returns():
    client, session, app, ctx = await _client()
    try:
        snapshot = MagicMock()
        snapshot.model_dump.return_value = _make_snapshot_dict()
        with patch("app.repositories.hitl.HitlRepository.save_policy", new_callable=AsyncMock) as mock_save:
            mock_save.return_value = snapshot
            payload = {
                "approval_rules": [{"key": "manual_hitl_request", "request_type": "approval", "timeout_class": "standard", "approval_required": True}],
                "timeout_classes": [{"key": "standard", "duration_minutes": 1440, "reminder_minutes_before": 60, "escalation_mode": "timeout_memo"}],
            }
            async with client as c:
                resp = await c.patch("/api/v2/hitl/policy", json=payload)
        assert resp.status_code == 200
        body = resp.json()
        assert body["error"] is None
        assert body["data"]["schema_version"] == 1
    finally:
        app.dependency_overrides.clear()


@pytest.mark.anyio
async def test_get_hitl_policy_default_when_no_record():
    client, session, app, ctx = await _client()
    try:
        with patch("app.repositories.hitl.HitlRepository.get_policy", new_callable=AsyncMock) as mock_get:
            from app.repositories.hitl import _build_snapshot
            mock_get.return_value = _build_snapshot(None)
            async with client as c:
                resp = await c.get("/api/v2/hitl/policy")
        assert resp.status_code == 200
        body = resp.json()
        assert len(body["data"]["approval_rules"]) == 2
        assert len(body["data"]["timeout_classes"]) == 3
    finally:
        app.dependency_overrides.clear()


# --- Requests ---

@pytest.mark.anyio
async def test_list_hitl_requests_pending():
    client, session, app, ctx = await _client()
    try:
        item = MagicMock()
        item.model_dump.return_value = _make_request_dict()
        with patch("app.repositories.hitl.HitlRepository.list_requests", new_callable=AsyncMock) as mock_list:
            mock_list.return_value = [item]
            async with client as c:
                resp = await c.get("/api/v2/hitl/requests?status=pending")
        assert resp.status_code == 200
        body = resp.json()
        assert body["error"] is None
        assert len(body["data"]) == 1
        assert body["data"][0]["status"] == "pending"
    finally:
        app.dependency_overrides.clear()


@pytest.mark.anyio
async def test_list_hitl_requests_empty():
    client, session, app, ctx = await _client()
    try:
        with patch("app.repositories.hitl.HitlRepository.list_requests", new_callable=AsyncMock) as mock_list:
            mock_list.return_value = []
            async with client as c:
                resp = await c.get("/api/v2/hitl/requests")
        assert resp.status_code == 200
        body = resp.json()
        assert body["data"] == []
    finally:
        app.dependency_overrides.clear()


@pytest.mark.anyio
async def test_resolve_hitl_request_approved():
    client, session, app, ctx = await _client()
    try:
        from datetime import datetime, timezone
        row = MagicMock()
        row.id = REQUEST_ID
        row.status = "approved"
        row.responded_at = datetime(2026, 4, 30, 0, 0, 0, tzinfo=timezone.utc)
        with patch("app.repositories.hitl.HitlRepository.resolve_request", new_callable=AsyncMock) as mock_resolve:
            mock_resolve.return_value = row
            async with client as c:
                resp = await c.patch(f"/api/v2/hitl/requests/{REQUEST_ID}", json={"status": "approved"})
        assert resp.status_code == 200
        body = resp.json()
        assert body["error"] is None
        assert body["data"]["status"] == "approved"
    finally:
        app.dependency_overrides.clear()


@pytest.mark.anyio
async def test_resolve_hitl_request_not_found_404():
    client, session, app, ctx = await _client()
    try:
        with patch("app.repositories.hitl.HitlRepository.resolve_request", new_callable=AsyncMock) as mock_resolve:
            mock_resolve.return_value = None
            async with client as c:
                resp = await c.patch(f"/api/v2/hitl/requests/{uuid.uuid4()}", json={"status": "rejected"})
        assert resp.status_code == 404
        body = resp.json()
        assert body["error"]["code"] == "NOT_FOUND_OR_NOT_PENDING"
    finally:
        app.dependency_overrides.clear()


@pytest.mark.anyio
async def test_resolve_hitl_request_invalid_status_422():
    client, session, app, ctx = await _client()
    try:
        async with client as c:
            resp = await c.patch(f"/api/v2/hitl/requests/{REQUEST_ID}", json={"status": "pending"})
        assert resp.status_code == 422
    finally:
        app.dependency_overrides.clear()
