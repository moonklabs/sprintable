"""chats 회귀 버그(선생님 보고): conversations agent-view 게이트가 raw project team_member role을 봐서
org owner/admin을 거부. fix = _effective_org_role(org owner/admin 상속·#1223↔멤버-SSOT 뷰 갭 보정).

project f3e6 전원 team_member role='member'(org owner/admin인데도) → 게이트 403이 근본.
"""
from __future__ import annotations

import uuid
from types import SimpleNamespace
from unittest.mock import AsyncMock, MagicMock

import pytest

ORG = uuid.uuid4()
USER = uuid.uuid4()


@pytest.fixture
def anyio_backend():
    return "asyncio"


def _auth(api_key=False):
    claims = {"app_metadata": {"api_key_id": "k"} if api_key else {}}
    return SimpleNamespace(user_id=str(USER), claims=claims)


def _om_role_db(role):
    res = MagicMock(); res.scalar_one_or_none.return_value = role
    db = AsyncMock(); db.execute = AsyncMock(return_value=res)
    return db


@pytest.mark.anyio
async def test_org_admin_inherited_when_project_role_low():
    """project team_member role='member'이지만 org_member role='admin' → effective 'admin'."""
    from app.routers.conversations import _effective_org_role

    sender = SimpleNamespace(role="member")  # raw project role
    db = _om_role_db("admin")
    assert await _effective_org_role(_auth(), ORG, db, sender) == "admin"


@pytest.mark.anyio
async def test_owner_fast_path_no_query():
    """sender.role 이미 owner/admin → 즉시 반환(org 조회 안 함)."""
    from app.routers.conversations import _effective_org_role

    sender = SimpleNamespace(role="owner")
    db = AsyncMock()
    db.execute = AsyncMock(side_effect=AssertionError("should not query"))
    assert await _effective_org_role(_auth(), ORG, db, sender) == "owner"


@pytest.mark.anyio
async def test_api_key_no_org_escape():
    """에이전트(API키)는 org role 무관 → sender.role 그대로(조회 안 함)."""
    from app.routers.conversations import _effective_org_role

    sender = SimpleNamespace(role="member")
    db = AsyncMock()
    db.execute = AsyncMock(side_effect=AssertionError("should not query"))
    assert await _effective_org_role(_auth(api_key=True), ORG, db, sender) == "member"


@pytest.mark.anyio
async def test_plain_member_stays_member():
    """org_member도 member면 effective 'member'(상속 없음·정상 거부 유지)."""
    from app.routers.conversations import _effective_org_role

    sender = SimpleNamespace(role="member")
    db = _om_role_db("member")
    assert await _effective_org_role(_auth(), ORG, db, sender) == "member"
