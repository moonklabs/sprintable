"""story 7a7f6c36 — GET /api/v2/agent-runs story_id 필터(Workcell 실 run 배선 unblock) realdb 검증.

핵심 계약: story_id는 이미 project-bound(caller has_project_access 통과 + project 소속 agent들의
run으로 한정)된 집합을 story 단위로 좁히는 **narrowing 필터**다. AND 축소이므로 결과를 확장할 수
없고(A AND B ⊆ A) 신규 인가 축이 아니다.

적대 축(까심 QA 대비): "narrowing이 정말 확장 못 하는가"를 정면으로 실증한다 —
 (1) story_id 필터 결과가 무필터 결과의 **부분집합**임을 실측(subset invariant),
 (2) 타 project의 story_id를 넣어도 그 project agent의 run은 집합 밖이라 **0건**(cross-project run
     탈취 불가·비-동어반복),
 (3) project 가드는 story_id로 우회 불가(무접근권 project_id는 story_id 있어도 403).
"""
from __future__ import annotations

import os
import uuid

import pytest

_REAL_DB_URL = os.getenv("PARITY_TEST_DATABASE_URL") or os.getenv("ALEMBIC_DATABASE_URL")

pytestmark = [
    pytest.mark.skipif(not _REAL_DB_URL, reason="통합 테스트는 실 PG(PARITY/ALEMBIC_DATABASE_URL) 필요"),
]

_SECRET_SUMMARY_B = "PROJECT-B-SECRET-RUN-SUMMARY"


@pytest.fixture
def anyio_backend():
    return "asyncio"


@pytest.fixture(autouse=True)
async def _dispose_global_engine_after_test():
    yield
    from app.core.database import engine as _global_engine
    await _global_engine.dispose()


def _async_url() -> str:
    url = _REAL_DB_URL
    for prefix in ("postgresql+psycopg2://", "postgresql+asyncpg://", "postgresql://"):
        if url.startswith(prefix):
            return "postgresql+asyncpg://" + url[len(prefix):]
    return url


async def _session_factory():
    from sqlalchemy.ext.asyncio import async_sessionmaker, create_async_engine
    engine = create_async_engine(_async_url())
    return engine, async_sessionmaker(engine, expire_on_commit=False)


async def _seed(session):
    """org(project_a, project_b):
    - caller(휴먼·org member·project_a에만 grant) — 합법 caller
    - agent_a(project_a grant) / agent_b(project_b grant) — team_members 뷰 진입
    - story_a1, story_a2 ∈ project_a / story_b1 ∈ project_b
    - run_a1(agent_a·story_a1) / run_a2(agent_a·story_a2) / run_b1(agent_b·story_b1·시크릿 요약)
    agent는 Member+ProjectAccess로 시드(team_members=VIEW). AgentRun.agent_id=team_members.id=member.id."""
    from sqlalchemy import text

    from app.models.member import Member
    from app.models.organization import Organization
    from app.models.pm import Story
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

    agent_a = Member(id=uuid.uuid4(), org_id=org.id, type="agent", name="Agent A")
    agent_b = Member(id=uuid.uuid4(), org_id=org.id, type="agent", name="Agent B")
    session.add_all([agent_a, agent_b])
    await session.commit()
    session.add_all([
        ProjectAccess(id=uuid.uuid4(), project_id=project_a.id, member_id=agent_a.id,
                      permission="granted", role="member"),
        ProjectAccess(id=uuid.uuid4(), project_id=project_b.id, member_id=agent_b.id,
                      permission="granted", role="member"),
    ])
    await session.commit()

    story_a1 = Story(id=uuid.uuid4(), org_id=org.id, project_id=project_a.id, title="Story A1")
    story_a2 = Story(id=uuid.uuid4(), org_id=org.id, project_id=project_a.id, title="Story A2")
    story_b1 = Story(id=uuid.uuid4(), org_id=org.id, project_id=project_b.id, title="Story B1")
    session.add_all([story_a1, story_a2, story_b1])
    await session.commit()

    # AgentRun은 raw SQL로 시드 — duration_ms가 DB에선 GENERATED ALWAYS STORED라 ORM(plain
    # 컬럼 매핑) INSERT가 NULL 렌더링 시 GeneratedAlwaysError(모델↔DB 드리프트·이 티켓 밖).
    run_a1_id, run_a2_id, run_b1_id = uuid.uuid4(), uuid.uuid4(), uuid.uuid4()
    _ins = text(
        "INSERT INTO agent_runs (id, org_id, project_id, agent_id, story_id, trigger, status, result_summary) "
        "VALUES (:id, :org_id, :project_id, :agent_id, :story_id, 'manual', :status, :summary)"
    )
    await session.execute(_ins, {"id": run_a1_id, "org_id": org.id, "project_id": project_a.id,
                                 "agent_id": agent_a.id, "story_id": story_a1.id, "status": "completed",
                                 "summary": None})
    await session.execute(_ins, {"id": run_a2_id, "org_id": org.id, "project_id": project_a.id,
                                 "agent_id": agent_a.id, "story_id": story_a2.id, "status": "running",
                                 "summary": None})
    await session.execute(_ins, {"id": run_b1_id, "org_id": org.id, "project_id": project_b.id,
                                 "agent_id": agent_b.id, "story_id": story_b1.id, "status": "completed",
                                 "summary": _SECRET_SUMMARY_B})
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
        "story_a1_id": story_a1.id, "story_a2_id": story_a2.id, "story_b1_id": story_b1.id,
        "run_a1_id": run_a1_id, "run_a2_id": run_a2_id, "run_b1_id": run_b1_id,
        "caller_id": caller_id,
    }


def _client_for(app):
    from httpx import AsyncClient, ASGITransport
    return AsyncClient(transport=ASGITransport(app=app), base_url="http://test")


async def _setup_app(app, Session, user_id, org_id):
    from app.dependencies.auth import AuthContext, get_current_user
    from app.dependencies.database import get_db

    async def _db():
        async with Session() as s:
            try:
                yield s
                await s.commit()
            except Exception:
                await s.rollback()
                raise

    async def _auth():
        return AuthContext(user_id=str(user_id), email="caller@test", claims={"app_metadata": {"org_id": str(org_id)}})

    app.dependency_overrides[get_db] = _db
    app.dependency_overrides[get_current_user] = _auth


async def _list(client, project_id, *, story_id=None):
    url = f"/api/v2/agent-runs?project_id={project_id}"
    if story_id is not None:
        url += f"&story_id={story_id}"
    return await client.get(url)


@pytest.mark.anyio
async def test_story_id_filter_returns_only_that_story_runs():
    """정확성: project_a caller가 story_a1로 필터하면 run_a1만(run_a2 제외)."""
    from app.main import app
    engine, Session = await _session_factory()
    try:
        async with Session() as s:
            seeded = await _seed(s)
        await _setup_app(app, Session, seeded["caller_id"], seeded["org_id"])
        client = _client_for(app)
        try:
            resp = await _list(client, seeded["project_a_id"], story_id=seeded["story_a1_id"])
            assert resp.status_code == 200, resp.text
            ids = {r["id"] for r in resp.json()}
            assert ids == {str(seeded["run_a1_id"])}
        finally:
            await client.aclose()
    finally:
        app.dependency_overrides.clear()
        await engine.dispose()


@pytest.mark.anyio
async def test_story_id_filter_is_strict_subset_of_unfiltered():
    """적대 축(narrowing은 확장 불가): 동일 project·caller에서 story_id 필터 결과가 무필터
    결과의 부분집합이며, 필터가 새 run을 만들어내지 않는다(A AND B ⊆ A)."""
    from app.main import app
    engine, Session = await _session_factory()
    try:
        async with Session() as s:
            seeded = await _seed(s)
        await _setup_app(app, Session, seeded["caller_id"], seeded["org_id"])
        client = _client_for(app)
        try:
            unfiltered = await _list(client, seeded["project_a_id"])
            assert unfiltered.status_code == 200, unfiltered.text
            unfiltered_ids = {r["id"] for r in unfiltered.json()}
            # 무필터 = project_a agent(agent_a)의 두 run
            assert unfiltered_ids == {str(seeded["run_a1_id"]), str(seeded["run_a2_id"])}

            filtered = await _list(client, seeded["project_a_id"], story_id=seeded["story_a1_id"])
            assert filtered.status_code == 200, filtered.text
            filtered_ids = {r["id"] for r in filtered.json()}
            # 부분집합 + 축소(확장 0)
            assert filtered_ids <= unfiltered_ids
            assert len(filtered_ids) <= len(unfiltered_ids)
            assert filtered_ids == {str(seeded["run_a1_id"])}
        finally:
            await client.aclose()
    finally:
        app.dependency_overrides.clear()
        await engine.dispose()


@pytest.mark.anyio
async def test_cross_project_story_id_returns_empty_no_leak():
    """비-동어반복 네거티브: project_a 접근권 caller가 project_a + 타 project(project_b)의
    story_id로 필터해도 0건 — story_id로 cross-project run을 끌어올 수 없다. project_b run의
    시크릿 요약이 바디에 verbatim 미노출까지 assert(단순 count 0 아님)."""
    from app.main import app
    engine, Session = await _session_factory()
    try:
        async with Session() as s:
            seeded = await _seed(s)
        await _setup_app(app, Session, seeded["caller_id"], seeded["org_id"])
        client = _client_for(app)
        try:
            resp = await _list(client, seeded["project_a_id"], story_id=seeded["story_b1_id"])
            assert resp.status_code == 200, resp.text
            assert resp.json() == []
            assert str(seeded["run_b1_id"]) not in resp.text
            assert _SECRET_SUMMARY_B not in resp.text
        finally:
            await client.aclose()
    finally:
        app.dependency_overrides.clear()
        await engine.dispose()


@pytest.mark.anyio
async def test_no_story_id_regression_unchanged():
    """회귀 0: story_id 미지정은 기존 동작 그대로 — project_a의 두 run 모두 반환."""
    from app.main import app
    engine, Session = await _session_factory()
    try:
        async with Session() as s:
            seeded = await _seed(s)
        await _setup_app(app, Session, seeded["caller_id"], seeded["org_id"])
        client = _client_for(app)
        try:
            resp = await _list(client, seeded["project_a_id"])
            assert resp.status_code == 200, resp.text
            ids = {r["id"] for r in resp.json()}
            assert ids == {str(seeded["run_a1_id"]), str(seeded["run_a2_id"])}
        finally:
            await client.aclose()
    finally:
        app.dependency_overrides.clear()
        await engine.dispose()


@pytest.mark.anyio
async def test_project_guard_not_bypassed_by_story_id():
    """가드 우회 불가: 접근권 없는 project_b를 project_id로 넣으면 story_id가 있어도 403
    (has_project_access가 먼저 발동·story_id로 우회 못 함)."""
    from app.main import app
    engine, Session = await _session_factory()
    try:
        async with Session() as s:
            seeded = await _seed(s)
        await _setup_app(app, Session, seeded["caller_id"], seeded["org_id"])
        client = _client_for(app)
        try:
            resp = await _list(client, seeded["project_b_id"], story_id=seeded["story_b1_id"])
            assert resp.status_code == 403, resp.text
            assert _SECRET_SUMMARY_B not in resp.text
        finally:
            await client.aclose()
    finally:
        app.dependency_overrides.clear()
        await engine.dispose()
