"""E-ORG-MULTI S3.1: Organization Invite 데이터 모델/API 테스트.

AC1: org_invites 테이블 migration 존재
AC2: invite 필드 구조 (organization_id, email, role, token, expires_at, accepted_at, created_by)
AC3: 만료 시간 7일
AC4: owner/admin만 초대 생성 가능
AC5: member → 403
AC6: 이미 가입된 email 중복 초대 불가 409
AC7: 진입점 존재 검증
"""
from __future__ import annotations

import uuid
from datetime import datetime, timedelta, timezone
from unittest.mock import AsyncMock, MagicMock, patch

import pytest

ORG_ID = uuid.uuid4()
USER_ID = uuid.uuid4()
INVITE_ID = uuid.uuid4()


def _mock_invite(email: str = "new@example.com", role: str = "member") -> MagicMock:
    i = MagicMock()
    i.id = INVITE_ID
    i.organization_id = ORG_ID
    i.email = email
    i.role = role
    i.token = "abc123"
    i.status = "pending"
    i.expires_at = datetime.now(timezone.utc) + timedelta(days=7)
    i.accepted_at = None
    i.created_by = USER_ID
    i.created_at = datetime.now(timezone.utc)
    i.email_sent_at = None
    i.email_error = None
    return i


@pytest.fixture
def anyio_backend():
    return "asyncio"


async def _client(user_id: uuid.UUID = USER_ID):
    from app.main import app
    from app.dependencies.auth import get_current_user
    from app.dependencies.database import get_db
    from httpx import ASGITransport, AsyncClient

    ctx = MagicMock()
    ctx.user_id = str(user_id)
    ctx.email = "test@example.com"
    ctx.claims = {"app_metadata": {"org_id": str(ORG_ID)}}

    mock_session = AsyncMock()

    async def override_db():
        yield mock_session

    async def override_auth():
        return ctx

    app.dependency_overrides[get_db] = override_db
    app.dependency_overrides[get_current_user] = override_auth

    return AsyncClient(transport=ASGITransport(app=app), base_url="http://test"), mock_session, app


# ─── AC1: Migration 파일 존재 ────────────────────────────────────────────────

def test_migration_file_exists():
    """0041_add_org_invites.py migration 파일 존재."""
    import os
    migration_path = os.path.join(
        os.path.dirname(__file__), "..", "alembic", "versions", "0041_add_org_invites.py"
    )
    assert os.path.exists(migration_path)


# ─── AC2: 모델 필드 구조 ────────────────────────────────────────────────────

def test_org_invite_model_fields():
    """OrgInvite 모델에 필수 필드 전량 존재."""
    from app.models.org_invite import OrgInvite
    table_cols = {c.name for c in OrgInvite.__table__.columns}
    required = {"id", "organization_id", "email", "role", "token", "expires_at", "accepted_at", "created_by", "created_at"}
    assert required.issubset(table_cols)


# ─── AC3: 만료 7일 ──────────────────────────────────────────────────────────

def test_invite_expires_in_7_days():
    """OrgInviteRepository._INVITE_EXPIRE_DAYS == 7."""
    from app.repositories.org_invite import _INVITE_EXPIRE_DAYS
    assert _INVITE_EXPIRE_DAYS == 7


# ─── AC7: 진입점 존재 ───────────────────────────────────────────────────────

def test_invite_endpoints_exist():
    """GET/POST /api/v2/organizations/{id}/invites 라우트 존재."""
    from app.main import app
    paths = {getattr(r, "path", "") for r in app.routes}
    assert "/api/v2/organizations/{id}/invites" in paths


# ─── AC4: owner/admin 초대 생성 ─────────────────────────────────────────────

@pytest.mark.anyio
async def test_owner_can_create_invite():
    """owner → 201 + 초대 반환."""
    client, session, app = await _client()
    try:
        from app.routers.org_invites import _get_invite_repo, _get_org_repo

        mock_org_repo = MagicMock()
        mock_org_repo.get_member_role = AsyncMock(return_value="owner")

        mock_invite_repo = MagicMock()
        mock_invite_repo.is_already_member = AsyncMock(return_value=False)
        mock_invite_repo.create = AsyncMock(return_value=_mock_invite())
        mock_invite_repo.update_email_result = AsyncMock()
        mock_invite_repo.session = MagicMock()
        mock_invite_repo.session.get = AsyncMock(return_value=None)

        app.dependency_overrides[_get_org_repo] = lambda: mock_org_repo
        app.dependency_overrides[_get_invite_repo] = lambda: mock_invite_repo
        session.commit = AsyncMock()
        session.refresh = AsyncMock()

        with patch("app.routers.org_invites.send_invite_email", return_value=None):
            async with client as c:
                resp = await c.post(
                    f"/api/v2/organizations/{ORG_ID}/invites",
                    json={"email": "new@example.com", "role": "member"},
                )

        assert resp.status_code == 201
        data = resp.json()
        assert data["email"] == "new@example.com"
        assert data["status"] == "pending"
    finally:
        app.dependency_overrides.clear()


@pytest.mark.anyio
async def test_admin_can_create_invite():
    """admin → 201."""
    client, session, app = await _client()
    try:
        from app.routers.org_invites import _get_invite_repo, _get_org_repo

        mock_org_repo = MagicMock()
        mock_org_repo.get_member_role = AsyncMock(return_value="admin")
        mock_invite_repo = MagicMock()
        mock_invite_repo.is_already_member = AsyncMock(return_value=False)
        mock_invite_repo.create = AsyncMock(return_value=_mock_invite())
        mock_invite_repo.update_email_result = AsyncMock()
        mock_invite_repo.session = MagicMock()
        mock_invite_repo.session.get = AsyncMock(return_value=None)

        app.dependency_overrides[_get_org_repo] = lambda: mock_org_repo
        app.dependency_overrides[_get_invite_repo] = lambda: mock_invite_repo
        session.commit = AsyncMock()
        session.refresh = AsyncMock()

        with patch("app.routers.org_invites.send_invite_email", return_value=None):
            async with client as c:
                resp = await c.post(
                    f"/api/v2/organizations/{ORG_ID}/invites",
                    json={"email": "new@example.com", "role": "member"},
                )

        assert resp.status_code == 201
    finally:
        app.dependency_overrides.clear()


# ─── AC5: member 403 ────────────────────────────────────────────────────────

@pytest.mark.anyio
async def test_member_cannot_create_invite():
    """member → 403."""
    client, session, app = await _client()
    try:
        from app.routers.org_invites import _get_invite_repo, _get_org_repo

        mock_org_repo = MagicMock()
        mock_org_repo.get_member_role = AsyncMock(return_value="member")
        mock_invite_repo = MagicMock()

        app.dependency_overrides[_get_org_repo] = lambda: mock_org_repo
        app.dependency_overrides[_get_invite_repo] = lambda: mock_invite_repo

        async with client as c:
            resp = await c.post(
                f"/api/v2/organizations/{ORG_ID}/invites",
                json={"email": "new@example.com", "role": "member"},
            )

        assert resp.status_code == 403
    finally:
        app.dependency_overrides.clear()


# ─── AC6: 이미 가입된 email 409 ─────────────────────────────────────────────

@pytest.mark.anyio
async def test_already_member_email_returns_409():
    """이미 가입된 email → 409."""
    client, session, app = await _client()
    try:
        from app.routers.org_invites import _get_invite_repo, _get_org_repo

        mock_org_repo = MagicMock()
        mock_org_repo.get_member_role = AsyncMock(return_value="owner")
        mock_invite_repo = MagicMock()
        mock_invite_repo.is_already_member = AsyncMock(return_value=True)

        app.dependency_overrides[_get_org_repo] = lambda: mock_org_repo
        app.dependency_overrides[_get_invite_repo] = lambda: mock_invite_repo

        async with client as c:
            resp = await c.post(
                f"/api/v2/organizations/{ORG_ID}/invites",
                json={"email": "existing@example.com", "role": "member"},
            )

        assert resp.status_code == 409
    finally:
        app.dependency_overrides.clear()


# ─── 중복 초대 409 ──────────────────────────────────────────────────────────

@pytest.mark.anyio
async def test_duplicate_invite_returns_409():
    """같은 org+email 중복 초대 → create() None → 409."""
    client, session, app = await _client()
    try:
        from app.routers.org_invites import _get_invite_repo, _get_org_repo

        mock_org_repo = MagicMock()
        mock_org_repo.get_member_role = AsyncMock(return_value="owner")
        mock_invite_repo = MagicMock()
        mock_invite_repo.is_already_member = AsyncMock(return_value=False)
        mock_invite_repo.create = AsyncMock(return_value=None)

        app.dependency_overrides[_get_org_repo] = lambda: mock_org_repo
        app.dependency_overrides[_get_invite_repo] = lambda: mock_invite_repo

        async with client as c:
            resp = await c.post(
                f"/api/v2/organizations/{ORG_ID}/invites",
                json={"email": "dup@example.com", "role": "member"},
            )

        assert resp.status_code == 409
    finally:
        app.dependency_overrides.clear()


# ─── 목록 조회 ───────────────────────────────────────────────────────────────

@pytest.mark.anyio
async def test_list_invites_owner():
    """owner → GET 목록 200."""
    client, session, app = await _client()
    try:
        from app.routers.org_invites import _get_invite_repo, _get_org_repo

        mock_org_repo = MagicMock()
        mock_org_repo.get_member_role = AsyncMock(return_value="owner")
        mock_invite_repo = MagicMock()
        mock_invite_repo.list_pending = AsyncMock(return_value=[_mock_invite()])

        app.dependency_overrides[_get_org_repo] = lambda: mock_org_repo
        app.dependency_overrides[_get_invite_repo] = lambda: mock_invite_repo

        async with client as c:
            resp = await c.get(f"/api/v2/organizations/{ORG_ID}/invites")

        assert resp.status_code == 200
        assert len(resp.json()) == 1
    finally:
        app.dependency_overrides.clear()


# ─── Schema 검증 ─────────────────────────────────────────────────────────────

def test_list_pending_filters_expired_in_source():
    """list_pending 소스에 expires_at > now 필터 존재."""
    import inspect
    from app.repositories.org_invite import OrgInviteRepository
    source = inspect.getsource(OrgInviteRepository.list_pending)
    assert "expires_at" in source
    assert "now" in source


def test_create_org_invite_schema():
    from app.schemas.org_invite import CreateOrgInvite
    fields = set(CreateOrgInvite.model_fields.keys())
    assert {"email", "role"}.issubset(fields)


def test_org_invite_response_schema():
    from app.schemas.org_invite import OrgInviteResponse
    fields = set(OrgInviteResponse.model_fields.keys())
    assert {"id", "organization_id", "email", "role", "status", "expires_at", "created_by"}.issubset(fields)
