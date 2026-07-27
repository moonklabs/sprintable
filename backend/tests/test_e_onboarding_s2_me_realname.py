"""E-ONBOARDING S2: /me 실명+email — 스키마 노출 + org-member fallback name 우선순위.

데모 centerpiece: 초대 멤버가 가입해도 이름이 '-'/email로 뜨지 않고 실명(display_name) 반영.

SID bb93ada4/#2056: 이 폴백은 users.display_name/email만 읽어 canonical members 앵커
(update_me PATCH가 쓰는 정본 이름 — /team-members가 읽는 그 값)와 어긋날 수 있었다
("송윤재" 멤버 앵커 vs "sellerking" 계정 핸들이 동시에 존재하던 실제 버그). members 앵커를
최우선으로 조회하도록 갱신 — display_name/email 폴백 순서는 앵커가 없을 때만 그대로 유지.
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

def _fallback_session(user, member_anchor_name=None):
    """TeamMember 없음 → org_member 존재 → user 조회 → members 앵커 name 조회 순서로
    execute side_effect 구성(SID bb93ada4/#2056: 앵커 조회가 마지막에 추가됨)."""
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
    anchor_result = MagicMock()
    anchor_result.scalar_one_or_none.return_value = member_anchor_name

    s = AsyncMock()
    s.execute = AsyncMock(side_effect=[member_result, om_result, user_result, anchor_result])
    return s, org_member


def _auth(org_id):
    return AuthContext(
        user_id=str(uuid.uuid4()),
        email="invited@example.com",
        claims={"app_metadata": {"org_id": str(org_id)}},
        org_id=str(org_id),
    )


@pytest.mark.anyio
async def test_fallback_prefers_display_name_when_no_member_anchor():
    user = MagicMock()
    user.display_name = "초대된 실명"
    user.email = "invited@example.com"
    user.hashed_password = "x"
    org_id = uuid.uuid4()
    session, _ = _fallback_session(user, member_anchor_name=None)
    res = await get_me(member_id=None, session=session, auth=_auth(org_id))
    assert res.name == "초대된 실명"  # 앵커 없으면 display_name 우선(기존 폴백 순서 유지)
    assert res.email == "invited@example.com"  # email 노출


@pytest.mark.anyio
async def test_fallback_uses_email_when_no_display_name_and_no_member_anchor():
    user = MagicMock()
    user.display_name = None
    user.email = "invited@example.com"
    user.hashed_password = "x"
    org_id = uuid.uuid4()
    session, _ = _fallback_session(user, member_anchor_name=None)
    res = await get_me(member_id=None, session=session, auth=_auth(org_id))
    assert res.name == "invited@example.com"  # display_name도 앵커도 없으면 email 폴백
    assert res.email == "invited@example.com"


@pytest.mark.anyio
async def test_fallback_prefers_member_anchor_over_display_name_and_email():
    """⭐SID bb93ada4/#2056 핵심 회귀 게이트 — 실제 버그 재현: members 앵커 이름("송윤재")과
    계정 display_name/email("sellerking")이 다를 때, 앵커가 이겨야 한다(조직 브리핑 인사말이
    /team-members와 같은 이름을 봐야 한다)."""
    user = MagicMock()
    user.display_name = "sellerking"  # 계정 핸들 — 이게 실제 버그에서 뜨던 값
    user.email = "sellerking@example.com"
    user.hashed_password = "x"
    org_id = uuid.uuid4()
    session, _ = _fallback_session(user, member_anchor_name="송윤재")
    res = await get_me(member_id=None, session=session, auth=_auth(org_id))
    assert res.name == "송윤재"  # members 앵커가 display_name/email보다 우선
    assert res.email == "sellerking@example.com"  # email 필드 자체는 계정 값 그대로
