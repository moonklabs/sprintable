"""story #8defd8d4(BE·보안·cross-project 노출·high, 카디르가 #4041 재검수 중 발견) — 실 PG.

옛 `AgentRunRepository.list()`는 caller가 준 `project_id`로 "그 project에 grant된 agent
목록"을 구해 `AgentRun.agent_id.in_(...)`만 대조했다. 두 project에 겸직 grant된 agent의 run은
run 자신의 `project_id`(NOT NULL, 생성 시점에 검증 완료한 실측값)와 무관하게 그 agent가
속한 아무 project_id로 조회해도 새어 나왔다(agent membership ≠ run이 실제로 속한 project).

세팅은 test_agent_runs_story_id_filter_realdb.py의 `_client_for`/`_setup_app`/`_session_factory`
재사용 — `_seed`만 이 파일 전용(겸직 agent 시나리오가 필요해 기존 seed로는 재현 불가)."""
from __future__ import annotations

import os
import uuid

import pytest

from tests.test_agent_runs_story_id_filter_realdb import (
    _client_for,
    _session_factory,
    _setup_app,
)

_REAL_DB_URL = os.getenv("PARITY_TEST_DATABASE_URL") or os.getenv("ALEMBIC_DATABASE_URL")

pytestmark = [
    pytest.mark.skipif(not _REAL_DB_URL, reason="통합 테스트는 실 PG(PARITY/ALEMBIC_DATABASE_URL) 필요"),
]


@pytest.fixture
def anyio_backend():
    return "asyncio"


async def _seed_dual_membership(session):
    """agent_x가 project_a·project_b 둘 다에 grant(겸직) — run_a(project_id=A)·run_b
    (project_id=B) 각 1개. caller는 project_a에만 접근권(휴먼)."""
    from sqlalchemy import text

    from app.models.member import Member
    from app.models.organization import Organization
    from app.models.project import OrgMember, Project
    from app.models.project_access import ProjectAccess
    from app.models.user import User

    org = Organization(id=uuid.uuid4(), name="Org", slug=f"org-{uuid.uuid4().hex[:8]}")
    session.add(org)
    await session.commit()

    project_a = Project(id=uuid.uuid4(), org_id=org.id, name="Project A")
    project_b = Project(id=uuid.uuid4(), org_id=org.id, name="Project B")
    session.add_all([project_a, project_b])
    await session.commit()

    agent_x = Member(id=uuid.uuid4(), org_id=org.id, type="agent", name="Agent X (dual)")
    session.add(agent_x)
    await session.commit()
    session.add_all([
        ProjectAccess(id=uuid.uuid4(), project_id=project_a.id, member_id=agent_x.id,
                      permission="granted", role="member"),
        ProjectAccess(id=uuid.uuid4(), project_id=project_b.id, member_id=agent_x.id,
                      permission="granted", role="member"),
    ])
    await session.commit()

    run_a_id, run_b_id = uuid.uuid4(), uuid.uuid4()
    _ins = text(
        "INSERT INTO agent_runs (id, org_id, project_id, agent_id, trigger, status) "
        "VALUES (:id, :org_id, :project_id, :agent_id, 'manual', 'completed')"
    )
    await session.execute(_ins, {"id": run_a_id, "org_id": org.id, "project_id": project_a.id,
                                 "agent_id": agent_x.id})
    await session.execute(_ins, {"id": run_b_id, "org_id": org.id, "project_id": project_b.id,
                                 "agent_id": agent_x.id})
    await session.commit()

    caller_id = uuid.uuid4()
    caller = User(id=caller_id, email=f"caller-{caller_id.hex[:8]}@test.com", hashed_password="x")
    session.add(caller)
    await session.commit()
    caller_om = OrgMember(id=uuid.uuid4(), org_id=org.id, user_id=caller_id, role="member")
    session.add(caller_om)
    await session.commit()
    session.add(ProjectAccess(
        id=uuid.uuid4(), project_id=project_a.id, org_member_id=caller_om.id,
        permission="granted", role="member",
    ))
    await session.commit()

    return {
        "org_id": org.id, "project_a_id": project_a.id, "project_b_id": project_b.id,
        "run_a_id": run_a_id, "run_b_id": run_b_id, "caller_id": caller_id,
    }


@pytest.mark.anyio
async def test_list_scoped_to_project_a_excludes_dual_agent_run_b():
    """겸직 agent_x의 run_b(project_id=B)가 ?project_id=A 조회 결과에 새지 않는다."""
    from app.main import app
    engine, Session = await _session_factory()
    try:
        async with Session() as s:
            seeded = await _seed_dual_membership(s)
        await _setup_app(app, Session, seeded["caller_id"], seeded["org_id"])
        client = _client_for(app)
        try:
            resp = await client.get(f"/api/v2/agent-runs?project_id={seeded['project_a_id']}")
            assert resp.status_code == 200, resp.text
            ids = {r["id"] for r in resp.json()}
            assert ids == {str(seeded["run_a_id"])}
            assert str(seeded["run_b_id"]) not in ids
        finally:
            await client.aclose()
    finally:
        app.dependency_overrides.clear()
        await engine.dispose()


@pytest.mark.anyio
async def test_detail_of_dual_agent_other_project_run_is_404():
    """run_b를 id로 직접 조회 — caller는 project_b 무접근권이라 404(agent membership이 아니라
    run.project_id 대조가 정본이라는 증거)."""
    from app.main import app
    engine, Session = await _session_factory()
    try:
        async with Session() as s:
            seeded = await _seed_dual_membership(s)
        await _setup_app(app, Session, seeded["caller_id"], seeded["org_id"])
        client = _client_for(app)
        try:
            resp = await client.get(f"/api/v2/agent-runs/{seeded['run_b_id']}")
            assert resp.status_code == 404, resp.text
        finally:
            await client.aclose()
    finally:
        app.dependency_overrides.clear()
        await engine.dispose()


@pytest.mark.anyio
async def test_mutation_reverting_to_membership_scoping_leaks_run_b():
    """뮤테이션 표적 — repo.list()가 옛 TeamMember-membership 기반 스코핑으로 되돌아가면
    (agent_id.in_(그 project 소속 agent) 로만 대조) 겸직 agent의 타 project run이 다시 샌다.
    이 테스트가 RED로 잡는다는 것 자체가 지금 GREEN인 이유가 실제 project_id 대조라는 증거."""
    import app.repositories.agent_run as repo_mod
    from app.models.agent_run import AgentRun
    from app.models.team import TeamMember
    from sqlalchemy import select
    from app.main import app

    original_list = repo_mod.AgentRunRepository.list

    async def _old_membership_scoped_list(self, project_id, agent_id=None, story_id=None,
                                           status=None, from_dt=None, to_dt=None, limit=50, cursor=None):
        agent_ids_r = await self.session.execute(
            select(TeamMember.id).where(TeamMember.project_id == project_id)
        )
        agent_ids = [r[0] for r in agent_ids_r.all()]
        q = select(AgentRun).where(AgentRun.agent_id.in_(agent_ids)).order_by(AgentRun.created_at.desc())
        result = await self.session.execute(q)
        return list(result.scalars().all())

    repo_mod.AgentRunRepository.list = _old_membership_scoped_list
    engine, Session = await _session_factory()
    try:
        async with Session() as s:
            seeded = await _seed_dual_membership(s)
        await _setup_app(app, Session, seeded["caller_id"], seeded["org_id"])
        client = _client_for(app)
        try:
            resp = await client.get(f"/api/v2/agent-runs?project_id={seeded['project_a_id']}")
            assert resp.status_code == 200, resp.text
            ids = {r["id"] for r in resp.json()}
            assert str(seeded["run_b_id"]) in ids, "옛 membership 스코핑으로 되돌리면 run_b가 샌다(재현 실패 시 이 assert가 걸린다)"
        finally:
            await client.aclose()
    finally:
        repo_mod.AgentRunRepository.list = original_list
        app.dependency_overrides.clear()
        await engine.dispose()
