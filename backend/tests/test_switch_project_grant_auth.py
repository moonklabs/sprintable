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
    """story #1994 §5회차: `has_project_access`가 raw `text()` SQL(`SELECT 1 ... LIMIT 1` — row
    있음/없음)에서 SQLAlchemy Core `exists()` 단일 불리언 표현식으로 구현이 바뀌었다(atom-level
    SSOT `_project_access_predicate`로 추출, `project_access_valid_correlated`와 공유). 실행
    메서드는 여전히 `scalar_one_or_none()`(mock 호환성 위해 의도적으로 유지 — project_auth.py
    주석 참조)이라 기존 mock 관례를 그대로 재사용할 수 있다. `scalar_value`는 기존 테스트
    바디와의 호환을 위해 1/None 관례를 그대로 받되 bool()로 정규화해 `scalar_one_or_none`에
    태운다(EXISTS는 항상 정확히 1행 True/False를 내므로 실 DB에서는 `scalar_one()`과 동치)."""
    session = AsyncMock()
    result = MagicMock()
    result.scalar_one_or_none.return_value = bool(scalar_value)
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
    """user_id / project_id / org_id 바인딩 검증. §5회차: `has_project_access`가 이제 raw
    text()+dict가 아니라 SQLAlchemy Core `select(predicate)`를 실행한다 — `session.execute`에
    넘어간 실제 Select 구문을 literal-binds로 컴파일해 세 값이 모두 SQL 텍스트에 리터럴로
    박혀 있는지 확인한다(구현 메커니즘은 바뀌었지만 "세 파라미터가 실제로 쿼리에 쓰인다"는
    검증 의도는 그대로)."""
    from sqlalchemy.dialects import postgresql

    session = _mock_session_with(None)
    await has_project_access(session, USER_ID, PROJECT_ID, ORG_ID)
    call_args = session.execute.call_args
    stmt = call_args[0][0]
    compiled = stmt.compile(dialect=postgresql.dialect(), compile_kwargs={"literal_binds": True})
    sql_text = str(compiled)
    assert str(USER_ID) in sql_text
    assert str(PROJECT_ID) in sql_text
    assert str(ORG_ID) in sql_text


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
