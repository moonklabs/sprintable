"""S-INV-04: BE 초대 preview API + register invite_token + OAuth callback + display_name.

AC1: GET /api/v2/invitations/preview?token=XXX — 인증 없음, org_name/email/role/expires_at/status
AC2: POST /api/auth/register — invite_token 옵션, 가입 후 자동 수락
AC3: display_name 필수 필드 (register)
AC4: GET /auth/callback — invite_token → 신규 OAuth 유저 자동 수락
AC5: migration 0057 — users.display_name TEXT 컬럼 + backfill
"""
from __future__ import annotations

import inspect
import uuid
from datetime import datetime, timedelta, timezone
from unittest.mock import AsyncMock, MagicMock, patch

import pytest


# ─── AC3: display_name 필드 검증 ─────────────────────────────────────────────

def test_register_request_has_display_name():
    """RegisterRequest에 display_name 필드 존재."""
    from app.routers.auth import RegisterRequest
    fields = set(RegisterRequest.model_fields.keys())
    assert "display_name" in fields


def test_register_request_has_invite_token():
    """RegisterRequest에 invite_token 필드 존재."""
    from app.routers.auth import RegisterRequest
    fields = set(RegisterRequest.model_fields.keys())
    assert "invite_token" in fields


def test_user_model_has_display_name():
    """User 모델에 display_name 컬럼 존재."""
    from app.models.user import User
    cols = {c.name for c in User.__table__.columns}
    assert "display_name" in cols


def test_register_request_invite_token_optional():
    """invite_token은 optional (None 기본값)."""
    from app.routers.auth import RegisterRequest
    field = RegisterRequest.model_fields["invite_token"]
    assert field.is_required() is False


def test_register_request_display_name_required():
    """display_name은 필수 필드."""
    from app.routers.auth import RegisterRequest
    field = RegisterRequest.model_fields["display_name"]
    assert field.is_required() is True


# ─── AC1: preview 엔드포인트 ────────────────────────────────────────────────

def test_preview_endpoint_exists():
    """GET /api/v2/invitations/preview 라우트 존재."""
    from app.routers import invitations as inv_module
    routes = [r.path for r in inv_module.router.routes]  # type: ignore[attr-defined]
    assert any("preview" in r for r in routes)


def test_invitation_preview_response_schema():
    """InvitationPreviewResponse에 필수 필드 존재."""
    from app.schemas.invitation import InvitationPreviewResponse
    fields = set(InvitationPreviewResponse.model_fields.keys())
    assert {"org_name", "org_id", "email", "role", "status", "expires_at"}.issubset(fields)


@pytest.mark.anyio
async def test_preview_returns_org_info():
    """유효한 token으로 preview → 200 + org_name/email/role 반환."""
    from app.routers.invitations import preview_invitation

    org_id = uuid.uuid4()
    mock_inv = MagicMock()
    mock_inv.org_id = org_id
    mock_inv.email = "invited@example.com"
    mock_inv.role = "member"
    mock_inv.status = "pending"
    mock_inv.expires_at = datetime.now(timezone.utc) + timedelta(days=7)

    mock_inv_result = MagicMock()
    mock_inv_result.scalar_one_or_none.return_value = mock_inv

    org_row_mock = ("TestOrg",)
    mock_org_result = MagicMock()
    mock_org_result.first.return_value = org_row_mock

    session = AsyncMock()
    session.execute = AsyncMock(side_effect=[mock_inv_result, mock_org_result])

    resp = await preview_invitation(token="validtoken", session=session)

    assert resp.email == "invited@example.com"
    assert resp.org_name == "TestOrg"
    assert resp.role == "member"
    assert resp.org_id == org_id


@pytest.mark.anyio
async def test_preview_400_invalid_token():
    """존재하지 않는 token → 400."""
    from fastapi import HTTPException
    from app.routers.invitations import preview_invitation

    mock_result = MagicMock()
    mock_result.scalar_one_or_none.return_value = None

    session = AsyncMock()
    session.execute = AsyncMock(return_value=mock_result)

    with pytest.raises(HTTPException) as exc_info:
        await preview_invitation(token="badtoken", session=session)

    assert exc_info.value.status_code == 400


@pytest.mark.anyio
async def test_preview_400_expired_token():
    """만료된 초대 token → 400."""
    from fastapi import HTTPException
    from app.routers.invitations import preview_invitation

    mock_inv = MagicMock()
    mock_inv.status = "pending"
    mock_inv.expires_at = datetime.now(timezone.utc) - timedelta(seconds=1)

    mock_result = MagicMock()
    mock_result.scalar_one_or_none.return_value = mock_inv

    session = AsyncMock()
    session.execute = AsyncMock(return_value=mock_result)

    with pytest.raises(HTTPException) as exc_info:
        await preview_invitation(token="expiredtoken", session=session)

    assert exc_info.value.status_code == 400


# ─── AC2: register invite_token 자동 수락 ────────────────────────────────────

def test_auto_accept_invitation_defined():
    """_auto_accept_invitation 헬퍼가 auth 모듈에 정의됨."""
    from app.routers import auth as auth_module
    assert hasattr(auth_module, "_auto_accept_invitation")
    assert inspect.iscoroutinefunction(auth_module._auto_accept_invitation)


def test_register_calls_auto_accept_when_invite_token():
    """register 소스에 invite_token 있을 때 _auto_accept_invitation 호출 존재."""
    from app.routers import auth as auth_module
    source = inspect.getsource(auth_module.register)
    assert "_auto_accept_invitation" in source
    assert "invite_token" in source


@pytest.mark.anyio
async def test_auto_accept_accepts_valid_invitation():
    """_auto_accept_invitation — 유효한 토큰이면 status=accepted + OrgMember INSERT."""
    from app.routers.auth import _auto_accept_invitation

    org_id = uuid.uuid4()
    user_id = uuid.uuid4()

    mock_user = MagicMock()
    mock_user.id = user_id
    mock_user.email = "test@example.com"

    mock_inv = MagicMock()
    mock_inv.org_id = org_id
    mock_inv.email = "test@example.com"
    mock_inv.role = "member"
    mock_inv.status = "pending"
    mock_inv.expires_at = datetime.now(timezone.utc) + timedelta(days=7)

    inv_result = MagicMock()
    inv_result.scalar_one_or_none.return_value = mock_inv

    session = AsyncMock()
    session.execute = AsyncMock(side_effect=[inv_result, AsyncMock()])
    session.flush = AsyncMock()

    await _auto_accept_invitation(session, mock_user, "validtoken")

    assert mock_inv.status == "accepted"
    assert mock_inv.accepted_at is not None
    session.flush.assert_called_once()


@pytest.mark.anyio
async def test_auto_accept_skips_expired_invitation():
    """_auto_accept_invitation — 만료 토큰은 수락 안 함."""
    from app.routers.auth import _auto_accept_invitation

    mock_user = MagicMock()
    mock_user.email = "test@example.com"

    mock_inv = MagicMock()
    mock_inv.status = "pending"
    mock_inv.email = "test@example.com"
    mock_inv.expires_at = datetime.now(timezone.utc) - timedelta(seconds=1)

    inv_result = MagicMock()
    inv_result.scalar_one_or_none.return_value = mock_inv

    session = AsyncMock()
    session.execute = AsyncMock(return_value=inv_result)
    session.flush = AsyncMock()

    await _auto_accept_invitation(session, mock_user, "expiredtoken")

    assert mock_inv.status == "pending"
    session.flush.assert_not_called()


@pytest.mark.anyio
async def test_auto_accept_skips_email_mismatch():
    """_auto_accept_invitation — 이메일 불일치 시 수락 안 함 (권한 상승 방지)."""
    from app.routers.auth import _auto_accept_invitation

    mock_user = MagicMock()
    mock_user.email = "other@example.com"

    mock_inv = MagicMock()
    mock_inv.status = "pending"
    mock_inv.email = "test@example.com"
    mock_inv.expires_at = datetime.now(timezone.utc) + timedelta(days=7)

    inv_result = MagicMock()
    inv_result.scalar_one_or_none.return_value = mock_inv

    session = AsyncMock()
    session.execute = AsyncMock(return_value=inv_result)
    session.flush = AsyncMock()

    await _auto_accept_invitation(session, mock_user, "sometoken")

    assert mock_inv.status == "pending"
    session.flush.assert_not_called()


# ─── AC4: OAuth callback invite_token ────────────────────────────────────────

def test_oauth_callback_request_has_invite_token():
    """OAuthCallbackRequest에 invite_token 필드 존재."""
    from app.routers.auth import OAuthCallbackRequest
    fields = set(OAuthCallbackRequest.model_fields.keys())
    assert "invite_token" in fields


def test_oauth_callback_invite_token_optional():
    """invite_token은 optional (None 기본값)."""
    from app.routers.auth import OAuthCallbackRequest
    field = OAuthCallbackRequest.model_fields["invite_token"]
    assert field.is_required() is False


def test_oauth_callback_source_calls_auto_accept():
    """oauth_callback 소스에 _auto_accept_invitation 호출 포함."""
    from app.routers import auth as auth_module
    source = inspect.getsource(auth_module.oauth_callback)
    assert "_auto_accept_invitation" in source


# ─── AC5: migration 0057 ─────────────────────────────────────────────────────

def test_migration_0057_exists():
    """Alembic migration 0057 파일 존재."""
    import os
    base = os.path.join(os.path.dirname(__file__), "..", "alembic", "versions")
    files = os.listdir(base)
    assert any("0057" in f for f in files)


def test_migration_0057_adds_display_name():
    """0057 upgrade에 display_name 컬럼 추가 + backfill 로직 포함."""
    import os
    base = os.path.join(os.path.dirname(__file__), "..", "alembic", "versions")
    path = next(os.path.join(base, f) for f in os.listdir(base) if "0057" in f)
    source = open(path).read()
    assert "display_name" in source
    assert "add_column" in source
    assert "split_part" in source or "UPDATE" in source
