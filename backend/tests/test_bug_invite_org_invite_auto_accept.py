"""BUG: 초대 수락 → org_member 생성 흐름 깨짐 수정 검증.

_build_app_metadata가 OrgInvite(org_invites 테이블)를 누락하여
invite link 가입 후 explicit accept 없이 로그인 시 org context가 없던 문제.

AC: _build_app_metadata가 Invitation 미존재 시 OrgInvite도 조회하여 자동수락.
"""
from __future__ import annotations

import inspect
import uuid
from datetime import datetime, timedelta, timezone
from unittest.mock import AsyncMock, MagicMock, patch

import pytest


# ─── 소스 레벨 검증 ───────────────────────────────────────────────────────────

def test_org_invite_imported_in_auth():
    """auth.py에 OrgInvite import 추가됨."""
    import app.routers.auth as auth_mod
    source = inspect.getsource(auth_mod)
    assert "from app.models.org_invite import OrgInvite" in source


def test_build_app_metadata_handles_org_invite():
    """_build_app_metadata 소스에 OrgInvite 조회 로직 포함."""
    from app.routers.auth import _build_app_metadata
    source = inspect.getsource(_build_app_metadata)
    assert "OrgInvite" in source
    assert "organization_id" in source  # OrgInvite → org_member 생성


def test_build_app_metadata_org_invite_auto_accept_returns_org_id():
    """OrgInvite 자동수락 경로가 org_id 반환 + canonical accept(SSOT)로 위임."""
    from app.routers.auth import _build_app_metadata
    source = inspect.getsource(_build_app_metadata)
    # org_inv.organization_id → 반환 dict의 org_id
    assert "org_inv.organization_id" in source
    # 05fa365f SSOT: org_member+grant+status를 canonical accept(token)로 위임(인라인 status set 제거)
    assert "OrgInviteRepository(session).accept(org_inv.token" in source


# ─── 동작 검증 ────────────────────────────────────────────────────────────────

@pytest.mark.anyio
async def test_build_app_metadata_auto_accepts_org_invite():
    """OrgInvite pending → 자동수락 + org_member 생성 + org_id 반환."""
    from app.routers.auth import _build_app_metadata

    org_id = uuid.uuid4()
    user_id = uuid.uuid4()
    now = datetime.now(timezone.utc)

    mock_user = MagicMock()
    mock_user.id = user_id
    mock_user.email = "isaacshin@moonklabs.com"
    mock_user.last_project_id = None
    mock_user.last_org_id = None  # 0746 후속: 신규 필드 — None이어야 org_id-None(invite/Path4) 경로 유지

    # mock OrgInvite
    mock_org_inv = MagicMock()
    mock_org_inv.organization_id = org_id
    mock_org_inv.role = "member"
    mock_org_inv.status = "pending"
    mock_org_inv.token = "org-inv-token"
    mock_org_inv.expires_at = now + timedelta(days=3)
    mock_org_inv.accepted_at = None

    session = AsyncMock()

    # execute 순서: 1.team_member fallback→None  2.Invitation lookup→None  3.OrgInvite lookup→mock_org_inv
    # (이후 org_member+grant+status는 canonical accept로 위임 → patch)
    no_member = MagicMock(); no_member.scalar_one_or_none.return_value = None
    no_inv = MagicMock(); no_inv.scalar_one_or_none.return_value = None
    org_inv_result = MagicMock(); org_inv_result.scalar_one_or_none.return_value = mock_org_inv
    session.execute = AsyncMock(side_effect=[no_member, no_inv, org_inv_result])
    session.flush = AsyncMock()

    # 05fa365f SSOT: 자동수락이 canonical accept(token)로 위임됨 — accept이 org_member+project_access
    # grant+status 처리(자체 테스트 별도). 여기선 위임 호출 + 반환 dict 검증.
    accept_mock = AsyncMock(return_value={"ok": True, "org_id": str(org_id), "role": "member"})
    with patch("app.repositories.org_invite.OrgInviteRepository.accept", new=accept_mock):
        result = await _build_app_metadata(mock_user, session)

    assert result.get("org_id") == str(org_id)
    assert result.get("role") == "member"
    accept_mock.assert_awaited_once_with("org-inv-token", user_id, mock_user.email)


@pytest.mark.anyio
async def test_build_app_metadata_skips_org_invite_when_invitation_found():
    """Invitation 발견 시 OrgInvite 조회 스킵 (2a 경로 우선)."""
    from app.routers.auth import _build_app_metadata

    org_id = uuid.uuid4()
    project_id = uuid.uuid4()
    user_id = uuid.uuid4()
    now = datetime.now(timezone.utc)

    mock_user = MagicMock()
    mock_user.id = user_id
    mock_user.email = "user@example.com"
    mock_user.last_project_id = None
    mock_user.last_org_id = None  # 0746 후속: 신규 필드 — None이어야 org_id-None(invite/Path4) 경로 유지

    mock_inv = MagicMock()
    mock_inv.org_id = org_id
    mock_inv.project_id = project_id
    mock_inv.role = "admin"
    mock_inv.status = "pending"
    mock_inv.accepted_at = None

    session = AsyncMock()

    no_member = MagicMock()
    no_member.scalar_one_or_none.return_value = None
    inv_result = MagicMock()
    inv_result.scalar_one_or_none.return_value = mock_inv
    insert_result = MagicMock()

    session.execute = AsyncMock(side_effect=[
        no_member,   # team_member fallback
        inv_result,  # Invitation lookup → found
        insert_result,  # pg_insert(OrgMember)
    ])
    session.flush = AsyncMock()

    result = await _build_app_metadata(mock_user, session)

    assert result.get("org_id") == str(org_id)
    assert result.get("role") == "admin"
    assert mock_inv.status == "accepted"
    # OrgInvite 조회는 호출되지 않아야 함 (execute 3회: team_member, invitation, insert)
    assert session.execute.call_count == 3


# ─── 05fa365f: signup invite_token 경로도 OrgInvite 위임(grant) ──────────────

@pytest.mark.anyio
async def test_auto_accept_invitation_delegates_orginvite_token():
    """signup _auto_accept_invitation: 토큰이 구 Invitation 아니면 OrgInvite canonical accept로 위임
    (org_member + project_access grant). 이전엔 Invitation 미존재 시 즉시 return → grant 0행."""
    from app.routers.auth import _auto_accept_invitation

    user = MagicMock(); user.id = uuid.uuid4(); user.email = "invitee@example.com"
    # Invitation lookup → None (OrgInvite 토큰)
    no_inv = MagicMock(); no_inv.scalar_one_or_none.return_value = None
    session = AsyncMock(); session.execute = AsyncMock(return_value=no_inv)
    accept_mock = AsyncMock(return_value={"ok": True})
    with patch("app.repositories.org_invite.OrgInviteRepository.accept", new=accept_mock):
        await _auto_accept_invitation(session, user, "org-inv-token")
    accept_mock.assert_awaited_once_with("org-inv-token", user.id, user.email)
