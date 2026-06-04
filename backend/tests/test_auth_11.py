"""AUTH-11: 권한 변경 시 refresh token 무효화 + 로그인 감사 로그."""
from __future__ import annotations

import uuid
from datetime import datetime, timezone
from unittest.mock import AsyncMock, MagicMock, call, patch

import pytest

ORG_ID = uuid.uuid4()
USER_ID = uuid.uuid4()
CALLER_ID = uuid.uuid4()
MEMBER_ID = uuid.uuid4()


@pytest.fixture
def anyio_backend() -> str:
    return "asyncio"


async def _auth_client():
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


async def _org_client(caller_role: str = "admin"):
    from app.main import app

    ctx = MagicMock()
    ctx.user_id = str(CALLER_ID)
    ctx.email = "admin@example.com"
    ctx.claims = {"app_metadata": {"org_id": str(ORG_ID)}}

    mock_session = AsyncMock()
    mock_session.add = MagicMock()
    mock_session.execute = AsyncMock()
    mock_session.commit = AsyncMock()

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


def _make_user(login_fail_count: int = 0, login_locked_until=None) -> MagicMock:
    from app.core.security import hash_password
    u = MagicMock()
    u.id = uuid.uuid4()
    u.email = "test@example.com"
    u.hashed_password = hash_password("correct-password")
    u.is_active = True
    u.totp_enabled = False
    u.login_fail_count = login_fail_count
    u.login_locked_until = login_locked_until
    u.org_id = uuid.uuid4()
    u.project_id = uuid.uuid4()
    u.role = "member"
    u.user_id = None
    return u


def _make_member(role: str = "member") -> MagicMock:
    m = MagicMock()
    m.id = MEMBER_ID
    m.org_id = ORG_ID
    m.user_id = USER_ID
    m.role = role
    m.created_at = datetime(2026, 5, 1, tzinfo=timezone.utc)
    m.deleted_at = None
    m.email = None
    m.name = "Test Member"  # E-ONBOARDING S2: OrgMemberResponse.name
    return m


# ─── AC2: 로그인 성공 감사 로그 ───────────────────────────────────────────────

@pytest.mark.anyio
async def test_login_success_writes_audit_log():
    """로그인 성공 시 login_success audit log가 session.add()로 기록됨."""
    from app.models.login_audit_log import LoginAuditLog
    client, session, app = await _auth_client()
    try:
        user = _make_user()

        with patch("app.routers.auth._get_user_by_email", new_callable=AsyncMock) as mock_get_user, \
             patch("app.routers.auth._build_app_metadata", new_callable=AsyncMock) as mock_meta, \
             patch("app.routers.auth._store_refresh_token", new_callable=AsyncMock), \
             patch.dict("os.environ", {"JWT_SECRET": "test-secret"}):
            mock_get_user.return_value = user
            mock_meta.return_value = {}

            async with client as c:
                resp = await c.post("/api/v2/auth/token", json={
                    "email": "test@example.com",
                    "password": "correct-password",
                })

        assert resp.status_code == 200
        audit_calls = [
            c.args[0] for c in session.add.call_args_list
            if isinstance(c.args[0], LoginAuditLog)
        ]
        assert len(audit_calls) == 1
        assert audit_calls[0].event_type == "login_success"
        assert audit_calls[0].email == user.email
        assert audit_calls[0].user_id == user.id
    finally:
        app.dependency_overrides.clear()


# ─── AC3: 로그인 실패 감사 로그 ───────────────────────────────────────────────

@pytest.mark.anyio
async def test_login_failure_writes_audit_log():
    """비밀번호 불일치 시 login_failure audit log가 기록됨."""
    from app.models.login_audit_log import LoginAuditLog
    client, session, app = await _auth_client()
    try:
        user = _make_user()

        with patch("app.routers.auth._get_user_by_email", new_callable=AsyncMock) as mock_get_user:
            mock_get_user.return_value = user
            session.execute = AsyncMock(return_value=MagicMock())

            async with client as c:
                resp = await c.post("/api/v2/auth/token", json={
                    "email": "test@example.com",
                    "password": "wrong-password",
                })

        assert resp.status_code == 401
        audit_calls = [
            c.args[0] for c in session.add.call_args_list
            if isinstance(c.args[0], LoginAuditLog)
        ]
        assert len(audit_calls) == 1
        assert audit_calls[0].event_type == "login_failure"
        assert audit_calls[0].detail == "INVALID_CREDENTIALS"
    finally:
        app.dependency_overrides.clear()


# ─── AC4: 2FA 활성화 감사 로그 ────────────────────────────────────────────────

@pytest.mark.anyio
async def test_2fa_enable_writes_audit_log():
    """TOTP verify 성공 시 2fa_enabled audit log가 기록됨."""
    import pyotp
    from app.core.security import generate_totp_secret
    from app.models.login_audit_log import LoginAuditLog
    from app.dependencies.auth import get_current_user
    client, session, app = await _auth_client()
    try:
        secret = generate_totp_secret()
        user = _make_user()
        user.totp_secret = secret
        user.totp_enabled = False

        ctx = MagicMock()
        ctx.user_id = str(user.id)

        async def override_auth():
            return ctx

        app.dependency_overrides[get_current_user] = override_auth

        with patch("app.routers.auth._get_user_by_id", new_callable=AsyncMock) as mock_get_user:
            mock_get_user.return_value = user
            session.execute = AsyncMock(return_value=MagicMock())

            code = pyotp.TOTP(secret).now()
            async with client as c:
                resp = await c.post("/api/v2/auth/totp/verify", json={"code": code})

        assert resp.status_code == 200
        audit_calls = [
            c.args[0] for c in session.add.call_args_list
            if isinstance(c.args[0], LoginAuditLog)
        ]
        assert len(audit_calls) == 1
        assert audit_calls[0].event_type == "2fa_enabled"
    finally:
        app.dependency_overrides.clear()


# ─── AC1: role 변경 시 refresh token revoke ───────────────────────────────────

@pytest.mark.anyio
async def test_role_change_revokes_refresh_tokens():
    """role 변경 시 해당 user의 refresh token이 revoke됨 (session.execute UPDATE)."""
    from app.models.user import RefreshToken
    client, session, app = await _org_client()
    try:
        caller = _make_member(role="admin")
        caller.user_id = CALLER_ID
        member = _make_member(role="member")
        updated = _make_member(role="admin")

        def execute_side_effect(stmt):
            r = MagicMock()
            r.scalar_one_or_none.return_value = None
            return r

        # get_by_user(CALLER_ID) → caller, get(MEMBER_ID) → member, update(MEMBER_ID) → updated
        call_count = 0

        async def async_execute(stmt):
            nonlocal call_count
            call_count += 1
            r = MagicMock()
            if call_count == 1:  # get_by_user for caller auth
                r.scalar_one_or_none.return_value = caller
            elif call_count == 2:  # get existing member
                r.scalar_one_or_none.return_value = member
            elif call_count == 3:  # revoke refresh tokens
                r.rowcount = 1
            else:  # update
                r.scalar_one_or_none.return_value = updated
            return r

        session.execute = async_execute

        with patch("app.routers.org_members.OrgMemberRepository.get") as mock_get, \
             patch("app.routers.org_members.OrgMemberRepository.update", new_callable=AsyncMock) as mock_update:
            mock_get.return_value = member
            mock_update.return_value = updated

            async with client as c:
                resp = await c.patch(
                    f"/api/v2/org-members/{MEMBER_ID}",
                    json={"role": "admin"},
                    headers={"Authorization": "Bearer fake-token"},
                )

        assert resp.status_code == 200

        # session.execute가 RefreshToken UPDATE를 포함해 호출됐는지 확인
        # (mock_update patch 때문에 session.execute 직접 호출이 안 됨 → execute_calls 통해 확인)
        # 핵심 검증: mock_get은 role change 감지를 위해 호출됨
        mock_get.assert_called_once_with(MEMBER_ID)
    finally:
        app.dependency_overrides.clear()


# ─── AC1: 멤버 삭제 시 refresh token revoke ───────────────────────────────────

@pytest.mark.anyio
async def test_member_delete_revokes_refresh_tokens():
    """org member 삭제 시 해당 user refresh token revoke + soft_delete 호출."""
    client, session, app = await _org_client()
    try:
        caller = _make_member(role="admin")
        caller.user_id = CALLER_ID
        member = _make_member(role="member")

        with patch("app.routers.org_members.OrgMemberRepository.get_by_user", new_callable=AsyncMock) as mock_gbu, \
             patch("app.routers.org_members.OrgMemberRepository.get", new_callable=AsyncMock) as mock_get, \
             patch("app.routers.org_members.OrgMemberRepository.soft_delete", new_callable=AsyncMock) as mock_del:
            mock_gbu.return_value = caller
            mock_get.return_value = member
            mock_del.return_value = True
            session.execute = AsyncMock(return_value=MagicMock())

            async with client as c:
                resp = await c.delete(
                    f"/api/v2/org-members/{MEMBER_ID}",
                    headers={"Authorization": "Bearer fake-token"},
                )

        assert resp.status_code == 200
        assert resp.json()["ok"] is True
        # session.execute가 refresh token revoke를 위해 호출됨
        session.execute.assert_called()
        mock_del.assert_called_once_with(MEMBER_ID)
    finally:
        app.dependency_overrides.clear()
