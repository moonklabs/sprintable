"""S42 AC: Agent Personas CRUD — FastAPI /api/v2/agent-personas/**"""
from __future__ import annotations

import uuid
from datetime import datetime, timezone
from unittest.mock import AsyncMock, MagicMock, patch

import pytest

ORG_ID = uuid.uuid4()
PROJECT_ID = uuid.uuid4()
AGENT_ID = uuid.uuid4()
PERSONA_ID = uuid.uuid4()


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


def _make_persona_summary():
    from app.schemas.agent_persona import PersonaSummaryResponse
    now = datetime.now(timezone.utc)
    return PersonaSummaryResponse(
        id=PERSONA_ID,
        org_id=ORG_ID,
        project_id=PROJECT_ID,
        agent_id=AGENT_ID,
        name="Test Persona",
        slug="test-persona",
        description=None,
        system_prompt="You are a helpful assistant.",
        style_prompt=None,
        resolved_system_prompt="You are a helpful assistant.",
        resolved_style_prompt=None,
        model=None,
        config={},
        is_builtin=False,
        is_default=True,
        is_in_use=False,
        tool_allowlist=[],
        base_persona_id=None,
        base_persona=None,
        version_metadata={},
        permission_boundary={"tool_allowlist": [], "restrictions": []},
        change_history=[],
        created_by=None,
        created_at=now,
        updated_at=now,
    )


@pytest.mark.anyio
async def test_list_personas_200():
    client, session, app = await _client()
    try:
        with patch("app.repositories.agent_persona.AgentPersonaRepository.list", new_callable=AsyncMock) as mock_list:
            mock_list.return_value = [_make_persona_summary()]
            async with client as c:
                resp = await c.get(f"/api/v2/agent-personas?agent_id={AGENT_ID}")
            assert resp.status_code == 200
            body = resp.json()
            assert len(body["data"]) == 1
            assert body["data"][0]["name"] == "Test Persona"
            assert body["error"] is None
    finally:
        app.dependency_overrides.clear()


@pytest.mark.anyio
async def test_get_persona_200():
    client, session, app = await _client()
    try:
        with patch("app.repositories.agent_persona.AgentPersonaRepository.get", new_callable=AsyncMock) as mock_get:
            mock_get.return_value = _make_persona_summary()
            async with client as c:
                resp = await c.get(f"/api/v2/agent-personas/{PERSONA_ID}")
            assert resp.status_code == 200
            body = resp.json()
            assert body["data"]["slug"] == "test-persona"
    finally:
        app.dependency_overrides.clear()


@pytest.mark.anyio
async def test_get_persona_not_found_404():
    client, session, app = await _client()
    try:
        with patch("app.repositories.agent_persona.AgentPersonaRepository.get", new_callable=AsyncMock) as mock_get:
            mock_get.return_value = None
            async with client as c:
                resp = await c.get(f"/api/v2/agent-personas/{PERSONA_ID}")
            assert resp.status_code == 404
            assert resp.json()["error"]["code"] == "NOT_FOUND"
    finally:
        app.dependency_overrides.clear()


@pytest.mark.anyio
async def test_create_persona_201():
    client, session, app = await _client()
    try:
        with patch("app.repositories.agent_persona.AgentPersonaRepository.create", new_callable=AsyncMock) as mock_create:
            mock_create.return_value = _make_persona_summary()
            payload = {"agent_id": str(AGENT_ID), "name": "Test Persona", "system_prompt": "You are a helpful assistant."}
            async with client as c:
                resp = await c.post("/api/v2/agent-personas", json=payload)
            assert resp.status_code == 201
            body = resp.json()
            assert body["data"]["name"] == "Test Persona"
            assert body["error"] is None
    finally:
        app.dependency_overrides.clear()


@pytest.mark.anyio
async def test_update_persona_200():
    client, session, app = await _client()
    try:
        with patch("app.repositories.agent_persona.AgentPersonaRepository.update", new_callable=AsyncMock) as mock_update:
            updated = _make_persona_summary()
            updated.name = "Updated Persona"
            mock_update.return_value = updated
            async with client as c:
                resp = await c.patch(f"/api/v2/agent-personas/{PERSONA_ID}", json={"name": "Updated Persona"})
            assert resp.status_code == 200
            body = resp.json()
            assert body["data"]["name"] == "Updated Persona"
    finally:
        app.dependency_overrides.clear()


@pytest.mark.anyio
async def test_delete_persona_200():
    client, session, app = await _client()
    try:
        with patch("app.repositories.agent_persona.AgentPersonaRepository.delete", new_callable=AsyncMock) as mock_del:
            mock_del.return_value = True
            async with client as c:
                resp = await c.delete(f"/api/v2/agent-personas/{PERSONA_ID}")
            assert resp.status_code == 200
            body = resp.json()
            assert body["data"]["ok"] is True
    finally:
        app.dependency_overrides.clear()


@pytest.mark.anyio
async def test_delete_builtin_persona_403():
    client, session, app = await _client()
    try:
        with patch("app.repositories.agent_persona.AgentPersonaRepository.delete", new_callable=AsyncMock) as mock_del:
            mock_del.side_effect = ValueError("Built-in personas cannot be deleted")
            async with client as c:
                resp = await c.delete(f"/api/v2/agent-personas/{PERSONA_ID}")
            assert resp.status_code == 403
            assert "Built-in" in resp.json()["error"]["message"]
    finally:
        app.dependency_overrides.clear()


@pytest.mark.anyio
async def test_seed_builtin_200():
    client, session, app = await _client()
    try:
        with patch("app.repositories.agent_persona.AgentPersonaRepository.seed_builtin", new_callable=AsyncMock) as mock_seed:
            mock_seed.return_value = {"seeded": True}
            async with client as c:
                resp = await c.post(f"/api/v2/agent-personas/seed?agent_id={AGENT_ID}")
            assert resp.status_code == 200
            assert resp.json()["data"]["seeded"] is True
    finally:
        app.dependency_overrides.clear()
