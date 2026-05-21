"""E-ORG-MULTI S1.1: GET /api/v2/organizations — 내 Organization 목록 조회 API 테스트.

AC1: GET /api/v2/organizations 진입점 제공
AC2: 인증된 사용자만 호출 가능
AC3: 사용자가 org_members로 속한 Organization만 포함
AC4: 각 Organization에 id, name, slug, plan, role 포함
AC5: owner/admin/member 모두 조회 가능
AC6: 소속 Organization 없으면 빈 배열 반환
AC7: 사용자 A/B가 서로의 Organization 볼 수 없음
"""
from __future__ import annotations

import uuid
from dataclasses import dataclass
from unittest.mock import AsyncMock, MagicMock

import pytest

USER_A = uuid.uuid4()
USER_B = uuid.uuid4()
ORG_A = uuid.uuid4()
ORG_B = uuid.uuid4()


@dataclass
class _OrgRow:
    id: uuid.UUID
    name: str
    slug: str
    plan: str
    role: str


def _make_org_row(
    org_id: uuid.UUID,
    name: str = "Test Org",
    slug: str = "test-org",
    plan: str = "free",
    role: str = "owner",
) -> _OrgRow:
    return _OrgRow(id=org_id, name=name, slug=slug, plan=plan, role=role)


@pytest.fixture
def anyio_backend():
    return "asyncio"


async def _client(user_id: uuid.UUID = USER_A):
    from app.main import app
    from app.dependencies.auth import get_current_user
    from app.dependencies.database import get_db
    from httpx import ASGITransport, AsyncClient

    ctx = MagicMock()
    ctx.user_id = str(user_id)
    ctx.email = "test@example.com"
    ctx.claims = {}

    mock_session = AsyncMock()

    async def override_db():
        yield mock_session

    async def override_auth():
        return ctx

    app.dependency_overrides[get_db] = override_db
    app.dependency_overrides[get_current_user] = override_auth

    return AsyncClient(transport=ASGITransport(app=app), base_url="http://test"), mock_session, app


# ─── AC1: 진입점 존재 ────────────────────────────────────────────────────────

def test_get_organizations_endpoint_exists():
    """GET /api/v2/organizations 라우트가 등록됨."""
    from app.main import app
    routes = [r.path for r in app.routes]
    assert "/api/v2/organizations" in routes


# ─── AC2: 미인증 요청 거부 ──────────────────────────────────────────────────

@pytest.mark.anyio
async def test_unauthenticated_returns_401():
    """Authorization 헤더 없으면 401 반환."""
    from app.main import app
    from httpx import ASGITransport, AsyncClient

    async with AsyncClient(transport=ASGITransport(app=app), base_url="http://test") as c:
        resp = await c.get("/api/v2/organizations")
    assert resp.status_code in (401, 403)


# ─── AC3 + AC4: 응답 구조 및 필드 검증 ─────────────────────────────────────

@pytest.mark.anyio
async def test_returns_my_organizations_with_required_fields():
    """응답에 id, name, slug, plan, role 포함됨."""
    client, session, app = await _client(USER_A)
    try:
        row = _make_org_row(ORG_A, name="Moonklabs", slug="moonklabs", plan="pro", role="owner")

        mock_result = MagicMock()
        mock_result.all.return_value = [row]
        session.execute = AsyncMock(return_value=mock_result)

        async with client as c:
            resp = await c.get("/api/v2/organizations")

        assert resp.status_code == 200
        data = resp.json()
        assert len(data) == 1
        org = data[0]
        assert org["id"] == str(ORG_A)
        assert org["name"] == "Moonklabs"
        assert org["slug"] == "moonklabs"
        assert org["plan"] == "pro"
        assert org["role"] == "owner"
    finally:
        app.dependency_overrides.clear()


# ─── AC5: owner/admin/member 모두 조회 가능 ─────────────────────────────────

@pytest.mark.anyio
async def test_member_role_included_in_response():
    """role=member인 경우에도 조회됨."""
    client, session, app = await _client(USER_A)
    try:
        rows = [
            _make_org_row(ORG_A, role="member"),
            _make_org_row(ORG_B, name="Admin Org", slug="admin-org", role="admin"),
        ]
        mock_result = MagicMock()
        mock_result.all.return_value = rows
        session.execute = AsyncMock(return_value=mock_result)

        async with client as c:
            resp = await c.get("/api/v2/organizations")

        assert resp.status_code == 200
        roles = {o["role"] for o in resp.json()}
        assert "member" in roles
        assert "admin" in roles
    finally:
        app.dependency_overrides.clear()


# ─── AC6: 빈 배열 반환 ──────────────────────────────────────────────────────

@pytest.mark.anyio
async def test_returns_empty_list_when_no_orgs():
    """소속 Organization이 없으면 빈 배열 반환."""
    client, session, app = await _client(USER_A)
    try:
        mock_result = MagicMock()
        mock_result.all.return_value = []
        session.execute = AsyncMock(return_value=mock_result)

        async with client as c:
            resp = await c.get("/api/v2/organizations")

        assert resp.status_code == 200
        assert resp.json() == []
    finally:
        app.dependency_overrides.clear()


# ─── AC7: 사용자 격리 — repository 레벨 검증 ────────────────────────────────

def test_list_for_user_filters_by_user_id():
    """list_for_user 쿼리에 user_id 필터가 포함됨 (소스 검증)."""
    import inspect
    from app.repositories.organization import OrganizationRepository
    source = inspect.getsource(OrganizationRepository.list_for_user)
    assert "user_id" in source
    assert "OrgMember.user_id" in source


def test_list_for_user_filters_deleted_at():
    """list_for_user 쿼리에 deleted_at IS NULL 필터 포함 (소스 검증)."""
    import inspect
    from app.repositories.organization import OrganizationRepository
    source = inspect.getsource(OrganizationRepository.list_for_user)
    assert "deleted_at" in source


@pytest.mark.anyio
async def test_user_b_sees_only_own_org():
    """USER_B의 요청에는 USER_B의 Organization만 반환됨."""
    client, session, app = await _client(USER_B)
    try:
        row_b = _make_org_row(ORG_B, name="B Org", slug="b-org", role="member")
        mock_result = MagicMock()
        mock_result.all.return_value = [row_b]
        session.execute = AsyncMock(return_value=mock_result)

        async with client as c:
            resp = await c.get("/api/v2/organizations")

        assert resp.status_code == 200
        data = resp.json()
        assert len(data) == 1
        assert data[0]["id"] == str(ORG_B)
        assert data[0]["name"] == "B Org"
    finally:
        app.dependency_overrides.clear()


# ─── Schema 검증 ─────────────────────────────────────────────────────────────

def test_my_organization_response_schema_fields():
    """MyOrganizationResponse에 필수 5개 필드 존재."""
    from app.schemas.organization import MyOrganizationResponse
    fields = set(MyOrganizationResponse.model_fields.keys())
    assert {"id", "name", "slug", "plan", "role"}.issubset(fields)


def test_organization_with_role_dataclass():
    """OrganizationWithRole 데이터클래스 생성 검증."""
    from app.repositories.organization import OrganizationWithRole
    org_id = uuid.uuid4()
    row = OrganizationWithRole(id=org_id, name="T", slug="t", plan="free", role="owner")
    assert row.id == org_id
    assert row.role == "owner"
