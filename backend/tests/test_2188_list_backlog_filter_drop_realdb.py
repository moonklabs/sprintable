"""story #2188 형제(2026-07-25, 오르테가군 판정) — 실 PG.

`GET /stories?project_id=&no_sprint=true`(list_backlog 분기)가 board 분기(#2489)와 같은
결함 클래스로 epic_id/assignee_id/status/story_number/q를 조용히 무시했다. 라이브 콜러
확認 결과 사용자 피해는 0(FE `ApiStoryRepository.backlog()`는 콜러 0·MCP
`sprintable_list_backlog` 스키마는 project_id만 받아 문제 파라미터를 애초에 못 보냄) —
다만 REST를 직접 부르는 임시 조회가 이 함정에 걸리는 자리라(디디군이 #2188 조사 중 실제로
밟음) 판단 근거 오염을 막기 위해 medium으로 고친다. cursor는 이 분기의 어떤 콜러도 보내지
않아 스코프 밖.
"""
from __future__ import annotations

import os
import uuid

import pytest

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


def _auth(agent_id: uuid.UUID):
    from app.dependencies.auth import AuthContext
    return AuthContext(user_id=str(agent_id), email=None, claims={"app_metadata": {}})


async def _seed(session):
    from app.models.member import Member
    from app.models.organization import Organization
    from app.models.pm import Goal, Story
    from app.models.project import Project
    from app.models.project_access import ProjectAccess

    org = Organization(id=uuid.uuid4(), name="Org", slug=f"org-{uuid.uuid4().hex[:8]}")
    session.add(org)
    await session.commit()

    project = Project(id=uuid.uuid4(), org_id=org.id, name="P")
    session.add(project)
    await session.commit()

    agent = Member(id=uuid.uuid4(), org_id=org.id, type="agent", name="Agent")
    session.add(agent)
    await session.commit()
    session.add(ProjectAccess(id=uuid.uuid4(), project_id=project.id, member_id=agent.id, permission="granted"))
    await session.commit()

    epic_a = Goal(id=uuid.uuid4(), org_id=org.id, project_id=project.id, title="Epic A")
    epic_b = Goal(id=uuid.uuid4(), org_id=org.id, project_id=project.id, title="Epic B")
    session.add_all([epic_a, epic_b])
    await session.commit()

    # 전부 sprint_id=None(backlog 조건) — epic만 갈리는 두 그룹 + status가 다른 형제.
    s_a1 = Story(id=uuid.uuid4(), org_id=org.id, project_id=project.id, epic_id=epic_a.id, title="A1", status="backlog", story_number=1)
    s_a2 = Story(id=uuid.uuid4(), org_id=org.id, project_id=project.id, epic_id=epic_a.id, title="A2 special", status="backlog", story_number=2)
    s_b1 = Story(id=uuid.uuid4(), org_id=org.id, project_id=project.id, epic_id=epic_b.id, title="B1", status="backlog", story_number=3)
    s_a_done = Story(id=uuid.uuid4(), org_id=org.id, project_id=project.id, epic_id=epic_a.id, title="A-done", status="done", story_number=4)
    session.add_all([s_a1, s_a2, s_b1, s_a_done])
    await session.commit()

    return {
        "org_id": org.id, "project_id": project.id, "agent_id": agent.id,
        "epic_a": epic_a.id, "epic_b": epic_b.id,
        "s_a1": s_a1.id, "s_a2": s_a2.id, "s_b1": s_b1.id, "s_a_done": s_a_done.id,
        "s_a2_number": s_a2.story_number,
    }


async def _call_list_stories(session, org_id, agent_id, **kwargs):
    from app.repositories.story import StoryRepository
    from app.routers.stories import list_stories

    repo = StoryRepository(session, org_id)
    params = dict(
        project_id=None, epic_id=None, sprint_id=None, assignee_id=None,
        status_filter=None, no_sprint=False, ids=None, story_number=None, q=None, limit=1000,
        cursor=None, response=None,
    )
    params.update(kwargs)
    return await list_stories(repo=repo, auth=_auth(agent_id), **params)


async def test_backlog_epic_id_narrows_not_ignored():
    """⭐본체 — no_sprint+project_id 만 걸면 4건(전부 sprint 미배정), epic_id 를 더하면
    줄어야 하는데 고치기 前엔 그대로 4건(무시)이었다."""
    engine, Session = await _session_factory()
    try:
        async with Session() as s:
            seeded = await _seed(s)
        async with Session() as s:
            result = await _call_list_stories(
                s, seeded["org_id"], seeded["agent_id"],
                project_id=seeded["project_id"], no_sprint=True, epic_id=seeded["epic_a"],
            )
            returned_ids = {r.id for r in result}
            assert returned_ids == {seeded["s_a1"], seeded["s_a2"], seeded["s_a_done"]}, (
                f"epic_id=A 로 좁혔는데 B 스토리가 섞여 나옴: {returned_ids}"
            )
    finally:
        await engine.dispose()


async def test_backlog_status_narrows():
    engine, Session = await _session_factory()
    try:
        async with Session() as s:
            seeded = await _seed(s)
        async with Session() as s:
            result = await _call_list_stories(
                s, seeded["org_id"], seeded["agent_id"],
                project_id=seeded["project_id"], no_sprint=True, status_filter="backlog",
            )
            returned_ids = {r.id for r in result}
            assert returned_ids == {seeded["s_a1"], seeded["s_a2"], seeded["s_b1"]}
            assert seeded["s_a_done"] not in returned_ids
    finally:
        await engine.dispose()


async def test_backlog_story_number_narrows():
    engine, Session = await _session_factory()
    try:
        async with Session() as s:
            seeded = await _seed(s)
        async with Session() as s:
            result = await _call_list_stories(
                s, seeded["org_id"], seeded["agent_id"],
                project_id=seeded["project_id"], no_sprint=True, story_number=seeded["s_a2_number"],
            )
            assert {r.id for r in result} == {seeded["s_a2"]}
    finally:
        await engine.dispose()


async def test_backlog_q_narrows():
    engine, Session = await _session_factory()
    try:
        async with Session() as s:
            seeded = await _seed(s)
        async with Session() as s:
            result = await _call_list_stories(
                s, seeded["org_id"], seeded["agent_id"],
                project_id=seeded["project_id"], no_sprint=True, q="special",
            )
            assert {r.id for r in result} == {seeded["s_a2"]}
    finally:
        await engine.dispose()


async def test_filter_monotonicity_status_must_not_undo_epic_filter():
    """⭐AC2 불변식(#2188/#2189에서 세운 그 방식 그대로) — 제네릭 분기(epic_id만) 대비
    backlog 분기(epic_id+status)로 필터를 추가했을 때 결과가 baseline 밖으로 늘면 실패."""
    engine, Session = await _session_factory()
    try:
        async with Session() as s:
            seeded = await _seed(s)
        async with Session() as s:
            baseline = await _call_list_stories(
                s, seeded["org_id"], seeded["agent_id"],
                project_id=seeded["project_id"], epic_id=seeded["epic_a"],
            )
            baseline_ids = {r.id for r in baseline}

            narrowed = await _call_list_stories(
                s, seeded["org_id"], seeded["agent_id"],
                project_id=seeded["project_id"], epic_id=seeded["epic_a"],
                no_sprint=True, status_filter="backlog",
            )
            narrowed_ids = {r.id for r in narrowed}
            assert narrowed_ids.issubset(baseline_ids), (
                f"필터 추가가 baseline 밖으로 결과를 늘림 — 추가분={narrowed_ids - baseline_ids}"
            )
    finally:
        await engine.dispose()


async def test_backlog_no_extra_filters_unspecified_no_regression():
    """무회귀 — 추가 필터 전부 미지정이면 기존 4건(sprint 미배정 전부) 그대로."""
    engine, Session = await _session_factory()
    try:
        async with Session() as s:
            seeded = await _seed(s)
        async with Session() as s:
            result = await _call_list_stories(
                s, seeded["org_id"], seeded["agent_id"],
                project_id=seeded["project_id"], no_sprint=True,
            )
            returned_ids = {r.id for r in result}
            assert returned_ids == {seeded["s_a1"], seeded["s_a2"], seeded["s_b1"], seeded["s_a_done"]}
    finally:
        await engine.dispose()
