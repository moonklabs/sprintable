"""S-INV-03: 초대 이메일 발송 기반 구축.

AC1: 초대 생성 시 자동 발송 — 조직명, 초대자명, 수락 링크 포함
AC2: HTML 이메일 템플릿 — 수락 버튼 CTA
AC3: 발송 실패 시 email_error 기록, 재발송 API 동작
AC4: invite_url(링크 복사용) InvitationResponse에 포함
"""
from __future__ import annotations

import inspect
import uuid
from datetime import datetime, timedelta, timezone
from unittest.mock import AsyncMock, MagicMock, patch

import pytest


# ─── AC2: 이메일 템플릿 검증 ─────────────────────────────────────────────────

def test_invite_html_contains_button():
    """HTML 템플릿에 CTA 버튼 포함."""
    from app.services.org_invite_email import _build_invite_html
    html = _build_invite_html(
        org_name="Sprintable",
        inviter_name="오르테가",
        accept_link="https://app.sprintable.ai/invite/accept?token=abc",
        role="member",
    )
    assert "초대 수락하기" in html
    assert "https://app.sprintable.ai/invite/accept?token=abc" in html
    assert "오르테가" in html
    assert "Sprintable" in html


def test_invite_html_contains_role():
    """HTML 템플릿에 role 표시."""
    from app.services.org_invite_email import _build_invite_html
    html = _build_invite_html(
        org_name="Moonklabs",
        inviter_name="테스터",
        accept_link="https://example.com/invite",
        role="admin",
    )
    assert "admin" in html


def test_invite_html_inviter_fallback():
    """inviter_name 미전달 시 '팀 관리자' 표시."""
    from app.services.org_invite_email import send_invite_email
    captured = {}

    def mock_send(*, to, subject, html_body):
        captured["html"] = html_body

    with patch("app.services.org_invite_email.send_email", side_effect=lambda **kw: mock_send(**kw)):
        # inviter_name 미전달
        send_invite_email(to="test@example.com", org_name="Org", token="tok", role="member")

    assert "팀 관리자" in captured.get("html", "")


# ─── AC1: 이메일 자동 발송 라우터 검증 ────────────────────────────────────────

def test_create_invitation_calls_send_invite_email():
    """create_invitation 소스에 send_invite_email 호출 존재."""
    from app.routers import invitations as inv_module
    source = inspect.getsource(inv_module.create_invitation)
    assert "send_invite_email" in source
    assert "inviter_name" in source


def test_resend_invitation_calls_send_invite_email():
    """resend_invitation 소스에 send_invite_email 호출 존재."""
    from app.routers import invitations as inv_module
    source = inspect.getsource(inv_module.resend_invitation)
    assert "send_invite_email" in source


# ─── AC3: 발송 실패 시 email_error 기록 ──────────────────────────────────────

def test_invitation_model_has_email_fields():
    """Invitation 모델에 email_sent_at, email_error 컬럼 존재."""
    from app.models.invitation import Invitation
    cols = {c.name for c in Invitation.__table__.columns}
    assert "email_sent_at" in cols
    assert "email_error" in cols


def test_invitation_response_has_email_fields():
    """InvitationResponse에 email_sent_at, email_error, invite_url 필드 존재."""
    from app.schemas.invitation import InvitationResponse
    fields = set(InvitationResponse.model_fields.keys())
    assert {"email_sent_at", "email_error", "invite_url"}.issubset(fields)


@pytest.mark.anyio
async def test_create_invitation_records_email_error_on_failure():
    """이메일 발송 실패 시 email_error 기록, 초대 레코드 유지 (AC3)."""
    from app.routers.invitations import create_invitation
    from app.schemas.invitation import CreateInvitation
    from app.dependencies.auth import AuthContext

    inv_id = uuid.uuid4()
    org_id = uuid.uuid4()
    project_id = uuid.uuid4()
    invited_by = uuid.uuid4()

    mock_inv = MagicMock()
    mock_inv.id = inv_id
    mock_inv.org_id = org_id
    mock_inv.project_id = project_id
    mock_inv.email = "test@example.com"
    mock_inv.role = "member"
    mock_inv.token = "testtoken123"
    mock_inv.status = "pending"
    mock_inv.expires_at = datetime.now(timezone.utc) + timedelta(days=7)
    mock_inv.accepted_at = None
    mock_inv.created_at = datetime.now(timezone.utc)
    mock_inv.email_sent_at = None
    mock_inv.email_error = None
    mock_inv.invite_url = None
    mock_inv.invited_by = invited_by

    mock_repo = AsyncMock()
    mock_repo.org_id = org_id
    mock_repo.create = AsyncMock(return_value=mock_inv)
    mock_repo.update_email_result = AsyncMock()

    mock_session = AsyncMock()
    mock_session.execute = AsyncMock(return_value=MagicMock(first=lambda: ("TestOrg",)))

    auth = AuthContext(
        user_id=str(uuid.uuid4()),
        email="inviter@example.com",
        claims={"email": "inviter@example.com"},
        org_id=str(org_id),
    )

    body = CreateInvitation(
        email="test@example.com",
        role="member",
        invited_by=invited_by,
    )

    error_msg = "Connection refused"
    with patch("app.routers.invitations.send_invite_email", return_value=error_msg):
        await create_invitation(
            body=body,
            repo=mock_repo,
            auth=auth,
            _=None,
            session=mock_session,
        )

    # email_error가 기록됐는지
    mock_repo.update_email_result.assert_called_once()
    call_kwargs = mock_repo.update_email_result.call_args
    assert call_kwargs.kwargs.get("error") == error_msg
    assert call_kwargs.kwargs.get("sent_at") is None


@pytest.mark.anyio
async def test_create_invitation_records_sent_at_on_success():
    """이메일 발송 성공 시 email_sent_at 기록 (AC1)."""
    from app.routers.invitations import create_invitation
    from app.schemas.invitation import CreateInvitation
    from app.dependencies.auth import AuthContext

    inv_id = uuid.uuid4()
    org_id = uuid.uuid4()
    invited_by = uuid.uuid4()

    mock_inv = MagicMock()
    mock_inv.id = inv_id
    mock_inv.org_id = org_id
    mock_inv.project_id = None
    mock_inv.email = "test@example.com"
    mock_inv.role = "member"
    mock_inv.token = "testtoken456"
    mock_inv.status = "pending"
    mock_inv.expires_at = datetime.now(timezone.utc) + timedelta(days=7)
    mock_inv.accepted_at = None
    mock_inv.created_at = datetime.now(timezone.utc)
    mock_inv.email_sent_at = None
    mock_inv.email_error = None
    mock_inv.invite_url = None
    mock_inv.invited_by = invited_by

    mock_repo = AsyncMock()
    mock_repo.org_id = org_id
    mock_repo.create = AsyncMock(return_value=mock_inv)
    mock_repo.update_email_result = AsyncMock()

    mock_session = AsyncMock()
    mock_session.execute = AsyncMock(return_value=MagicMock(first=lambda: ("TestOrg",)))

    auth = AuthContext(
        user_id=str(uuid.uuid4()),
        email="inviter@example.com",
        claims={"email": "inviter@example.com"},
        org_id=str(org_id),
    )

    body = CreateInvitation(
        email="test@example.com",
        role="member",
        invited_by=invited_by,
    )

    with patch("app.routers.invitations.send_invite_email", return_value=None):
        await create_invitation(
            body=body,
            repo=mock_repo,
            auth=auth,
            _=None,
            session=mock_session,
        )

    mock_repo.update_email_result.assert_called_once()
    call_kwargs = mock_repo.update_email_result.call_args
    assert call_kwargs.kwargs.get("error") is None
    assert call_kwargs.kwargs.get("sent_at") is not None


# ─── AC4: invite_url 응답 포함 ────────────────────────────────────────────────

def test_to_response_includes_invite_url():
    """pending + 미만료 초대는 invite_url 포함."""
    from app.routers.invitations import _to_response

    mock_inv = MagicMock()
    mock_inv.id = uuid.uuid4()
    mock_inv.org_id = uuid.uuid4()
    mock_inv.project_id = None
    mock_inv.invited_by = uuid.uuid4()
    mock_inv.email = "test@example.com"
    mock_inv.role = "member"
    mock_inv.token = "testtoken789"
    mock_inv.status = "pending"
    mock_inv.expires_at = datetime.now(timezone.utc) + timedelta(days=7)
    mock_inv.accepted_at = None
    mock_inv.created_at = datetime.now(timezone.utc)
    mock_inv.email_sent_at = None
    mock_inv.email_error = None
    mock_inv.invite_url = None

    resp = _to_response(mock_inv)
    assert resp.invite_url is not None
    assert "testtoken789" in resp.invite_url


def test_to_response_no_url_for_accepted():
    """accepted 상태는 invite_url = None."""
    from app.routers.invitations import _to_response

    mock_inv = MagicMock()
    mock_inv.id = uuid.uuid4()
    mock_inv.org_id = uuid.uuid4()
    mock_inv.project_id = None
    mock_inv.invited_by = uuid.uuid4()
    mock_inv.email = "test@example.com"
    mock_inv.role = "member"
    mock_inv.token = "tok"
    mock_inv.status = "accepted"
    mock_inv.expires_at = datetime.now(timezone.utc) + timedelta(days=7)
    mock_inv.accepted_at = datetime.now(timezone.utc)
    mock_inv.created_at = datetime.now(timezone.utc)
    mock_inv.email_sent_at = None
    mock_inv.email_error = None
    mock_inv.invite_url = None

    resp = _to_response(mock_inv)
    assert resp.invite_url is None


# ─── 이메일 서비스 ────────────────────────────────────────────────────────────

def test_email_service_resend_priority():
    """email.py가 RESEND_API_KEY 있으면 Resend 사용 로직 포함."""
    from app.services import email as email_module
    source = inspect.getsource(email_module)
    assert "RESEND_API_KEY" in source
    assert "resend" in source.lower()


def test_email_service_smtp_fallback():
    """email.py가 SMTP fallback 로직 포함."""
    from app.services import email as email_module
    source = inspect.getsource(email_module)
    assert "EMAIL_SMTP_HOST" in source


def test_send_invite_email_success():
    """send_invite_email — 이메일 발송 성공 시 None 반환."""
    from app.services.org_invite_email import send_invite_email
    with patch("app.services.org_invite_email.send_email") as mock_send:
        mock_send.return_value = None
        result = send_invite_email(
            to="test@example.com",
            org_name="TestOrg",
            token="tok",
            role="member",
            inviter_name="홍길동",
        )
    assert result is None


def test_send_invite_email_failure():
    """send_invite_email — 이메일 발송 실패 시 오류 메시지 반환."""
    from app.services.org_invite_email import send_invite_email
    with patch("app.services.org_invite_email.send_email", side_effect=Exception("SMTP error")):
        result = send_invite_email(
            to="test@example.com",
            org_name="TestOrg",
            token="tok",
            role="member",
            inviter_name="홍길동",
        )
    assert result is not None
    assert "SMTP error" in result


# ─── migration 0056 ──────────────────────────────────────────────────────────

def test_migration_0056_exists():
    """Alembic migration 0056 파일 존재."""
    import os
    base = os.path.join(os.path.dirname(__file__), "..", "alembic", "versions")
    files = os.listdir(base)
    assert any("0056" in f for f in files)


def test_migration_0056_adds_email_columns():
    """0056 upgrade에 email_sent_at, email_error 컬럼 추가 로직 포함."""
    import os
    base = os.path.join(os.path.dirname(__file__), "..", "alembic", "versions")
    path = next(os.path.join(base, f) for f in os.listdir(base) if "0056" in f)
    source = open(path).read()
    assert "email_sent_at" in source
    assert "email_error" in source
    assert "add_column" in source
