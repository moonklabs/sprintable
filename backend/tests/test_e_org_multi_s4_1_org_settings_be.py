"""E-ORG-MULTI S4.1: PATCH /api/v2/organizations/{id} — Organization Settings 백엔드 API.

AC1: PATCH /api/v2/organizations/{id} 진입점 제공
AC2: owner/admin만 수정 가능
AC3: member role 403
AC4: 존재하지 않는 org_id 404
AC5: 수정 성공 시 갱신된 organization 반환
AC6: 테스트 작성
"""
from __future__ import annotations

import uuid
from datetime import datetime, timezone
from unittest.mock import AsyncMock, MagicMock

import pytest

ORG_ID = uuid.uuid4()
USER_ID = uuid.uuid4()


def _mock_org(name: str = "Test Org") -> MagicMock:
    o = MagicMock()
    o.id = ORG_ID
    o.name = name
    o.slug = "test-org"
    o.plan = "free"
    o.created_at = datetime(2026, 5, 1, tzinfo=timezone.utc)
    o.updated_at = datetime(2026, 5, 20, tzinfo=timezone.utc)
    return o


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


# ─── AC1: 진입점 존재 ────────────────────────────────────────────────────────

def test_patch_org_endpoint_exists():
    """PATCH /api/v2/organizations/{id} 라우트가 등록됨."""
    from app.main import app
    paths = {getattr(r, "path", "") for r in app.routes}
    assert "/api/v2/organizations/{id}" in paths


# ─── AC2 + AC5: owner 수정 성공 ──────────────────────────────────────────────

@pytest.mark.anyio
async def test_owner_can_update_org_name():
    """owner role → 200 + 갱신된 org 반환."""
    client, session, app = await _client()
    try:
        updated_org = _mock_org(name="New Name")

        from app.repositories.organization import OrganizationRepository
        from app.dependencies.database import get_db as _get_db

        mock_repo = MagicMock()
        mock_repo.get_member_role = AsyncMock(return_value="owner")
        mock_repo.update_name = AsyncMock(return_value=updated_org)

        from app.routers.organizations import _get_repo
        app.dependency_overrides[_get_repo] = lambda: mock_repo
        session.commit = AsyncMock()

        async with client as c:
            resp = await c.patch(f"/api/v2/organizations/{ORG_ID}", json={"name": "New Name"})

        assert resp.status_code == 200
        data = resp.json()
        assert data["name"] == "New Name"
        assert data["id"] == str(ORG_ID)
    finally:
        app.dependency_overrides.clear()


@pytest.mark.anyio
async def test_admin_can_update_org_name():
    """admin role → 200."""
    client, session, app = await _client()
    try:
        updated_org = _mock_org(name="Admin Updated")

        mock_repo = MagicMock()
        mock_repo.get_member_role = AsyncMock(return_value="admin")
        mock_repo.update_name = AsyncMock(return_value=updated_org)

        from app.routers.organizations import _get_repo
        app.dependency_overrides[_get_repo] = lambda: mock_repo
        session.commit = AsyncMock()

        async with client as c:
            resp = await c.patch(f"/api/v2/organizations/{ORG_ID}", json={"name": "Admin Updated"})

        assert resp.status_code == 200
    finally:
        app.dependency_overrides.clear()


# ─── AC3: member 403 ─────────────────────────────────────────────────────────

@pytest.mark.anyio
async def test_member_role_returns_403():
    """member role → 403."""
    client, session, app = await _client()
    try:
        mock_repo = MagicMock()
        mock_repo.get_member_role = AsyncMock(return_value="member")

        from app.routers.organizations import _get_repo
        app.dependency_overrides[_get_repo] = lambda: mock_repo

        async with client as c:
            resp = await c.patch(f"/api/v2/organizations/{ORG_ID}", json={"name": "Hacked"})

        assert resp.status_code == 403
    finally:
        app.dependency_overrides.clear()


# ─── AC4: 비존재 org 404 ─────────────────────────────────────────────────────

@pytest.mark.anyio
async def test_nonexistent_org_returns_404():
    """미소속 org_id → get_member_role=None → 404."""
    client, session, app = await _client()
    try:
        mock_repo = MagicMock()
        mock_repo.get_member_role = AsyncMock(return_value=None)

        from app.routers.organizations import _get_repo
        app.dependency_overrides[_get_repo] = lambda: mock_repo

        async with client as c:
            resp = await c.patch(f"/api/v2/organizations/{uuid.uuid4()}", json={"name": "Ghost"})

        assert resp.status_code == 404
    finally:
        app.dependency_overrides.clear()


# ─── AC2: 미인증 401 ─────────────────────────────────────────────────────────

@pytest.mark.anyio
async def test_unauthenticated_returns_401():
    """Authorization 없으면 401."""
    from app.main import app
    from httpx import ASGITransport, AsyncClient

    async with AsyncClient(transport=ASGITransport(app=app), base_url="http://test") as c:
        resp = await c.patch(f"/api/v2/organizations/{ORG_ID}", json={"name": "X"})
    assert resp.status_code in (401, 403)


# ─── Schema 검증 ─────────────────────────────────────────────────────────────

def test_update_organization_schema():
    """UpdateOrganization에 name 필드 존재."""
    from app.schemas.organization import UpdateOrganization
    fields = set(UpdateOrganization.model_fields.keys())
    assert "name" in fields


# ─── Repository 메서드 검증 ──────────────────────────────────────────────────

def test_repo_has_get_member_role():
    """OrganizationRepository.get_member_role 메서드 존재."""
    from app.repositories.organization import OrganizationRepository
    assert callable(getattr(OrganizationRepository, "get_member_role", None))


def test_repo_has_update_name():
    """OrganizationRepository.update_name 메서드 존재."""
    from app.repositories.organization import OrganizationRepository
    assert callable(getattr(OrganizationRepository, "update_name", None))
