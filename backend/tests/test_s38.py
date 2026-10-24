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

def _live_user_result():
    """The account row the delete endpoint reads first (story #4752): a live account — the real closing (is_active · deleted_at) is held by tests/test_4752_account_delete_realdb.py."""
    from types import SimpleNamespace

    user = SimpleNamespace(is_active=True, deleted_at=None)
    res = MagicMock()
    res.scalar_one_or_none.return_value = user
    return res


@pytest.mark.anyio
async def test_account_delete_200():
    client, session, app = await _client()
    try:
        session.execute = AsyncMock(return_value=_live_user_result())

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
        session.execute = AsyncMock(return_value=_live_user_result())

        async with client as c:
            await c.post("/api/v2/account/delete")

        # story #4752: the account row is read first (the endpoint no longer asks for an organization), then
        # AC3-4 2-2 anchor-only: org_members + **members**(anchor) UPDATE (레거시 team_members UPDATE 제거)
        # + story #4400: every refresh token of the account revoked
        # + story #4630: the grace window of tokens a rotation just revoked closed too
        # + story #4752: the push devices closed (K8) + the per-user cut-off for every access token already issued
        # + story #4752 AC4: the organizations the account is the only owner of are looked up (and locked) right after the account row = 8
        # + story #4767: the computers the person confirmed are looked up (the closer's one query when there are none) before the memberships close = 9 … 10 with the
        #   cut-off upsert, which is the last call; story #4769 adds the person's seat lock before it = 11
        assert session.execute.call_count == 11
        assert "organizations" in str(session.execute.call_args_list[1].args[0]) and "FOR UPDATE OF o" in str(session.execute.call_args_list[1].args[0])   # the lock …
        assert "other_owners" in str(session.execute.call_args_list[2].args[0]) and "FOR UPDATE" not in str(session.execute.call_args_list[2].args[0])    # … and the count, a later statement
        assert "FROM users" in str(session.execute.call_args_list[0].args[0])
        # story #4769: the sessions end FIRST (tokens → seat → agent member rows → setup rows is the one order every path keeps), then the person's seats are locked
        revoke = str(session.execute.call_args_list[3].args[0])
        assert "UPDATE refresh_tokens" in revoke and "revoked_at" in revoke
        window = str(session.execute.call_args_list[4].args[0])
        assert "org_members" in str(session.execute.call_args_list[5].args[0]) and "FOR UPDATE" in str(session.execute.call_args_list[5].args[0])   # the person's seats, locked before the closer
        assert "desktop_setups" in str(session.execute.call_args_list[6].args[0])   # story #4767: the person's open computers, looked up right after the seats
        assert "UPDATE refresh_tokens" in window and "expires_at" in window
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
