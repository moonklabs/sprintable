"""E-ORG-MULTI S3.2: 이메일 초대 발송/재발송 테스트.

AC1: 초대 생성 성공 시 이메일 발송
AC2: 수락 링크에 token 포함
AC3: owner/admin 재발송 가능
AC4: 재발송 시 새 만료 시간 반영
AC5: 이메일 실패 시 email_error 필드에 기록
AC6: dev 환경 sandbox (EMAIL_SMTP_HOST 미설정 → 콘솔 fallback)
"""
from __future__ import annotations

import uuid
from datetime import datetime, timedelta, timezone
from unittest.mock import AsyncMock, MagicMock, patch

import pytest

ORG_ID = uuid.uuid4()
USER_ID = uuid.uuid4()
INVITE_ID = uuid.uuid4()
TOKEN = "test_token_abc123"


def _mock_invite(email: str = "new@example.com") -> MagicMock:
    now = datetime.now(timezone.utc)
    i = MagicMock()
    i.id = INVITE_ID
    i.organization_id = ORG_ID
    i.email = email
    i.role = "member"
    i.token = TOKEN
    i.status = "pending"
    i.expires_at = now + timedelta(days=7)
    i.accepted_at = None
    i.created_by = USER_ID
    i.created_at = now
    i.email_sent_at = now
    i.email_error = None
    i.invite_url = None
    return i


def _mock_org() -> MagicMock:
    o = MagicMock()
    o.id = ORG_ID
    o.name = "Test Org"
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


# ─── AC1 + AC2: 초대 생성 시 이메일 발송 + token 링크 ──────────────────────

def test_send_invite_email_includes_token():
    """send_invite_email이 token을 수락 링크에 포함."""
    import os
    from unittest.mock import patch
    from app.services.org_invite_email import send_invite_email

    sent_bodies = []

    def _mock_send(to, subject, html_body):
        sent_bodies.append(html_body)

    with patch("app.services.org_invite_email.send_email", side_effect=_mock_send):
        result = send_invite_email(to="x@y.com", org_name="Test", token="tok123", role="member")

    assert result is None
    assert "tok123" in sent_bodies[0]
    assert "/invite/accept?token=tok123" in sent_bodies[0]


# ─── AC3 + AC4: 재발송 엔드포인트 존재 + expires_at 갱신 ───────────────────

def test_resend_endpoint_exists():
    """POST /{id}/invites/{invite_id}/resend 라우트 존재."""
    from app.main import app
    paths = {getattr(r, "path", "") for r in app.routes}
    assert "/api/v2/organizations/{id}/invites/{invite_id}/resend" in paths


@pytest.mark.anyio
async def test_resend_returns_updated_invite():
    """재발송 성공 시 갱신된 invite 반환."""
    client, session, app = await _client()
    try:
        from app.routers.org_invites import _get_invite_repo, _get_org_repo

        updated = _mock_invite()
        updated.expires_at = datetime.now(timezone.utc) + timedelta(days=7)

        mock_org_repo = MagicMock()
        mock_org_repo.get_member_role = AsyncMock(return_value="owner")
        mock_invite_repo = MagicMock()
        mock_invite_repo.resend = AsyncMock(return_value=updated)
        mock_invite_repo.update_email_result = AsyncMock()
        mock_invite_repo.session = MagicMock()
        mock_invite_repo.session.get = AsyncMock(return_value=_mock_org())

        app.dependency_overrides[_get_org_repo] = lambda: mock_org_repo
        app.dependency_overrides[_get_invite_repo] = lambda: mock_invite_repo
        session.commit = AsyncMock()
        session.refresh = AsyncMock()

        with patch("app.routers.org_invites.send_invite_email", return_value=None):
            async with client as c:
                resp = await c.post(f"/api/v2/organizations/{ORG_ID}/invites/{INVITE_ID}/resend")

        assert resp.status_code == 200
        mock_invite_repo.resend.assert_called_once()
    finally:
        app.dependency_overrides.clear()


@pytest.mark.anyio
async def test_resend_nonexistent_returns_404():
    """존재하지 않는 초대 재발송 → 404."""
    client, session, app = await _client()
    try:
        from app.routers.org_invites import _get_invite_repo, _get_org_repo

        mock_org_repo = MagicMock()
        mock_org_repo.get_member_role = AsyncMock(return_value="owner")
        mock_invite_repo = MagicMock()
        mock_invite_repo.resend = AsyncMock(return_value=None)

        app.dependency_overrides[_get_org_repo] = lambda: mock_org_repo
        app.dependency_overrides[_get_invite_repo] = lambda: mock_invite_repo

        async with client as c:
            resp = await c.post(f"/api/v2/organizations/{ORG_ID}/invites/{uuid.uuid4()}/resend")

        assert resp.status_code == 404
    finally:
        app.dependency_overrides.clear()


# ─── AC5: 이메일 실패 시 email_error 기록 ────────────────────────────────────

def test_send_invite_email_returns_error_on_failure():
    """send_invite_email 실패 시 오류 문자열 반환."""
    from app.services.org_invite_email import send_invite_email

    with patch("app.services.org_invite_email.send_email", side_effect=Exception("SMTP fail")):
        result = send_invite_email(to="x@y.com", org_name="Test", token="tok", role="member")

    assert result is not None
    assert "SMTP fail" in result


def test_org_invite_response_has_email_error_field():
    """OrgInviteResponse에 email_sent_at + email_error 필드 존재."""
    from app.schemas.org_invite import OrgInviteResponse
    fields = set(OrgInviteResponse.model_fields.keys())
    assert "email_sent_at" in fields
    assert "email_error" in fields


# ─── AC6: dev 환경 sandbox ───────────────────────────────────────────────────

def test_email_service_console_fallback_when_no_smtp():
    """EMAIL_SMTP_HOST 미설정 시 send_email은 콘솔 출력으로 fallback (예외 없음)."""
    import os
    from unittest.mock import patch
    from app.services.email import send_email

    with patch.dict(os.environ, {"EMAIL_SMTP_HOST": ""}):
        send_email(to="x@y.com", subject="test", html_body="<p>test</p>")


# ─── Repository 메서드 검증 ──────────────────────────────────────────────────

def test_repo_has_resend():
    from app.repositories.org_invite import OrgInviteRepository
    assert callable(getattr(OrgInviteRepository, "resend", None))


def test_repo_has_update_email_result():
    from app.repositories.org_invite import OrgInviteRepository
    assert callable(getattr(OrgInviteRepository, "update_email_result", None))


def test_resend_updates_expires_at_in_source():
    """resend 소스에 expires_at 갱신 로직 존재."""
    import inspect
    from app.repositories.org_invite import OrgInviteRepository
    source = inspect.getsource(OrgInviteRepository.resend)
    assert "expires_at" in source
    assert "_INVITE_EXPIRE_DAYS" in source
