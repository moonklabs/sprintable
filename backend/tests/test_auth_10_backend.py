"""AUTH-10 백엔드: set-password 엔드포인트 + has_password 필드."""
from __future__ import annotations

import uuid
from unittest.mock import AsyncMock, MagicMock, patch

import pytest


@pytest.fixture
def anyio_backend() -> str:
    return "asyncio"


async def _client():
    from app.main import app
    from app.dependencies.database import get_db

    mock_session = AsyncMock()
    mock_session.add = MagicMock()
    mock_session.flush = AsyncMock()
    mock_session.commit = AsyncMock()

    async def override_db():
        yield mock_session

    app.dependency_overrides[get_db] = override_db

    from httpx import ASGITransport, AsyncClient
    return AsyncClient(transport=ASGITransport(app=app), base_url="http://test"), mock_session, app


def _make_oauth_user() -> MagicMock:
    u = MagicMock()
    u.id = uuid.uuid4()
    u.email = "oauth@example.com"
    u.hashed_password = ""
    u.is_active = True
    return u


def _make_password_user() -> MagicMock:
    from app.core.security import hash_password
    u = MagicMock()
    u.id = uuid.uuid4()
    u.email = "pw@example.com"
    u.hashed_password = hash_password("Existing1!")
    u.is_active = True
    return u


def _make_auth_ctx(user_id: uuid.UUID) -> MagicMock:
    ctx = MagicMock()
    ctx.user_id = str(user_id)
    ctx.claims = {"app_metadata": {}}
    return ctx


# ─── POST /api/v2/auth/set-password/request ──────────────────────────────────
# story #ab2a503f(2026-09-01) — 구 POST /set-password(재인증 0으로 즉시 write)는 완전히
# 제거되고 이메일 확인 2단계(request→confirm)로 대체됐다. 이 파일의 나머지 3건은 구
# 엔드포인트를 직접 쳤던 자리라 새 request 엔드포인트로 갱신한다 — request/confirm 전체
# 계약(성공/거부/토큰 왕복/refresh revoke)의 상세 pin은
# tests/test_ab2a503f_set_password_reauth.py가 전담한다.

@pytest.mark.anyio
async def test_set_password_success_200():
    """OAuth 사용자 (hashed_password == '') — request 성공(확인 메일 발송, 아직 비번 미설정)."""
    from app.dependencies.auth import get_current_user
    client, session, app = await _client()
    try:
        user = _make_oauth_user()
        ctx = _make_auth_ctx(user.id)

        async def override_auth():
            return ctx

        app.dependency_overrides[get_current_user] = override_auth

        with patch("app.routers.auth._get_user_by_id", new_callable=AsyncMock) as mock_user, \
             patch("app.services.email.send_email", return_value=True):
            mock_user.return_value = user
            session.execute = AsyncMock(return_value=MagicMock())

            async with client as c:
                resp = await c.post("/api/v2/auth/set-password/request", json={"new_password": "NewPass1!"})

        assert resp.status_code == 200
        assert resp.json()["data"]["delivered"] is True
    finally:
        app.dependency_overrides.clear()


@pytest.mark.anyio
async def test_set_password_already_has_password_400():
    """이미 비밀번호 있는 사용자 → 400 ALREADY_HAS_PASSWORD(request 단계에서 그대로 유지)."""
    from app.dependencies.auth import get_current_user
    client, session, app = await _client()
    try:
        user = _make_password_user()
        ctx = _make_auth_ctx(user.id)

        async def override_auth():
            return ctx

        app.dependency_overrides[get_current_user] = override_auth

        with patch("app.routers.auth._get_user_by_id", new_callable=AsyncMock) as mock_user:
            mock_user.return_value = user

            async with client as c:
                resp = await c.post("/api/v2/auth/set-password/request", json={"new_password": "NewPass1!"})

        assert resp.status_code == 400
        assert resp.json()["error"]["code"] == "ALREADY_HAS_PASSWORD"
    finally:
        app.dependency_overrides.clear()


@pytest.mark.anyio
async def test_set_password_weak_password_422():
    """비밀번호 validation 실패 (너무 짧음) → 422(SetPasswordRequest 그대로 재사용)."""
    from app.dependencies.auth import get_current_user
    client, session, app = await _client()
    try:
        user = _make_oauth_user()
        ctx = _make_auth_ctx(user.id)

        async def override_auth():
            return ctx

        app.dependency_overrides[get_current_user] = override_auth

        async with client as c:
            resp = await c.post("/api/v2/auth/set-password/request", json={"new_password": "abc"})

        assert resp.status_code == 422
    finally:
        app.dependency_overrides.clear()


# ─── GET /api/v2/me — has_password 필드 ─────────────────────────────────────

@pytest.mark.anyio
async def test_get_me_has_password_true():
    """비밀번호 있는 사용자 → has_password: true."""
    from app.dependencies.auth import get_current_user
    client, session, app = await _client()
    try:
        from app.core.security import hash_password
        uid = uuid.uuid4()
        ctx = _make_auth_ctx(uid)
        ctx.claims = {"app_metadata": {}}

        project = MagicMock()
        project.name = "Test Project"
        member = MagicMock()
        member.id = uuid.uuid4()
        member.user_id = uid
        member.org_id = uuid.uuid4()
        member.project_id = uuid.uuid4()
        member.name = "Test User"
        member.type = "human"
        member.role = "member"
        member.is_active = True
        member.email = "user@example.com"  # E-ONBOARDING S2: MeResponse.email
        member.project_name = None
        member.has_password = None
        member.project = project

        user_mock = MagicMock()
        user_mock.id = uid
        user_mock.email = "user@example.com"  # E-ONBOARDING S2: data.email = user.email
        user_mock.hashed_password = hash_password("Pass1!")

        async def override_auth():
            return ctx

        app.dependency_overrides[get_current_user] = override_auth

        call_count = 0

        async def mock_execute(stmt, *args, **kwargs):
            nonlocal call_count
            call_count += 1
            r = MagicMock()
            if call_count == 1:
                r.scalars.return_value.first.return_value = member
            else:
                r.scalar_one_or_none.return_value = user_mock
            return r

        session.execute = mock_execute

        async with client as c:
            resp = await c.get("/api/v2/me")

        assert resp.status_code == 200
        assert resp.json()["has_password"] is True
    finally:
        app.dependency_overrides.clear()


@pytest.mark.anyio
async def test_get_me_has_password_false():
    """OAuth 사용자 (hashed_password='') → has_password: false."""
    from app.dependencies.auth import get_current_user
    client, session, app = await _client()
    try:
        uid = uuid.uuid4()
        ctx = _make_auth_ctx(uid)
        ctx.claims = {"app_metadata": {}}

        project = MagicMock()
        project.name = "Test Project"
        member = MagicMock()
        member.id = uuid.uuid4()
        member.user_id = uid
        member.org_id = uuid.uuid4()
        member.project_id = uuid.uuid4()
        member.name = "OAuth User"
        member.type = "human"
        member.role = "member"
        member.is_active = True
        member.email = "user@example.com"  # E-ONBOARDING S2: MeResponse.email
        member.project_name = None
        member.has_password = None
        member.project = project

        user_mock = MagicMock()
        user_mock.id = uid
        user_mock.email = "user@example.com"  # E-ONBOARDING S2: data.email = user.email
        user_mock.hashed_password = ""

        async def override_auth():
            return ctx

        app.dependency_overrides[get_current_user] = override_auth

        call_count = 0

        async def mock_execute(stmt, *args, **kwargs):
            nonlocal call_count
            call_count += 1
            r = MagicMock()
            if call_count == 1:
                r.scalars.return_value.first.return_value = member
            else:
                r.scalar_one_or_none.return_value = user_mock
            return r

        session.execute = mock_execute

        async with client as c:
            resp = await c.get("/api/v2/me")

        assert resp.status_code == 200
        assert resp.json()["has_password"] is False
    finally:
        app.dependency_overrides.clear()
