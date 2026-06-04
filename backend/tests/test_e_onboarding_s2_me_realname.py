"""E-ONBOARDING S2: /me 실명+email — 스키마 노출 + org-member fallback name 우선순위.

데모 centerpiece: 초대 멤버가 가입해도 이름이 '-'/email로 뜨지 않고 실명(display_name) 반영.
"""
from __future__ import annotations

import uuid
from unittest.mock import AsyncMock, MagicMock

import pytest

from app.dependencies.auth import AuthContext
from app.routers.me import get_me
from app.schemas.me import MeResponse
from app.schemas.org_member import OrgMemberResponse


@pytest.fixture
def anyio_backend():
    return "asyncio"


# ── 스키마 노출 ───────────────────────────────────────────────────────────────

def test_me_response_exposes_email():
    assert "email" in MeResponse.model_fields


def test_org_member_response_exposes_name():
    assert "name" in OrgMemberResponse.model_fields


# ── org-member fallback: display_name 우선, email은 폴백 ──────────────────────

def _fallback_session(user):
    """member 없음 → org_member 존재 → user 조회 순서로 execute side_effect 구성."""
    org_member = MagicMock()
    org_member.id = uuid.uuid4()
    org_member.org_id = uuid.uuid4()
    org_member.role = "member"

    member_result = MagicMock()
    member_result.scalars.return_value.first.return_value = None  # TeamMember 없음
    om_result = MagicMock()
    om_result.scalar_one_or_none.return_value = org_member
    user_result = MagicMock()
    user_result.scalar_one_or_none.return_value = user

    s = AsyncMock()
    s.execute = AsyncMock(side_effect=[member_result, om_result, user_result])
    return s, org_member


def _auth(org_id):
    return AuthContext(
        user_id=str(uuid.uuid4()),
        email="invited@example.com",
        claims={"app_metadata": {"org_id": str(org_id)}},
        org_id=str(org_id),
    )


@pytest.mark.anyio
async def test_fallback_prefers_display_name():
    user = MagicMock()
    user.display_name = "초대된 실명"
    user.email = "invited@example.com"
    user.hashed_password = "x"
    org_id = uuid.uuid4()
    session, _ = _fallback_session(user)
    res = await get_me(member_id=None, session=session, auth=_auth(org_id))
    assert res.name == "초대된 실명"  # display_name 우선
    assert res.email == "invited@example.com"  # email 노출


@pytest.mark.anyio
async def test_fallback_uses_email_when_no_display_name():
    user = MagicMock()
    user.display_name = None
    user.email = "invited@example.com"
    user.hashed_password = "x"
    org_id = uuid.uuid4()
    session, _ = _fallback_session(user)
    res = await get_me(member_id=None, session=session, auth=_auth(org_id))
    assert res.name == "invited@example.com"  # display_name 없으면 email 폴백
    assert res.email == "invited@example.com"
