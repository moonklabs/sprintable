"""story #3997(3994 후속) — GET /api/v2/members 응답에 runtime_type additive.
FE의 새 대화 상대·담당자 선택 두 자리(GET /api/members, MemberResponse 그대로 프록시)가
isSystemPublisher(runtime_type)로 「시스템 발행」을 걸러내려면 이 필드가 필요하다(기존
GET /api/team-members?type=agent는 이미 이 필드를 실어 보내던 것과 동형 — 이 엔드포인트만
없었다). 기존 필드·순서·기본 응답(휴먼 행)은 무변경."""
from __future__ import annotations

import os
import uuid

import pytest

from tests.test_2266_story_backlinks_realdb import (
    _client_for,
    _make_org,
    _make_project,
    _session_factory,
    _setup_app_human,
)
from tests.test_3687_members_org_scope_realdb import _make_agent_with_project_grant

_REAL_DB_URL = os.getenv("PARITY_TEST_DATABASE_URL") or os.getenv("ALEMBIC_DATABASE_URL")

pytestmark = [
    pytest.mark.skipif(not _REAL_DB_URL, reason="통합 테스트는 실 PG(PARITY/ALEMBIC_DATABASE_URL) 필요"),
    pytest.mark.anyio,
]


@pytest.fixture
def anyio_backend():
    return "asyncio"


@pytest.fixture(autouse=True)
async def _dispose_global_engine_after_test():
    yield
    from app.core.database import engine as _global_engine
    await _global_engine.dispose()


async def _make_org_owner(session, org_id):
    from app.models.project import OrgMember
    from app.models.user import User

    user = User(id=uuid.uuid4(), email=f"owner-{uuid.uuid4().hex[:8]}@test.local", hashed_password="x")
    session.add(user)
    await session.flush()
    om = OrgMember(id=uuid.uuid4(), org_id=org_id, user_id=user.id, role="owner")
    session.add(om)
    await session.commit()
    return om.id, user.id


async def _set_runtime_type(session, member_id, runtime_type):
    from app.models.member import Member

    member = await session.get(Member, member_id)
    member.runtime_type = runtime_type
    await session.commit()


@pytest.mark.anyio
async def test_agent_row_carries_runtime_type_project_scoped():
    from app.main import app

    engine, Session = await _session_factory()
    try:
        async with Session() as s:
            org = await _make_org(s)
            project = await _make_project(s, org.id)
            owner_member_id, owner_user_id = await _make_org_owner(s, org.id)
            agent_id = await _make_agent_with_project_grant(s, org.id, project.id, name="System Publisher")
            await _set_runtime_type(s, agent_id, "system-publisher")

        await _setup_app_human(app, Session, owner_user_id, org.id)
        client = _client_for(app)
        try:
            resp = await client.get(f"/api/v2/members?project_id={project.id}")
            assert resp.status_code == 200, resp.text
            body = resp.json()
        finally:
            await client.aclose()

        agent_row = next(m for m in body if m["id"] == str(agent_id))
        assert agent_row["runtime_type"] == "system-publisher"
    finally:
        await engine.dispose()


@pytest.mark.anyio
async def test_agent_row_carries_runtime_type_org_scoped_no_project_id():
    from app.main import app

    engine, Session = await _session_factory()
    try:
        async with Session() as s:
            org = await _make_org(s)
            project = await _make_project(s, org.id)
            owner_member_id, owner_user_id = await _make_org_owner(s, org.id)
            agent_id = await _make_agent_with_project_grant(s, org.id, project.id, name="Real Agent")
            await _set_runtime_type(s, agent_id, "claude-code")

        await _setup_app_human(app, Session, owner_user_id, org.id)
        client = _client_for(app)
        try:
            resp = await client.get("/api/v2/members")
            assert resp.status_code == 200, resp.text
            body = resp.json()
        finally:
            await client.aclose()

        agent_row = next(m for m in body if m["id"] == str(agent_id))
        assert agent_row["runtime_type"] == "claude-code"
    finally:
        await engine.dispose()


@pytest.mark.anyio
async def test_human_row_runtime_type_is_none_regression():
    """기존 필드·기본 응답(휴먼 행) 무변경 — runtime_type이 새로 생겨도 휴먼 행은
    항상 None(에이전트 전용 컬럼, team.py:39 "휴먼 NULL"과 동형)."""
    from app.main import app

    engine, Session = await _session_factory()
    try:
        async with Session() as s:
            org = await _make_org(s)
            project = await _make_project(s, org.id)
            owner_member_id, owner_user_id = await _make_org_owner(s, org.id)

        await _setup_app_human(app, Session, owner_user_id, org.id)
        client = _client_for(app)
        try:
            resp = await client.get(f"/api/v2/members?project_id={project.id}")
            assert resp.status_code == 200, resp.text
            body = resp.json()
        finally:
            await client.aclose()

        owner_row = next(m for m in body if m["id"] == str(owner_member_id))
        assert owner_row["type"] == "human"
        assert owner_row["runtime_type"] is None
    finally:
        await engine.dispose()
