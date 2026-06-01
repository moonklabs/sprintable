"""switch_project 인가 정합 — has_project_access 3-branch 테스트.

team_member ∪ project_access(granted) ∪ owner/admin 모두 통과, 그 외 거부.
"""
import uuid
from unittest.mock import AsyncMock, MagicMock, patch

import pytest

from app.services.project_auth import has_project_access, first_accessible_project_id

ORG_ID = uuid.uuid4()
USER_ID = uuid.uuid4()
PROJECT_ID = uuid.uuid4()


@pytest.fixture
def anyio_backend():
    return "asyncio"


def _mock_session_with(scalar_value):
    session = AsyncMock()
    result = MagicMock()
    result.scalar_one_or_none.return_value = scalar_value
    session.execute = AsyncMock(return_value=result)
    return session


# ── has_project_access ────────────────────────────────────────────────────────

@pytest.mark.anyio
async def test_has_access_via_team_member():
    """team_member 등록 → True."""
    session = _mock_session_with(1)  # EXISTS → 1
    result = await has_project_access(session, USER_ID, PROJECT_ID, ORG_ID)
    assert result is True
    session.execute.assert_called_once()


@pytest.mark.anyio
async def test_no_access_returns_false():
    """접근 경로 없음 → False."""
    session = _mock_session_with(None)
    result = await has_project_access(session, USER_ID, PROJECT_ID, ORG_ID)
    assert result is False


@pytest.mark.anyio
async def test_has_access_without_org_id():
    """org_id=None (cross-org) — 호출 성공."""
    session = _mock_session_with(1)
    result = await has_project_access(session, USER_ID, PROJECT_ID, None)
    assert result is True


@pytest.mark.anyio
async def test_query_passes_correct_params():
    """user_id / project_id / org_id 파라미터 바인딩 검증."""
    session = _mock_session_with(None)
    await has_project_access(session, USER_ID, PROJECT_ID, ORG_ID)
    call_args = session.execute.call_args
    params = call_args[0][1]
    assert params["user_id"] == USER_ID
    assert params["project_id"] == PROJECT_ID
    assert params["org_id"] == ORG_ID


# ── first_accessible_project_id ───────────────────────────────────────────────

@pytest.mark.anyio
async def test_first_accessible_returns_team_member_project():
    """team_member 등록 project 우선 반환."""
    project_id = uuid.uuid4()
    session = AsyncMock()
    result = MagicMock()
    result.scalar_one_or_none.return_value = str(project_id)
    session.execute = AsyncMock(return_value=result)

    val = await first_accessible_project_id(session, USER_ID, ORG_ID)
    assert val == project_id
    assert session.execute.call_count == 1  # 첫 쿼리에서 바로 반환


@pytest.mark.anyio
async def test_first_accessible_falls_back_to_grant():
    """team_member 없고 grant 프로젝트 있으면 grant 반환."""
    project_id = uuid.uuid4()
    session = AsyncMock()
    no_result = MagicMock()
    no_result.scalar_one_or_none.return_value = None
    grant_result = MagicMock()
    grant_result.scalar_one_or_none.return_value = str(project_id)
    session.execute = AsyncMock(side_effect=[no_result, grant_result])

    val = await first_accessible_project_id(session, USER_ID, ORG_ID)
    assert val == project_id
    assert session.execute.call_count == 2


@pytest.mark.anyio
async def test_first_accessible_falls_back_to_first_project():
    """team_member도 grant도 없으면 org 첫 project."""
    project_id = uuid.uuid4()
    session = AsyncMock()
    no_result = MagicMock()
    no_result.scalar_one_or_none.return_value = None
    first_result = MagicMock()
    first_result.scalar_one_or_none.return_value = str(project_id)
    session.execute = AsyncMock(side_effect=[no_result, no_result, first_result])

    val = await first_accessible_project_id(session, USER_ID, ORG_ID)
    assert val == project_id
    assert session.execute.call_count == 3


@pytest.mark.anyio
async def test_first_accessible_none_when_no_projects():
    """프로젝트 없음 → None."""
    session = AsyncMock()
    no_result = MagicMock()
    no_result.scalar_one_or_none.return_value = None
    session.execute = AsyncMock(return_value=no_result)

    val = await first_accessible_project_id(session, USER_ID, ORG_ID)
    assert val is None
