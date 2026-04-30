"""S39 AC: OSS Seed + Webhook Status + Health 라우터 (5건 이상)."""
import uuid
from unittest.mock import AsyncMock, MagicMock, patch

import pytest

ORG_ID = uuid.uuid4()
PROJECT_ID = uuid.uuid4()


@pytest.fixture
def anyio_backend():
    return "asyncio"


async def _client():
    from app.main import app
    ctx = MagicMock()
    ctx.user_id = str(uuid.uuid4())
    ctx.email = "test@example.com"
    ctx.claims = {"app_metadata": {"org_id": str(ORG_ID)}}
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


@pytest.mark.anyio
async def test_oss_seed_empty_200():
    client, session, app = await _client()
    try:
        r = MagicMock(); r.scalar_one.return_value = 0
        session.execute = AsyncMock(return_value=r)
        session.add = MagicMock(); session.flush = AsyncMock()
        async with client as c:
            resp = await c.post(f"/api/v2/oss/seed?project_id={PROJECT_ID}&org_id={ORG_ID}")
        assert resp.status_code == 200
        assert resp.json()["seeded"] is True
        assert resp.json()["count"] == 3
    finally:
        app.dependency_overrides.clear()


@pytest.mark.anyio
async def test_oss_seed_already_has_data_200():
    client, session, app = await _client()
    try:
        r = MagicMock(); r.scalar_one.return_value = 5
        session.execute = AsyncMock(return_value=r)
        async with client as c:
            resp = await c.post(f"/api/v2/oss/seed?project_id={PROJECT_ID}&org_id={ORG_ID}")
        assert resp.status_code == 200
        assert resp.json()["seeded"] is False
    finally:
        app.dependency_overrides.clear()


@pytest.mark.anyio
async def test_oss_webhook_status_disconnected_200():
    client, session, app = await _client()
    try:
        import os; os.environ.pop("GITHUB_WEBHOOK_SECRET", None)
        async with client as c:
            resp = await c.get("/api/v2/oss/webhook-status")
        assert resp.status_code == 200
        assert resp.json()["connected"] is False
    finally:
        app.dependency_overrides.clear()


@pytest.mark.anyio
async def test_oss_webhook_status_connected_200():
    client, session, app = await _client()
    try:
        with patch.dict("os.environ", {"GITHUB_WEBHOOK_SECRET": "s"}):
            async with client as c:
                resp = await c.get("/api/v2/oss/webhook-status")
        assert resp.status_code == 200
        assert resp.json()["connected"] is True
    finally:
        app.dependency_overrides.clear()


@pytest.mark.anyio
async def test_health_version_200():
    client, session, app = await _client()
    try:
        session.execute = AsyncMock(return_value=MagicMock())
        async with client as c:
            resp = await c.get("/api/v2/health")
        assert resp.status_code == 200
        assert resp.json()["version"] == "v2"
    finally:
        app.dependency_overrides.clear()
