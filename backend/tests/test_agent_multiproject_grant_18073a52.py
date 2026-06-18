"""18073a52 — 에이전트 멀티 프로젝트 access grant (A안: grant=SSOT, 뷰 surface).

- has_project_access / accessible_project_ids_in_org 에 에이전트 grant 분기(member_id 직매칭) 존재 가드.
- project_access POST 의 에이전트 grant(member_id) 경로 라우팅(422/400/409/201).
(실 DB 경로 — 뷰 surface·has_access true/false·partial unique·revoke — 는 pgvector e2e 로 검증.)
"""
from __future__ import annotations

import uuid
from datetime import datetime, timezone
from unittest.mock import AsyncMock, MagicMock, patch

import pytest

from app.services.project_auth import accessible_project_ids_in_org, has_project_access

ORG = uuid.uuid4()
AGENT = uuid.uuid4()
PROJ = uuid.uuid4()


@pytest.fixture
def anyio_backend():
    return "asyncio"


def _session(scalar_value=None, all_rows=None):
    s = AsyncMock()
    result = MagicMock()
    result.scalar_one_or_none.return_value = scalar_value
    result.all.return_value = all_rows or []
    s.execute = AsyncMock(return_value=result)
    return s


def _last_sql(session) -> str:
    return str(session.execute.call_args[0][0])


# ── 에이전트 grant 분기 SQL 존재 가드 (회귀 방지) ─────────────────────────────

@pytest.mark.anyio
async def test_has_project_access_includes_agent_grant_branch():
    s = _session(scalar_value=None)
    await has_project_access(s, AGENT, PROJ, ORG)
    sql = _last_sql(s)
    assert "pa.member_id = m.id" in sql
    assert "m.type = 'agent'" in sql
    assert "pa.permission = 'granted'" in sql


@pytest.mark.anyio
async def test_accessible_project_ids_includes_agent_grant_branch():
    s = _session(all_rows=[])
    await accessible_project_ids_in_org(s, AGENT, ORG)
    sql = _last_sql(s)
    assert "pa.member_id = m.id" in sql
    assert "m.type = 'agent'" in sql


# ── project_access POST — 에이전트 grant(member_id) 경로 ──────────────────────

async def _call_create(body_dict, execute_results):
    """create_project_access 직접 호출 — _require_owner_or_admin no-op, execute 시퀀스 주입."""
    from app.routers.project_access import ProjectAccessCreate, create_project_access

    session = AsyncMock()
    results = list(execute_results)

    async def _execute(*a, **k):
        r = results.pop(0) if results else MagicMock()
        return r
    session.execute = AsyncMock(side_effect=_execute)
    session.add = MagicMock()
    session.commit = AsyncMock()

    async def _refresh(rec):  # DB가 채울 id/created_at/role을 model_validate 통과하도록 채움
        if getattr(rec, "id", None) is None:
            rec.id = uuid.uuid4()
        rec.created_at = datetime.now(timezone.utc)
        # S3: ProjectAccessResponse.role 노출 추가 — transient 행은 role 미설정(DB default 'member'는
        # flush 시 적용·refresh 가 로드). mock refresh 가 실 DB 처럼 default 'member' 미러.
        if not isinstance(getattr(rec, "role", None), str):
            rec.role = "member"
    session.refresh = AsyncMock(side_effect=_refresh)

    auth = MagicMock()
    auth.user_id = str(uuid.uuid4())
    with patch("app.routers.project_access._require_owner_or_admin", new=AsyncMock()):
        return await create_project_access(PROJ, ProjectAccessCreate(**body_dict), auth, session), session


def _scalar(v):
    r = MagicMock()
    r.scalar_one_or_none.return_value = v
    return r


@pytest.mark.anyio
async def test_create_both_ids_422():
    with pytest.raises(Exception) as ei:
        await _call_create({"member_id": AGENT, "org_member_id": uuid.uuid4()}, [])
    assert getattr(ei.value, "status_code", None) == 422


@pytest.mark.anyio
async def test_create_neither_id_422():
    with pytest.raises(Exception) as ei:
        await _call_create({}, [])
    assert getattr(ei.value, "status_code", None) == 422


@pytest.mark.anyio
async def test_create_agent_not_found_400():
    # 1st execute = agent 검증 → None
    with pytest.raises(Exception) as ei:
        await _call_create({"member_id": AGENT}, [_scalar(None)])
    assert getattr(ei.value, "status_code", None) == 400


@pytest.mark.anyio
async def test_create_agent_duplicate_409():
    # agent 검증 OK(1) → existing 존재(record)
    with pytest.raises(Exception) as ei:
        await _call_create({"member_id": AGENT}, [_scalar(1), _scalar(MagicMock())])
    assert getattr(ei.value, "status_code", None) == 409


@pytest.mark.anyio
async def test_create_agent_success_sets_member_id_only():
    # agent 검증 OK(1) → existing 없음(None) → record 생성
    _, session = await _call_create({"member_id": AGENT}, [_scalar(1), _scalar(None)])
    session.add.assert_called_once()
    rec = session.add.call_args[0][0]
    assert rec.member_id == AGENT
    assert rec.org_member_id is None
    assert rec.permission == "granted"
