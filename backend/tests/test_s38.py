"""S38 AC: Account + Subscription Status 라우터 (7건 이상)."""
import uuid
from datetime import datetime, timedelta, timezone
from unittest.mock import AsyncMock, MagicMock, patch

import pytest

ORG_ID = uuid.uuid4()
USER_ID = uuid.uuid4()


@pytest.fixture
def anyio_backend():
    return "asyncio"


async def _client():
    from app.main import app

    ctx = MagicMock()
    ctx.user_id = str(USER_ID)
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


# ── Subscription Status ──────────────────────────────────────────────────────

@pytest.mark.anyio
async def test_subscription_status_200():
    client, session, app = await _client()
    try:
        grace = datetime.now(timezone.utc) + timedelta(days=7)
        mock_result = MagicMock()
        mock_result.first.return_value = ("active", "pro", grace)
        session.execute = AsyncMock(return_value=mock_result)

        async with client as c:
            resp = await c.get("/api/v2/subscription/status")

        assert resp.status_code == 200
        assert resp.json()["status"] == "active"
        assert resp.json()["tier"] == "pro"
    finally:
        app.dependency_overrides.clear()


@pytest.mark.anyio
async def test_subscription_status_no_record_200():
    client, session, app = await _client()
    try:
        mock_result = MagicMock()
        mock_result.first.return_value = None
        session.execute = AsyncMock(return_value=mock_result)

        async with client as c:
            resp = await c.get("/api/v2/subscription/status")

        assert resp.status_code == 200
        assert resp.json()["status"] == "active"
        assert resp.json()["tier"] == "free"
        assert resp.json()["grace_until"] is None
    finally:
        app.dependency_overrides.clear()


@pytest.mark.anyio
async def test_subscription_status_grace_period_200():
    client, session, app = await _client()
    try:
        grace = datetime.now(timezone.utc) + timedelta(days=3)
        mock_result = MagicMock()
        mock_result.first.return_value = ("grace", "pro", grace)
        session.execute = AsyncMock(return_value=mock_result)

        async with client as c:
            resp = await c.get("/api/v2/subscription/status")

        assert resp.status_code == 200
        assert resp.json()["status"] == "grace"
        assert resp.json()["grace_until"] is not None
    finally:
        app.dependency_overrides.clear()


# ── Account Delete ────────────────────────────────────────────────────────────

@pytest.mark.anyio
async def test_account_delete_200():
    client, session, app = await _client()
    try:
        session.execute = AsyncMock(return_value=MagicMock())

        async with client as c:
            resp = await c.post("/api/v2/account/delete")

        assert resp.status_code == 200
        assert resp.json()["ok"] is True
        assert resp.json()["grace_period_days"] == 30
    finally:
        app.dependency_overrides.clear()


@pytest.mark.anyio
async def test_account_delete_updates_org_and_team_members():
    client, session, app = await _client()
    try:
        session.execute = AsyncMock(return_value=MagicMock())

        async with client as c:
            await c.post("/api/v2/account/delete")

        assert session.execute.call_count == 2
    finally:
        app.dependency_overrides.clear()


@pytest.mark.anyio
async def test_subscription_missing_org_id_400():
    from app.main import app
    from app.dependencies.auth import get_current_user
    from app.dependencies.database import get_db

    ctx = MagicMock()
    ctx.user_id = str(USER_ID)
    ctx.email = "test@example.com"
    ctx.claims = {}

    mock_session = AsyncMock()

    async def override_db():
        yield mock_session

    async def override_auth():
        return ctx

    app.dependency_overrides[get_db] = override_db
    app.dependency_overrides[get_current_user] = override_auth

    try:
        from httpx import ASGITransport, AsyncClient
        async with AsyncClient(transport=ASGITransport(app=app), base_url="http://test") as c:
            resp = await c.get("/api/v2/subscription/status")

        assert resp.status_code == 400
    finally:
        app.dependency_overrides.clear()


@pytest.mark.anyio
async def test_subscription_free_tier_default():
    client, session, app = await _client()
    try:
        mock_result = MagicMock()
        mock_result.first.return_value = ("active", "free", None)
        session.execute = AsyncMock(return_value=mock_result)

        async with client as c:
            resp = await c.get("/api/v2/subscription/status")

        assert resp.status_code == 200
        assert resp.json()["tier"] == "free"
        assert resp.json()["grace_until"] is None
    finally:
        app.dependency_overrides.clear()
