"""P0 핫픽스: _resolve_member_anchor org_members 폴백 (members-sync 갭).

shadow resolver(anchor) 가 members 앵커 행 없는 org-member(org-create/invite-accept 가
org_members 만 INSERT·members 미생성)에서 400 나던 것을 org_members 폴백으로 해소.
- CP1: members-less → 200 + parity(id=org_member.id). CP2: members-present 무회귀.
- CP5: org_members 폴백만(team_member 봐주기 아님).
"""
from __future__ import annotations

import uuid
from unittest.mock import AsyncMock, MagicMock

import pytest
from fastapi import HTTPException

from app.services.member_resolver import ResolvedMember, _resolve_member_anchor


@pytest.fixture
def anyio_backend():
    return "asyncio"


def _auth(uid, api_key=False):
    c = MagicMock()
    c.user_id = str(uid)
    c.claims = {"app_metadata": ({"api_key_id": "ak"} if api_key else {})}
    return c


def _scalar(val):
    r = MagicMock()
    r.scalar_one_or_none.return_value = val
    return r


@pytest.mark.anyio
async def test_anchor_members_less_org_member_fallback_parity():
    """CP1: members 행 없는 org-member → org_members 폴백·id=org_member.id(parity)·no 400."""
    uid, org = uuid.uuid4(), uuid.uuid4()
    om = MagicMock(); om.id = uuid.uuid4(); om.org_id = org; om.role = "owner"
    user = MagicMock(); user.email = "u@example.com"
    session = AsyncMock()
    # Member select(None) → User select(user) → OrgMember select(om)
    session.execute = AsyncMock(side_effect=[_scalar(None), _scalar(user), _scalar(om)])

    res = await _resolve_member_anchor(_auth(uid), org, session, None)
    assert isinstance(res, ResolvedMember)
    assert res.id == om.id          # parity: id = org_member.id (= 0075 member.id)
    assert res.user_id == uid
    assert res.type == "human"
    assert res.role == "owner"      # org_member.role
    assert res.org_id == org


@pytest.mark.anyio
async def test_anchor_members_present_unchanged_no_fallback():
    """CP2: members 앵커 존재 → 폴백 미진입·무회귀(OrgMember 미조회)."""
    uid, org = uuid.uuid4(), uuid.uuid4()
    m = MagicMock(); m.id = uuid.uuid4(); m.org_id = org; m.org_role = "admin"
    user = MagicMock(); user.email = "u@example.com"
    session = AsyncMock()
    session.execute = AsyncMock(side_effect=[_scalar(m), _scalar(user)])

    res = await _resolve_member_anchor(_auth(uid), org, session, None)
    assert res.id == m.id and res.role == "admin"
    assert session.execute.await_count == 2   # OrgMember 폴백 미호출


@pytest.mark.anyio
async def test_anchor_no_member_no_org_member_400():
    """members·org_members 둘 다 없으면 종전대로 400."""
    uid, org = uuid.uuid4(), uuid.uuid4()
    session = AsyncMock()
    session.execute = AsyncMock(side_effect=[_scalar(None), _scalar(None), _scalar(None)])
    with pytest.raises(HTTPException) as exc:
        await _resolve_member_anchor(_auth(uid), org, session, None)
    assert exc.value.status_code == 400
