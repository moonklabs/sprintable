"""S31 AC: Audit Logs + Organizations + Me + ProjectSettings 라우터 (8건 이상 합산)."""
import uuid
from datetime import datetime, time, timezone
from unittest.mock import AsyncMock, MagicMock, patch

import pytest

ORG_ID = uuid.uuid4()
PROJECT_ID = uuid.uuid4()
MEMBER_ID = uuid.uuid4()
ORG_ENTRY_ID = uuid.uuid4()


def _mock_audit_log() -> MagicMock:
    a = MagicMock()
    a.id = uuid.uuid4()
    a.org_id = ORG_ID
    a.actor_id = MEMBER_ID
    a.action = "role_changed"
    a.target_user_id = uuid.uuid4()
    a.old_role = "member"
    a.new_role = "admin"
    a.audit_metadata = {}
    a.created_at = datetime(2026, 4, 30, tzinfo=timezone.utc)
    return a


def _mock_org() -> MagicMock:
    o = MagicMock()
    o.id = ORG_ENTRY_ID
    o.name = "Test Org"
    o.slug = "test-org"
    o.plan = "free"
    o.created_at = datetime(2026, 4, 30, tzinfo=timezone.utc)
    o.updated_at = datetime(2026, 4, 30, tzinfo=timezone.utc)
    return o


def _mock_member() -> MagicMock:
    m = MagicMock()
    m.id = MEMBER_ID
    m.org_id = ORG_ID
    m.project_id = PROJECT_ID
    m.project_name = None
    m.project = None
    m.name = "Alice"
    m.email = "alice@example.com"  # E-ONBOARDING S2: MeResponse.email
    m.type = "human"
    m.role = "admin"
    m.is_active = True
    m.user_id = uuid.uuid4()
    return m


def _mock_setting() -> MagicMock:
    s = MagicMock()
    s.project_id = PROJECT_ID
    s.standup_deadline = time(9, 0)
    s.created_at = datetime(2026, 4, 30, tzinfo=timezone.utc)
    s.updated_at = datetime(2026, 4, 30, tzinfo=timezone.utc)
    return s


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


# ── Audit Logs ──────────────────────────────────────────────────────────────

@pytest.mark.anyio
async def test_list_audit_logs_200():
    client, session, app = await _client()
    try:
        with patch("app.repositories.audit.AuditLogRepository.list", new_callable=AsyncMock) as mock_list:
            mock_list.return_value = [_mock_audit_log()]

            async with client as c:
                resp = await c.get("/api/v2/audit-logs?limit=10")

        assert resp.status_code == 200
        assert len(resp.json()) == 1
        assert resp.json()[0]["action"] == "role_changed"
    finally:
        app.dependency_overrides.clear()


@pytest.mark.anyio
async def test_list_audit_logs_empty_200():
    client, session, app = await _client()
    try:
        with patch("app.repositories.audit.AuditLogRepository.list", new_callable=AsyncMock) as mock_list:
            mock_list.return_value = []

            async with client as c:
                resp = await c.get("/api/v2/audit-logs")

        assert resp.status_code == 200
        assert resp.json() == []
    finally:
        app.dependency_overrides.clear()


# ── Organizations ────────────────────────────────────────────────────────────

@pytest.mark.anyio
async def test_create_organization_201():
    client, session, app = await _client()
    try:
        mock_user = MagicMock()
        mock_user.email_verified = True
        mock_result = MagicMock()
        mock_result.scalar_one_or_none.return_value = mock_user
        session.execute = AsyncMock(return_value=mock_result)

        with patch("app.repositories.organization.OrganizationRepository.create", new_callable=AsyncMock) as mock_create:
            mock_create.return_value = _mock_org()

            async with client as c:
                resp = await c.post("/api/v2/organizations", json={
                    "name": "Test Org",
                    "slug": "test-org",
                    "owner_member_id": str(MEMBER_ID),
                })

        assert resp.status_code == 201
        assert resp.json()["slug"] == "test-org"
    finally:
        app.dependency_overrides.clear()


@pytest.mark.anyio
async def test_create_organization_409_slug_conflict():
    client, session, app = await _client()
    try:
        mock_user = MagicMock()
        mock_user.email_verified = True
        mock_result = MagicMock()
        mock_result.scalar_one_or_none.return_value = mock_user
        session.execute = AsyncMock(return_value=mock_result)

        with patch("app.repositories.organization.OrganizationRepository.create", new_callable=AsyncMock) as mock_create:
            mock_create.return_value = None

            async with client as c:
                resp = await c.post("/api/v2/organizations", json={
                    "name": "Test Org",
                    "slug": "existing-slug",
                    "owner_member_id": str(MEMBER_ID),
                })

        assert resp.status_code == 409
    finally:
        app.dependency_overrides.clear()


@pytest.mark.anyio
async def test_delete_organization_200():
    client, session, app = await _client()
    try:
        with patch("app.repositories.organization.OrganizationRepository.delete_by_user", new_callable=AsyncMock) as mock_del:
            mock_del.return_value = {"ok": True}

            async with client as c:
                resp = await c.request(
                    "DELETE",
                    f"/api/v2/organizations/{ORG_ENTRY_ID}",
                    json={"confirmation": "Test Org"},
                )

        assert resp.status_code == 200
        assert resp.json()["ok"] is True
    finally:
        app.dependency_overrides.clear()


@pytest.mark.anyio
async def test_delete_organization_403_not_owner():
    client, session, app = await _client()
    try:
        with patch("app.repositories.organization.OrganizationRepository.delete_by_user", new_callable=AsyncMock) as mock_del:
            mock_del.return_value = {"ok": False, "reason": "forbidden"}

            async with client as c:
                resp = await c.request(
                    "DELETE",
                    f"/api/v2/organizations/{ORG_ENTRY_ID}",
                    json={"confirmation": "Test Org"},
                )

        assert resp.status_code == 403
    finally:
        app.dependency_overrides.clear()


# ── Me ────────────────────────────────────────────────────────────────────────

def _mock_result(member):
    """scalars().first() 패턴 mock 생성."""
    r = MagicMock()
    r.scalars.return_value.first.return_value = member
    # E-ONBOARDING S2: get_me의 User 조회(scalar_one_or_none)도 member 모킹 → email/has_password 일관
    r.scalar_one_or_none.return_value = member
    return r


async def _client_api_key():
    """API key claims (api_key_id 포함)를 가진 클라이언트."""
    from app.main import app

    ctx = MagicMock()
    ctx.user_id = str(MEMBER_ID)
    ctx.email = None
    ctx.claims = {
        "app_metadata": {
            "org_id": str(ORG_ID),
            "api_key_id": str(uuid.uuid4()),
        }
    }

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
async def test_get_me_200():
    client, session, app = await _client()
    try:
        session.execute = AsyncMock(return_value=_mock_result(_mock_member()))

        async with client as c:
            resp = await c.get(f"/api/v2/me?member_id={MEMBER_ID}")

        assert resp.status_code == 200
        assert resp.json()["name"] == "Alice"
    finally:
        app.dependency_overrides.clear()


@pytest.mark.anyio
async def test_get_me_via_api_key_200():
    """API key 인증: auth.user_id = TeamMember.id → id 분기로 조회."""
    client, session, app = await _client_api_key()
    try:
        session.execute = AsyncMock(return_value=_mock_result(_mock_member()))

        async with client as c:
            resp = await c.get("/api/v2/me")

        assert resp.status_code == 200
        assert resp.json()["name"] == "Alice"
    finally:
        app.dependency_overrides.clear()


@pytest.mark.anyio
async def test_get_me_via_jwt_no_member_id_200():
    """JWT 인증: member_id 미전달 시 user_id 분기로 조회."""
    client, session, app = await _client()
    try:
        session.execute = AsyncMock(return_value=_mock_result(_mock_member()))

        async with client as c:
            resp = await c.get("/api/v2/me")

        assert resp.status_code == 200
        assert resp.json()["name"] == "Alice"
    finally:
        app.dependency_overrides.clear()


@pytest.mark.anyio
async def test_get_me_404():
    client, session, app = await _client()
    try:
        session.execute = AsyncMock(return_value=_mock_result(None))

        async with client as c:
            resp = await c.get(f"/api/v2/me?member_id={uuid.uuid4()}")

        assert resp.status_code == 404
    finally:
        app.dependency_overrides.clear()


# ── ProjectSettings ──────────────────────────────────────────────────────────

@pytest.mark.anyio
async def test_get_project_settings_200():
    client, session, app = await _client()
    try:
        mock_result = MagicMock()
        mock_result.scalar_one_or_none.return_value = _mock_setting()
        session.execute = AsyncMock(return_value=mock_result)

        async with client as c:
            resp = await c.get(f"/api/v2/project-settings?project_id={PROJECT_ID}")

        assert resp.status_code == 200
        assert resp.json()["standup_deadline"] == "09:00:00"
    finally:
        app.dependency_overrides.clear()


@pytest.mark.anyio
async def test_get_project_settings_default_200():
    client, session, app = await _client()
    try:
        mock_result = MagicMock()
        mock_result.scalar_one_or_none.return_value = None
        session.execute = AsyncMock(return_value=mock_result)

        async with client as c:
            resp = await c.get(f"/api/v2/project-settings?project_id={PROJECT_ID}")

        assert resp.status_code == 200
        assert resp.json()["standup_deadline"] == "09:00:00"
    finally:
        app.dependency_overrides.clear()
