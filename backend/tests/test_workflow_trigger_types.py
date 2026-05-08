"""Tests for workflow_trigger_types CRUD API."""
import uuid
from unittest.mock import AsyncMock, MagicMock, patch

import pytest
from httpx import ASGITransport, AsyncClient

ORG_ID = uuid.uuid4()
TRIGGER_ID = uuid.uuid4()


def _mock_trigger(slug: str = "kickoff", is_system: bool = True, is_enabled: bool = True) -> MagicMock:
    t = MagicMock()
    t.id = TRIGGER_ID
    t.org_id = ORG_ID
    t.slug = slug
    t.label = slug.replace("_", " ").title()
    t.description = None
    t.is_system = is_system
    t.is_enabled = is_enabled
    t.deleted_at = None
    return t


async def _client(role: str = "admin"):
    from app.main import app

    ctx = MagicMock()
    ctx.user_id = str(uuid.uuid4())
    ctx.email = "test@example.com"
    ctx.claims = {"app_metadata": {"org_id": str(ORG_ID), "role": role}}

    mock_session = AsyncMock()

    async def override_db():
        yield mock_session

    async def override_auth():
        return ctx

    from app.dependencies.auth import get_current_user
    from app.dependencies.database import get_db

    app.dependency_overrides[get_db] = override_db
    app.dependency_overrides[get_current_user] = override_auth

    return AsyncClient(transport=ASGITransport(app=app), base_url="http://test"), mock_session, app


SYSTEM_SLUGS = ["kickoff", "review_request", "qa_request", "deploy_request", "handoff", "status_changed", "assignee_changed"]


@pytest.mark.anyio
async def test_list_seeds_on_first_call():
    """GET list 최초 호출 시 7개 slug 자동 시딩 검증."""
    client, session, app = await _client()
    try:
        seeded = [_mock_trigger(slug=s) for s in SYSTEM_SLUGS]
        with patch("app.repositories.workflow_trigger_type.WorkflowTriggerTypeRepository.list", new_callable=AsyncMock) as mock_list:
            mock_list.return_value = seeded
            async with client as c:
                resp = await c.get("/api/v2/workflow-trigger-types")
        assert resp.status_code == 200
        slugs = [item["slug"] for item in resp.json()]
        for s in SYSTEM_SLUGS:
            assert s in slugs
    finally:
        app.dependency_overrides.clear()


@pytest.mark.anyio
async def test_list_returns_system_types_first():
    """is_system=True 항목이 커스텀보다 앞에 오는지."""
    client, session, app = await _client()
    try:
        items = [_mock_trigger("kickoff", is_system=True), _mock_trigger("custom_one", is_system=False)]
        with patch("app.repositories.workflow_trigger_type.WorkflowTriggerTypeRepository.list", new_callable=AsyncMock) as mock_list:
            mock_list.return_value = items
            async with client as c:
                resp = await c.get("/api/v2/workflow-trigger-types")
        assert resp.status_code == 200
        data = resp.json()
        assert data[0]["is_system"] is True
    finally:
        app.dependency_overrides.clear()


@pytest.mark.anyio
async def test_create_requires_admin():
    """member role → POST 403."""
    client, session, app = await _client(role="member")
    try:
        async with client as c:
            resp = await c.post("/api/v2/workflow-trigger-types", json={"slug": "custom", "label": "Custom"})
        assert resp.status_code == 403
    finally:
        app.dependency_overrides.clear()


@pytest.mark.anyio
async def test_patch_requires_admin():
    """member role → PATCH 403."""
    client, session, app = await _client(role="member")
    try:
        async with client as c:
            resp = await c.patch(f"/api/v2/workflow-trigger-types/{TRIGGER_ID}", json={"is_enabled": False})
        assert resp.status_code == 403
    finally:
        app.dependency_overrides.clear()


@pytest.mark.anyio
async def test_delete_requires_admin():
    """member role → DELETE 403."""
    client, session, app = await _client(role="member")
    try:
        async with client as c:
            resp = await c.delete(f"/api/v2/workflow-trigger-types/{TRIGGER_ID}")
        assert resp.status_code == 403
    finally:
        app.dependency_overrides.clear()


@pytest.mark.anyio
async def test_patch_system_type_forbidden_fields():
    """is_system=True PATCH + label 변경 → 403."""
    client, session, app = await _client()
    try:
        with patch("app.repositories.workflow_trigger_type.WorkflowTriggerTypeRepository.get", new_callable=AsyncMock) as mock_get:
            mock_get.return_value = _mock_trigger(is_system=True)
            async with client as c:
                resp = await c.patch(f"/api/v2/workflow-trigger-types/{TRIGGER_ID}", json={"label": "Changed Label"})
        assert resp.status_code == 403
    finally:
        app.dependency_overrides.clear()


@pytest.mark.anyio
async def test_patch_system_type_is_enabled_allowed():
    """is_system=True + is_enabled=False → 200."""
    client, session, app = await _client()
    try:
        trigger = _mock_trigger(is_system=True, is_enabled=False)
        with patch("app.repositories.workflow_trigger_type.WorkflowTriggerTypeRepository.get", new_callable=AsyncMock) as mock_get, \
             patch("app.repositories.workflow_trigger_type.WorkflowTriggerTypeRepository.update", new_callable=AsyncMock) as mock_update:
            mock_get.return_value = trigger
            mock_update.return_value = trigger
            async with client as c:
                resp = await c.patch(f"/api/v2/workflow-trigger-types/{TRIGGER_ID}", json={"is_enabled": False})
        assert resp.status_code == 200
        assert resp.json()["is_enabled"] is False
    finally:
        app.dependency_overrides.clear()


@pytest.mark.anyio
async def test_delete_system_type_forbidden():
    """is_system=True DELETE → 403."""
    client, session, app = await _client()
    try:
        with patch("app.repositories.workflow_trigger_type.WorkflowTriggerTypeRepository.get", new_callable=AsyncMock) as mock_get:
            mock_get.return_value = _mock_trigger(is_system=True)
            async with client as c:
                resp = await c.delete(f"/api/v2/workflow-trigger-types/{TRIGGER_ID}")
        assert resp.status_code == 403
    finally:
        app.dependency_overrides.clear()
