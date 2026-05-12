"""assert_agent_owner ownership guard 단위 테스트."""
import uuid
from unittest.mock import AsyncMock, MagicMock

import pytest
from fastapi import HTTPException

from app.dependencies.ownership import assert_agent_owner

ORG_ID = uuid.uuid4()
OWNER_ID = uuid.uuid4()
OTHER_ID = uuid.uuid4()
AGENT_ID = uuid.uuid4()


@pytest.fixture
def anyio_backend():
    return "asyncio"


def _mock_agent(created_by=None):
    a = MagicMock()
    a.id = AGENT_ID
    a.type = "agent"
    a.org_id = ORG_ID
    a.created_by = created_by
    return a


def _mock_session(agent=None, org_role: str | None = None) -> AsyncMock:
    session = AsyncMock()
    call_count = 0

    async def execute(stmt, *args, **kwargs):
        nonlocal call_count
        call_count += 1
        result = MagicMock()
        if call_count == 1:
            result.scalar_one_or_none.return_value = agent
        else:
            result.scalar_one_or_none.return_value = org_role
        return result

    session.execute = execute
    return session


@pytest.mark.anyio
async def test_owner_can_access():
    """created_by == current_user → 통과."""
    session = _mock_session(agent=_mock_agent(created_by=OWNER_ID))
    result = await assert_agent_owner(AGENT_ID, session, ORG_ID, OWNER_ID)
    assert result.id == AGENT_ID


@pytest.mark.anyio
async def test_non_owner_member_403():
    """created_by != current_user, member role → 403."""
    session = _mock_session(agent=_mock_agent(created_by=OWNER_ID), org_role="member")
    with pytest.raises(HTTPException) as exc:
        await assert_agent_owner(AGENT_ID, session, ORG_ID, OTHER_ID)
    assert exc.value.status_code == 403
    assert "owner" in exc.value.detail.lower()


@pytest.mark.anyio
async def test_admin_bypass():
    """created_by != current_user, admin role → 통과."""
    session = _mock_session(agent=_mock_agent(created_by=OWNER_ID), org_role="admin")
    result = await assert_agent_owner(AGENT_ID, session, ORG_ID, OTHER_ID)
    assert result.id == AGENT_ID


@pytest.mark.anyio
async def test_org_owner_bypass():
    """created_by != current_user, owner role → 통과."""
    session = _mock_session(agent=_mock_agent(created_by=OWNER_ID), org_role="owner")
    result = await assert_agent_owner(AGENT_ID, session, ORG_ID, OTHER_ID)
    assert result.id == AGENT_ID


@pytest.mark.anyio
async def test_null_owner_member_403():
    """created_by NULL, member → 403 (무주 에이전트는 상위 권한자만)."""
    session = _mock_session(agent=_mock_agent(created_by=None), org_role="member")
    with pytest.raises(HTTPException) as exc:
        await assert_agent_owner(AGENT_ID, session, ORG_ID, OTHER_ID)
    assert exc.value.status_code == 403


@pytest.mark.anyio
async def test_null_owner_admin_allowed():
    """created_by NULL, admin → 통과."""
    session = _mock_session(agent=_mock_agent(created_by=None), org_role="admin")
    result = await assert_agent_owner(AGENT_ID, session, ORG_ID, OTHER_ID)
    assert result.id == AGENT_ID


@pytest.mark.anyio
async def test_cross_org_agent_not_found():
    """다른 org의 agent_id → org_id 조건 불일치 → 404."""
    session = _mock_session(agent=None)
    with pytest.raises(HTTPException) as exc:
        await assert_agent_owner(AGENT_ID, session, ORG_ID, OWNER_ID)
    assert exc.value.status_code == 404
