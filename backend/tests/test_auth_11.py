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
# story #3491(페드루 PO 확認, PR#3840 CI 회귀) — caller의 org_member 행 id는
# target(MEMBER_ID)과 별개다(test_org_members.py::_mock_member와 동일 처방 —
# 둘 다 MEMBER_ID로 겹치면 owner 보호 가드의 자기 자신 판정이 거짓양성으로 뜬다).
CALLER_MEMBER_ROW_ID = uuid.uuid4()


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


def _make_member(role: str = "member", id: uuid.UUID | None = None) -> MagicMock:
    m = MagicMock()
    m.id = id or MEMBER_ID
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
    client, session, app = await _org_client()
    try:
        # story #3491(페드루 PO 확認, PR#3840 CI 회귀) — 이 테스트는 원래 raw
        # session.execute 호출 "순서"를 세어 get_by_user/get/update 응답을 갈아
        # 끼웠다. update_org_member가 owner 보호 가드를 위해 get_by_user를 한 번
        # 더 부르면서(caller 재조회) 그 순서 번호가 밀려, 두 번째 get_by_user
        # 호출이 "revoke UPDATE" 자리의 응답(사실상 member 자신)을 caller로
        # 잘못 받아 «자기 행» 오판(403)으로 떨어졌다 — 실제로는 caller/target이
        # 다른 사람인데 카운터 밀림이 같은 사람으로 보이게 만든 것.
        # 처방 — get_by_user/get/update를 각각 명시로 patch(메서드 단위, 호출
        # 순서에 의존하지 않는다). session.execute는 이제 revoke UPDATE 이 한
        # 자리에만 남는다.
        caller = _make_member(role="admin", id=CALLER_MEMBER_ROW_ID)
        caller.user_id = CALLER_ID
        member = _make_member(role="member")
        updated = _make_member(role="admin")

        session.execute = AsyncMock(return_value=MagicMock(rowcount=1))

        with patch("app.routers.org_members.OrgMemberRepository.get_by_user", new_callable=AsyncMock) as mock_gbu, \
             patch("app.routers.org_members.OrgMemberRepository.get") as mock_get, \
             patch("app.routers.org_members.OrgMemberRepository.update", new_callable=AsyncMock) as mock_update:
            mock_gbu.return_value = caller
            mock_get.return_value = member
            mock_update.return_value = updated

            async with client as c:
                resp = await c.patch(
                    f"/api/v2/org-members/{MEMBER_ID}",
                    json={"role": "admin"},
                    headers={"Authorization": "Bearer fake-token"},
                )

        assert resp.status_code == 200
        # session.execute가 RefreshToken UPDATE(revoke)를 위해 호출됨.
        session.execute.assert_called()
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
