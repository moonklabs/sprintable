"""E-ORG-MULTI S2.1: POST /api/v2/auth/switch-org — Organization 전환 API 테스트.

AC1: POST /api/v2/auth/switch-org 진입점 제공
AC2: 요청자는 대상 Organization의 member여야 함
AC3: member가 아닌 Organization 전환 시 403
AC4: 성공 시 JWT에 새 org_id 반영된 새 토큰 반환
AC5: project_id가 응답에 포함되어 쿠키 설정 가능
AC6: org_id fallback — team_member 없어도 org_id 반영
"""
from __future__ import annotations

import uuid
from datetime import datetime, timezone
from unittest.mock import AsyncMock, MagicMock, patch

import pytest

USER_ID = uuid.uuid4()
ORG_A = uuid.uuid4()
ORG_B = uuid.uuid4()
PROJECT_A = uuid.uuid4()


def _mock_user(user_id: uuid.UUID = USER_ID) -> MagicMock:
    u = MagicMock()
    u.id = user_id
    u.email = "user@example.com"
    u.is_active = True
    u.last_project_id = None
    u.login_fail_count = 0
    u.login_locked_until = None
    return u


def _mock_org_member(org_id: uuid.UUID, user_id: uuid.UUID) -> MagicMock:
    m = MagicMock()
    m.org_id = org_id
    m.user_id = user_id
    m.role = "owner"
    m.deleted_at = None
    return m


def _mock_team_member(org_id: uuid.UUID, project_id: uuid.UUID, user_id: uuid.UUID) -> MagicMock:
    tm = MagicMock()
    tm.id = uuid.uuid4()
    tm.org_id = org_id
    tm.project_id = project_id
    tm.user_id = user_id
    tm.role = "owner"
    tm.is_active = True
    tm.created_at = datetime(2026, 5, 1, tzinfo=timezone.utc)
    return tm


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
    ctx.email = "user@example.com"
    ctx.claims = {"app_metadata": {"org_id": str(ORG_A)}}

    mock_session = AsyncMock()

    async def override_db():
        yield mock_session

    async def override_auth():
        return ctx

    app.dependency_overrides[get_db] = override_db
    app.dependency_overrides[get_current_user] = override_auth

    return AsyncClient(transport=ASGITransport(app=app), base_url="http://test"), mock_session, app


# ─── AC1: 진입점 존재 ────────────────────────────────────────────────────────

def test_switch_org_endpoint_exists():
    """POST /api/v2/auth/switch-org 라우트가 등록됨."""
    from app.main import app
    paths = {getattr(r, "path", "") for r in app.routes}
    assert "/api/v2/auth/switch-org" in paths


# ─── AC2 + AC4: 정상 전환 ────────────────────────────────────────────────────

@pytest.mark.anyio
async def test_switch_org_success_returns_tokens():
    """org_member인 경우 200 + 새 토큰 반환."""
    client, session, app = await _client()
    try:
        user = _mock_user()
        org_member = _mock_org_member(ORG_B, USER_ID)
        team_member = _mock_team_member(ORG_B, PROJECT_A, USER_ID)

        call_count = 0

        def _execute_side_effect(stmt, *args, **kwargs):
            nonlocal call_count
            call_count += 1
            result = MagicMock()
            if call_count == 1:
                # _get_user_by_id
                result.scalar_one_or_none.return_value = user
            elif call_count == 2:
                # org_members 소속 확인
                result.scalar_one_or_none.return_value = org_member
            elif call_count == 3:
                # team_member 조회
                result.scalar_one_or_none.return_value = team_member
            else:
                result.scalar_one_or_none.return_value = None
                result.scalars.return_value.all.return_value = []
            return result

        session.execute = AsyncMock(side_effect=_execute_side_effect)
        session.commit = AsyncMock()
        session.add = MagicMock()

        with patch("app.routers.auth.create_tokens") as mock_create_tokens, \
             patch("app.routers.auth.create_refresh_token") as mock_crt, \
             patch("app.routers.auth._store_refresh_token") as mock_store, \
             patch("app.routers.auth.first_accessible_project_id", new_callable=AsyncMock) as mock_fap:
            mock_fap.return_value = PROJECT_A
            mock_create_tokens.return_value = {
                "access_token": "new_at",
                "refresh_token": "new_rt",
                "token_type": "bearer",
                "expires_in": 900,
                "refresh_expires_at": "2026-06-20T00:00:00",
            }
            mock_crt.return_value = ("new_rt", datetime(2026, 6, 20, tzinfo=timezone.utc))
            mock_store.return_value = None

            async with client as c:
                resp = await c.post(
                    "/api/v2/auth/switch-org",
                    json={"org_id": str(ORG_B)},
                )

        assert resp.status_code == 200
        data = resp.json()["data"]
        assert "access_token" in data
        assert "refresh_token" in data
    finally:
        app.dependency_overrides.clear()


# ─── AC3: 비멤버 403 ─────────────────────────────────────────────────────────

@pytest.mark.anyio
async def test_switch_org_non_member_returns_403():
    """소속이 아닌 org로 전환 시 403 반환."""
    client, session, app = await _client()
    try:
        user = _mock_user()
        call_count = 0

        def _execute_side_effect(stmt, *args, **kwargs):
            nonlocal call_count
            call_count += 1
            result = MagicMock()
            if call_count == 1:
                result.scalar_one_or_none.return_value = user
            else:
                result.scalar_one_or_none.return_value = None
            return result

        session.execute = AsyncMock(side_effect=_execute_side_effect)

        async with client as c:
            resp = await c.post(
                "/api/v2/auth/switch-org",
                json={"org_id": str(uuid.uuid4())},
            )

        assert resp.status_code == 403
        err = resp.json()["error"]
        assert err["code"] == "NOT_ORG_MEMBER"
    finally:
        app.dependency_overrides.clear()


# ─── AC2: 미인증 요청 거부 ──────────────────────────────────────────────────

@pytest.mark.anyio
async def test_switch_org_unauthenticated_returns_401():
    """Authorization 없으면 401."""
    from app.main import app
    from httpx import ASGITransport, AsyncClient

    async with AsyncClient(transport=ASGITransport(app=app), base_url="http://test") as c:
        resp = await c.post("/api/v2/auth/switch-org", json={"org_id": str(uuid.uuid4())})
    assert resp.status_code in (401, 403)


# ─── AC5: project_id 응답 포함 ──────────────────────────────────────────────

def test_switch_org_endpoint_returns_project_id_in_source():
    """switch_organization 소스에 project_id 응답 포함 로직 존재."""
    import inspect
    from app.routers import auth as auth_module
    source = inspect.getsource(auth_module.switch_organization)
    assert "project_id" in source


# ─── AC6: org_id fallback ────────────────────────────────────────────────────

def test_switch_org_unconditionally_sets_org_id():
    """switch-org는 조건 없이 target org_id를 무조건 덮어씀 (old org 오염 원천 차단)."""
    import inspect
    from app.routers import auth as auth_module
    source = inspect.getsource(auth_module.switch_organization)
    assert 'app_metadata["org_id"] = str(body.org_id)' in source


# ─── AC2-2 회귀: 접근 가능 project 없는 org 전환 → 500 금지 (8a5f260c) ─────────

@pytest.mark.anyio
async def test_switch_org_no_accessible_project_returns_200_null_project():
    """first_accessible_project_id=None(접근 project 없음)이어도 undefined team_member
    참조로 500나지 않고 200 + project_id null 반환 (8a5f260c switch500 회귀)."""
    client, session, app = await _client()
    try:
        user = _mock_user()
        org_member = _mock_org_member(ORG_B, USER_ID)

        call_count = 0

        def _execute_side_effect(stmt, *args, **kwargs):
            nonlocal call_count
            call_count += 1
            result = MagicMock()
            if call_count == 1:
                result.scalar_one_or_none.return_value = user      # _get_user_by_id
            elif call_count == 2:
                result.scalar_one_or_none.return_value = org_member  # org 소속 확인
            else:
                # 이후 _build_app_metadata 등: project/team_member 미존재
                result.scalar_one_or_none.return_value = None
                result.scalars.return_value.all.return_value = []
            return result

        session.execute = AsyncMock(side_effect=_execute_side_effect)
        session.commit = AsyncMock()
        session.add = MagicMock()

        with patch("app.routers.auth.create_tokens") as mock_create_tokens, \
             patch("app.routers.auth.create_refresh_token") as mock_crt, \
             patch("app.routers.auth._store_refresh_token") as mock_store, \
             patch("app.routers.auth.first_accessible_project_id", new_callable=AsyncMock) as mock_fap:
            mock_fap.return_value = None  # 접근 가능 project 없음
            mock_create_tokens.return_value = {
                "access_token": "new_at", "refresh_token": "new_rt",
                "token_type": "bearer", "expires_in": 900,
                "refresh_expires_at": "2026-06-20T00:00:00",
            }
            mock_crt.return_value = ("new_rt", datetime(2026, 6, 20, tzinfo=timezone.utc))
            mock_store.return_value = None

            async with client as c:
                resp = await c.post("/api/v2/auth/switch-org", json={"org_id": str(ORG_B)})

        assert resp.status_code == 200
        assert resp.json()["data"]["project_id"] is None
    finally:
        app.dependency_overrides.clear()


# ─── Schema 검증 ─────────────────────────────────────────────────────────────

def test_switch_organization_request_schema():
    """SwitchOrganizationRequest에 org_id 필드 존재."""
    from app.routers.auth import SwitchOrganizationRequest
    fields = set(SwitchOrganizationRequest.model_fields.keys())
    assert "org_id" in fields
