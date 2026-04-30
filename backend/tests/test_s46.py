"""S46 AC: Workflow Versions + Rollback — FastAPI /api/v2/workflow-versions/**"""
from __future__ import annotations

import uuid
from unittest.mock import AsyncMock, MagicMock, patch

import pytest

ORG_ID = uuid.uuid4()
PROJECT_ID = uuid.uuid4()
VERSION_ID = uuid.uuid4()
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


def _make_version_dict():
    return {
        "id": str(VERSION_ID),
        "org_id": str(ORG_ID),
        "project_id": str(PROJECT_ID),
        "version": 3,
        "snapshot": [],
        "change_summary": {"added_rules": 1, "removed_rules": 0, "changed_rules": 0},
        "created_by": str(USER_ID),
        "created_at": "2026-04-30T00:00:00+00:00",
    }


def _make_rule_dict():
    return {
        "id": str(uuid.uuid4()),
        "org_id": str(ORG_ID),
        "project_id": str(PROJECT_ID),
        "agent_id": str(uuid.uuid4()),
        "persona_id": None,
        "deployment_id": None,
        "name": "Rule A",
        "priority": 100,
        "match_type": "event",
        "conditions": {"memo_type": []},
        "action": {"auto_reply_mode": "process_and_report", "forward_to_agent_id": None},
        "target_runtime": "openclaw",
        "target_model": None,
        "is_enabled": True,
        "metadata": {},
        "created_by": str(USER_ID),
        "created_at": "2026-04-30T00:00:00+00:00",
        "updated_at": "2026-04-30T00:00:00+00:00",
    }


@pytest.mark.anyio
async def test_list_workflow_versions_200():
    client, session, app, ctx = await _client()
    try:
        v = MagicMock()
        v.model_dump.return_value = _make_version_dict()
        with patch("app.repositories.workflow_version.WorkflowVersionRepository.list", new_callable=AsyncMock) as mock_list:
            mock_list.return_value = [v]
            async with client as c:
                resp = await c.get("/api/v2/workflow-versions")
        assert resp.status_code == 200
        body = resp.json()
        assert body["error"] is None
        assert len(body["data"]) == 1
        assert body["data"][0]["version"] == 3
    finally:
        app.dependency_overrides.clear()


@pytest.mark.anyio
async def test_list_workflow_versions_empty():
    client, session, app, ctx = await _client()
    try:
        with patch("app.repositories.workflow_version.WorkflowVersionRepository.list", new_callable=AsyncMock) as mock_list:
            mock_list.return_value = []
            async with client as c:
                resp = await c.get("/api/v2/workflow-versions")
        assert resp.status_code == 200
        assert resp.json()["data"] == []
    finally:
        app.dependency_overrides.clear()


@pytest.mark.anyio
async def test_rollback_to_version_200():
    client, session, app, ctx = await _client()
    try:
        rule = MagicMock()
        rule.model_dump.return_value = _make_rule_dict()
        with patch("app.repositories.workflow_version.WorkflowVersionRepository.rollback", new_callable=AsyncMock) as mock_rb:
            mock_rb.return_value = [rule]
            async with client as c:
                resp = await c.post(f"/api/v2/workflow-versions/{VERSION_ID}/rollback")
        assert resp.status_code == 200
        body = resp.json()
        assert body["error"] is None
        assert len(body["data"]) == 1
        assert body["data"][0]["name"] == "Rule A"
    finally:
        app.dependency_overrides.clear()


@pytest.mark.anyio
async def test_rollback_to_version_not_found_404():
    client, session, app, ctx = await _client()
    try:
        with patch("app.repositories.workflow_version.WorkflowVersionRepository.rollback", new_callable=AsyncMock) as mock_rb:
            mock_rb.return_value = None
            async with client as c:
                resp = await c.post(f"/api/v2/workflow-versions/{uuid.uuid4()}/rollback")
        assert resp.status_code == 404
        body = resp.json()
        assert body["error"]["code"] == "NOT_FOUND"
    finally:
        app.dependency_overrides.clear()


@pytest.mark.anyio
async def test_list_workflow_versions_no_auth_403():
    client, session, app, ctx = await _client()
    ctx.claims = {}
    try:
        with patch("app.repositories.workflow_version.WorkflowVersionRepository.list", new_callable=AsyncMock) as mock_list:
            mock_list.return_value = []
            async with client as c:
                resp = await c.get("/api/v2/workflow-versions")
        assert resp.status_code == 403
    finally:
        app.dependency_overrides.clear()
