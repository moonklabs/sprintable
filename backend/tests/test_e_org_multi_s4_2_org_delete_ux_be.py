"""E-ORG-MULTI S4.2: Organization 삭제 UX 정리 — 백엔드 API 테스트.

AC1: 삭제 액션은 owner에게만 (admin/member 403)
AC2: GET /{id}/impact — Project/Member/Subscription 영향도 반환
AC3: 명시적 확인 입력(org name 재입력) 검증
AC4: confirmation 불일치 시 422
AC5: dev 환경 격리 검증
"""
from __future__ import annotations

import uuid
from datetime import datetime, timezone
from unittest.mock import AsyncMock, MagicMock

import pytest

ORG_ID = uuid.uuid4()
USER_ID = uuid.uuid4()
ORG_NAME = "Test Org"


def _mock_org() -> MagicMock:
    o = MagicMock()
    o.id = ORG_ID
    o.name = ORG_NAME
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


# ─── AC2: GET /{id}/impact 진입점 ────────────────────────────────────────────

def test_impact_endpoint_exists():
    """GET /api/v2/organizations/{id}/impact 라우트 존재."""
    from app.main import app
    paths = {getattr(r, "path", "") for r in app.routes}
    assert "/api/v2/organizations/{id}/impact" in paths


@pytest.mark.anyio
async def test_owner_can_get_impact():
    """owner → 200 + project/member/subscription 정보 반환."""
    client, session, app = await _client()
    try:
        from app.repositories.organization import OrgImpact
        from app.routers.organizations import _get_repo

        mock_repo = MagicMock()
        mock_repo.get_member_role = AsyncMock(return_value="owner")
        mock_repo.get_impact = AsyncMock(return_value=OrgImpact(
            project_count=3, member_count=5, has_active_subscription=False
        ))
        app.dependency_overrides[_get_repo] = lambda: mock_repo

        async with client as c:
            resp = await c.get(f"/api/v2/organizations/{ORG_ID}/impact")

        assert resp.status_code == 200
        data = resp.json()
        assert data["project_count"] == 3
        assert data["member_count"] == 5
        assert data["has_active_subscription"] is False
    finally:
        app.dependency_overrides.clear()


@pytest.mark.anyio
async def test_non_owner_cannot_get_impact():
    """admin → impact 조회 403."""
    client, session, app = await _client()
    try:
        from app.routers.organizations import _get_repo

        mock_repo = MagicMock()
        mock_repo.get_member_role = AsyncMock(return_value="admin")
        app.dependency_overrides[_get_repo] = lambda: mock_repo

        async with client as c:
            resp = await c.get(f"/api/v2/organizations/{ORG_ID}/impact")

        assert resp.status_code == 403
    finally:
        app.dependency_overrides.clear()


# ─── AC1: DELETE — owner만 가능 ──────────────────────────────────────────────

@pytest.mark.anyio
async def test_owner_can_delete_with_correct_confirmation():
    """owner + 정확한 confirmation → 200."""
    client, session, app = await _client()
    try:
        from app.routers.organizations import _get_repo

        mock_repo = MagicMock()
        mock_repo.delete_by_user = AsyncMock(return_value={"ok": True})
        app.dependency_overrides[_get_repo] = lambda: mock_repo
        session.commit = AsyncMock()

        async with client as c:
            resp = await c.request("DELETE", f"/api/v2/organizations/{ORG_ID}", json={"confirmation": ORG_NAME})

        assert resp.status_code == 200
        assert resp.json() == {"ok": True}
    finally:
        app.dependency_overrides.clear()


@pytest.mark.anyio
async def test_non_owner_delete_returns_403():
    """non-owner → delete_by_user forbidden → 403."""
    client, session, app = await _client()
    try:
        from app.routers.organizations import _get_repo

        mock_repo = MagicMock()
        mock_repo.delete_by_user = AsyncMock(return_value={"ok": False, "reason": "forbidden"})
        app.dependency_overrides[_get_repo] = lambda: mock_repo

        async with client as c:
            resp = await c.request("DELETE", f"/api/v2/organizations/{ORG_ID}", json={"confirmation": ORG_NAME})

        assert resp.status_code == 403
    finally:
        app.dependency_overrides.clear()


# ─── AC3+AC4: confirmation 불일치 422 ────────────────────────────────────────

@pytest.mark.anyio
async def test_wrong_confirmation_returns_422():
    """confirmation 불일치 → 422."""
    client, session, app = await _client()
    try:
        from app.routers.organizations import _get_repo

        mock_repo = MagicMock()
        mock_repo.delete_by_user = AsyncMock(return_value={"ok": False, "reason": "confirmation_mismatch"})
        app.dependency_overrides[_get_repo] = lambda: mock_repo

        async with client as c:
            resp = await c.request("DELETE", f"/api/v2/organizations/{ORG_ID}", json={"confirmation": "Wrong Name"})

        assert resp.status_code == 422
    finally:
        app.dependency_overrides.clear()


# ─── Repository 메서드 검증 ──────────────────────────────────────────────────

def test_repo_has_get_impact():
    from app.repositories.organization import OrganizationRepository
    assert callable(getattr(OrganizationRepository, "get_impact", None))


def test_repo_has_delete_by_user():
    from app.repositories.organization import OrganizationRepository
    assert callable(getattr(OrganizationRepository, "delete_by_user", None))


def test_delete_by_user_checks_confirmation_in_source():
    """delete_by_user 소스에 confirmation 비교 로직 존재."""
    import inspect
    from app.repositories.organization import OrganizationRepository
    source = inspect.getsource(OrganizationRepository.delete_by_user)
    assert "confirmation" in source
    assert "org.name" in source


# ─── Schema 검증 ─────────────────────────────────────────────────────────────

def test_org_impact_response_fields():
    from app.schemas.organization import OrgImpactResponse
    fields = set(OrgImpactResponse.model_fields.keys())
    assert {"project_count", "member_count", "has_active_subscription"}.issubset(fields)


def test_delete_organization_schema():
    from app.schemas.organization import DeleteOrganization
    fields = set(DeleteOrganization.model_fields.keys())
    assert "confirmation" in fields
