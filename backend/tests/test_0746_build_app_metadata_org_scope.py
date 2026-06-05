"""0746 멀티org leak BE fix: _build_app_metadata org-스코프.

근본: switch-org 시 target org(0-프로젝트)면 last_project_id=first_accessible=null →
_build_app_metadata fallback이 org 무관 '가장 오래된 team_member'를 집어 cross-org 옛 프로젝트
project_id를 JWT + user.last_project_id(영속)에 주입 → leak. fix = org_id 스코프(그 org에 접근
프로젝트 없으면 project_id="" + last_project_id=null, cross-org 절대 금지).
"""
from __future__ import annotations

import uuid
from unittest.mock import AsyncMock, MagicMock, patch

import pytest

ORG_B = uuid.uuid4()   # 전환 대상 org
PID_B = uuid.uuid4()   # org_B의 프로젝트
UID = uuid.uuid4()


@pytest.fixture
def anyio_backend():
    return "asyncio"


def _user(last_project_id=None):
    u = MagicMock()
    u.id = UID
    u.email = "x@example.com"
    u.last_project_id = last_project_id
    return u


@pytest.mark.anyio
async def test_org_scoped_zero_project_no_crossorg_injection():
    """target org에 접근 프로젝트 0개 → project_id='' + last_project_id=None (cross-org 옛 프로젝트 금지)."""
    from app.routers.auth import _build_app_metadata

    user = _user(last_project_id=None)
    tm_none = MagicMock(); tm_none.scalar_one_or_none.return_value = None      # fallback team_member 없음
    om_role = MagicMock(); om_role.scalar_one_or_none.return_value = "admin"   # org_member role
    session = AsyncMock()
    session.execute = AsyncMock(side_effect=[tm_none, om_role])

    with patch("app.routers.auth.first_accessible_project_id", new=AsyncMock(return_value=None)), \
         patch("app.routers.auth._user_projects_claim", new=AsyncMock(return_value=[])):
        md = await _build_app_metadata(user, session, org_id=ORG_B)

    assert md["org_id"] == str(ORG_B)
    assert md["project_id"] == ""                # 옛 org 프로젝트 주입 안 됨
    assert md["role"] == "admin"
    assert user.last_project_id is None          # 영속값도 cross-org 아님


@pytest.mark.anyio
async def test_org_scoped_grant_project_uses_in_org_project():
    """target org에 grant 접근 프로젝트 있으면 그 프로젝트로 해소 (in-org)."""
    from app.routers.auth import _build_app_metadata

    user = _user(last_project_id=None)
    tm_none = MagicMock(); tm_none.scalar_one_or_none.return_value = None
    om_role = MagicMock(); om_role.scalar_one_or_none.return_value = "member"
    session = AsyncMock()
    session.execute = AsyncMock(side_effect=[tm_none, om_role])

    with patch("app.routers.auth.first_accessible_project_id", new=AsyncMock(return_value=PID_B)), \
         patch("app.routers.auth._user_projects_claim", new=AsyncMock(return_value=[])):
        md = await _build_app_metadata(user, session, org_id=ORG_B)

    assert md["org_id"] == str(ORG_B)
    assert md["project_id"] == str(PID_B)        # in-org 프로젝트
    assert user.last_project_id == PID_B         # in-org로 영속


@pytest.mark.anyio
async def test_org_scoped_stale_last_project_ignored_when_crossorg():
    """last_project_id가 옛 org 프로젝트여도 org_id 스코프 쿼리가 매칭 0 → fallback도 0 →
    cross-org 주입 없이 first_accessible(org_B)로 해소."""
    from app.routers.auth import _build_app_metadata

    user = _user(last_project_id=uuid.uuid4())   # 옛 org의 stale project
    # q1(last_project_id, org_B 스코프) → None, q2(fallback, org_B 스코프) → None
    q1 = MagicMock(); q1.scalar_one_or_none.return_value = None
    q2 = MagicMock(); q2.scalar_one_or_none.return_value = None
    om_role = MagicMock(); om_role.scalar_one_or_none.return_value = "member"
    session = AsyncMock()
    session.execute = AsyncMock(side_effect=[q1, q2, om_role])

    with patch("app.routers.auth.first_accessible_project_id", new=AsyncMock(return_value=None)), \
         patch("app.routers.auth._user_projects_claim", new=AsyncMock(return_value=[])):
        md = await _build_app_metadata(user, session, org_id=ORG_B)

    assert md["project_id"] == ""
    assert user.last_project_id is None
