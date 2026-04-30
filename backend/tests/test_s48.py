"""S48 AC: Mockups CRUD + Usage Meters — FastAPI /api/v2/mockups/** + /api/v2/usage"""
from __future__ import annotations

import uuid
from unittest.mock import AsyncMock, MagicMock, patch

import pytest

ORG_ID = uuid.uuid4()
PROJECT_ID = uuid.uuid4()
PAGE_ID = uuid.uuid4()
USER_ID = uuid.uuid4()


@pytest.fixture
def anyio_backend() -> str:
    return "asyncio"


async def _client():
    from app.main import app
    ctx = MagicMock()
    ctx.user_id = USER_ID
    ctx.claims = {"app_metadata": {"org_id": str(ORG_ID), "project_id": str(PROJECT_ID)}}
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


def _make_page():
    from datetime import datetime, timezone
    m = MagicMock()
    m.id = PAGE_ID
    m.org_id = ORG_ID
    m.project_id = PROJECT_ID
    m.slug = "test-page"
    m.title = "Test Page"
    m.category = None
    m.viewport = None
    m.version = 1
    m.created_by = USER_ID
    m.created_at = datetime(2026, 4, 30, tzinfo=timezone.utc)
    m.updated_at = datetime(2026, 4, 30, tzinfo=timezone.utc)
    m.deleted_at = None
    return m


# ─── Mockups CRUD ─────────────────────────────────────────────────────────────

@pytest.mark.anyio
async def test_list_mockups_200():
    client, session, app = await _client()
    try:
        page = _make_page()
        mock_result = MagicMock()
        mock_result.scalars.return_value.all.return_value = [page]
        session.execute = AsyncMock(return_value=mock_result)
        async with client as c:
            resp = await c.get("/api/v2/mockups")
        assert resp.status_code == 200
        body = resp.json()
        assert body["error"] is None
        assert body["data"]["items"][0]["slug"] == "test-page"
    finally:
        app.dependency_overrides.clear()


@pytest.mark.anyio
async def test_create_mockup_201():
    client, session, app = await _client()
    try:
        page = _make_page()
        session.flush = AsyncMock()
        session.commit = AsyncMock()
        session.add = MagicMock()
        mock_result = MagicMock()
        mock_result.scalars.return_value.all.return_value = [page]
        session.execute = AsyncMock(return_value=mock_result)

        with patch("app.routers.mockups.MockupPage") as MockPage:
            instance = _make_page()
            MockPage.return_value = instance
            async with client as c:
                resp = await c.post("/api/v2/mockups", json={"slug": "new-page", "title": "New Page"})
        assert resp.status_code in (200, 201)
    finally:
        app.dependency_overrides.clear()


@pytest.mark.anyio
async def test_get_mockup_200():
    client, session, app = await _client()
    try:
        page = _make_page()
        mock_page_result = MagicMock()
        mock_page_result.scalar_one_or_none.return_value = page
        mock_comps_result = MagicMock()
        mock_comps_result.scalars.return_value.all.return_value = []
        mock_scen_result = MagicMock()
        mock_scen_result.scalars.return_value.all.return_value = []
        session.execute = AsyncMock(side_effect=[mock_page_result, mock_comps_result, mock_scen_result])
        async with client as c:
            resp = await c.get(f"/api/v2/mockups/{PAGE_ID}")
        assert resp.status_code == 200
        assert resp.json()["data"]["slug"] == "test-page"
    finally:
        app.dependency_overrides.clear()


@pytest.mark.anyio
async def test_get_mockup_not_found_404():
    client, session, app = await _client()
    try:
        mock_result = MagicMock()
        mock_result.scalar_one_or_none.return_value = None
        session.execute = AsyncMock(return_value=mock_result)
        async with client as c:
            resp = await c.get(f"/api/v2/mockups/{uuid.uuid4()}")
        assert resp.status_code == 404
    finally:
        app.dependency_overrides.clear()


@pytest.mark.anyio
async def test_delete_mockup_200():
    client, session, app = await _client()
    try:
        session.execute = AsyncMock(return_value=MagicMock())
        session.commit = AsyncMock()
        async with client as c:
            resp = await c.delete(f"/api/v2/mockups/{PAGE_ID}")
        assert resp.status_code == 200
        assert resp.json()["data"]["ok"] is True
    finally:
        app.dependency_overrides.clear()


# ─── Scenarios ────────────────────────────────────────────────────────────────

@pytest.mark.anyio
async def test_list_scenarios_200():
    client, session, app = await _client()
    try:
        mock_result = MagicMock()
        mock_result.scalars.return_value.all.return_value = []
        session.execute = AsyncMock(return_value=mock_result)
        async with client as c:
            resp = await c.get(f"/api/v2/mockups/{PAGE_ID}/scenarios")
        assert resp.status_code == 200
        assert resp.json()["data"] == []
    finally:
        app.dependency_overrides.clear()


@pytest.mark.anyio
async def test_delete_default_scenario_400():
    client, session, app = await _client()
    try:
        scenario = MagicMock()
        scenario.is_default = True
        mock_result = MagicMock()
        mock_result.scalar_one_or_none.return_value = scenario
        session.execute = AsyncMock(return_value=mock_result)
        import json as _json
        async with client as c:
            resp = await c.request("DELETE", f"/api/v2/mockups/{PAGE_ID}/scenarios", content=_json.dumps({"scenario_id": str(uuid.uuid4())}), headers={"content-type": "application/json"})
        assert resp.status_code == 400
        assert resp.json()["error"]["code"] == "CANNOT_DELETE_DEFAULT"
    finally:
        app.dependency_overrides.clear()


# ─── Usage Meters ─────────────────────────────────────────────────────────────

@pytest.mark.anyio
async def test_get_usage_200():
    client, session, app = await _client()
    try:
        from datetime import datetime, timezone
        row = MagicMock()
        row.meter_type = "max_mockups"
        row.current_value = 3
        row.limit_value = 10
        row.period_start = datetime(2026, 4, 1, tzinfo=timezone.utc)
        row.period_end = None
        mock_result = MagicMock()
        mock_result.all.return_value = [row]
        session.execute = AsyncMock(return_value=mock_result)
        async with client as c:
            resp = await c.get("/api/v2/usage")
        assert resp.status_code == 200
        body = resp.json()
        assert body["error"] is None
        assert body["data"][0]["meter_type"] == "max_mockups"
    finally:
        app.dependency_overrides.clear()
