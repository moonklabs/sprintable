"""story #3722 — `attribute_tool_call()` 귀속 체인 전 갈래(ⓐ/ⓑ'/ⓑ/ⓒ×3) 실 PG."""
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


async def _make_run(session, *, agent_id, org_id, project_id, status="running", story_id=None):
    from app.models.agent_run import AgentRun
    run = AgentRun(
        id=uuid.uuid4(), org_id=org_id, agent_id=agent_id, project_id=project_id,
        trigger="manual", status=status, story_id=story_id,
    )
    session.add(run)
    await session.flush()
    return run


async def _seed_org_project_agent(session):
    from app.models.member import Member
    from app.models.organization import Organization
    from app.models.project import Project

    org = Organization(id=uuid.uuid4(), name="Org", slug=f"org-{uuid.uuid4().hex[:8]}")
    session.add(org)
    await session.flush()
    project = Project(id=uuid.uuid4(), org_id=org.id, name="Project")
    session.add(project)
    await session.flush()
    agent = Member(id=uuid.uuid4(), org_id=org.id, type="agent", name="Agent A")
    session.add(agent)
    await session.flush()
    return {"org_id": org.id, "project_id": project.id, "agent_id": agent.id}


@pytest.mark.anyio
async def test_header_wins_when_run_belongs_to_agent():
    from app.services.tool_call_attribution import attribute_tool_call

    engine, Session = await _session_factory()
    try:
        async with Session() as s:
            ctx = await _seed_org_project_agent(s)
            run = await _make_run(s, **ctx)
            other_run = await _make_run(s, **ctx)  # 여러 running run이 있어도 header가 이긴다.
            await s.commit()

            result = await attribute_tool_call(
                s, agent_id=ctx["agent_id"], header_run_id=str(run.id), story_id=None,
            )
            assert result.run_id == run.id
            assert result.reason == "header"
            assert result.run_id != other_run.id
    finally:
        await engine.dispose()


@pytest.mark.anyio
async def test_header_ignored_when_run_belongs_to_different_agent():
    """다른 agent의 run_id를 사칭하면 조용히 무시하고 체인을 계속 진행한다(401 아님)."""
    from app.services.tool_call_attribution import attribute_tool_call

    engine, Session = await _session_factory()
    try:
        async with Session() as s:
            ctx_a = await _seed_org_project_agent(s)
            ctx_b = await _seed_org_project_agent(s)
            other_agent_run = await _make_run(s, **ctx_b)
            await s.commit()

            result = await attribute_tool_call(
                s, agent_id=ctx_a["agent_id"], header_run_id=str(other_agent_run.id), story_id=None,
            )
            assert result.run_id is None
            assert result.reason == "no_running_run"
    finally:
        await engine.dispose()


@pytest.mark.anyio
async def test_story_scope_wins_when_exactly_one_running_run_for_that_story():
    from app.services.tool_call_attribution import attribute_tool_call

    engine, Session = await _session_factory()
    try:
        async with Session() as s:
            ctx = await _seed_org_project_agent(s)
            story_id = uuid.uuid4()
            story_run = await _make_run(s, **ctx, story_id=story_id)
            other_story_run = await _make_run(s, **ctx, story_id=uuid.uuid4())  # 다른 story — 무시돼야.
            await s.commit()

            result = await attribute_tool_call(
                s, agent_id=ctx["agent_id"], header_run_id=None, story_id=str(story_id),
            )
            assert result.run_id == story_run.id
            assert result.reason == "story_scope"
            assert result.run_id != other_story_run.id
    finally:
        await engine.dispose()


@pytest.mark.anyio
async def test_ambiguous_multi_run_same_story_does_not_fall_back_to_agent_wide():
    """페드루 PO 판정 — story 문맥이 있는데 그 안에서 이미 모호하면 agent 전체로 안
    내려간다(설령 agent 전체엔 running run이 1개뿐이라도)."""
    from app.services.tool_call_attribution import attribute_tool_call

    engine, Session = await _session_factory()
    try:
        async with Session() as s:
            ctx = await _seed_org_project_agent(s)
            story_id = uuid.uuid4()
            await _make_run(s, **ctx, story_id=story_id)
            await _make_run(s, **ctx, story_id=story_id)  # 같은 story에 running run 2개.
            await s.commit()

            result = await attribute_tool_call(
                s, agent_id=ctx["agent_id"], header_run_id=None, story_id=str(story_id),
            )
            assert result.run_id is None
            assert result.reason == "ambiguous_multi_run_same_story"
    finally:
        await engine.dispose()


@pytest.mark.anyio
async def test_story_with_zero_running_falls_back_to_agent_wide_single_running_other_story():
    """디디 판단(채택 — 페드루 PO 06:22Z) — story 문맥은 있는데 그 story엔 running run이
    0개면 agent 전체로 넘어간다(그 story 얘기는 아니지만 이 agent 얘기는 맞다). 단 이렇게
    정해진 run은 정의상 그 story의 것이 아니므로 reason은 평범한 single_running이 아니라
    single_running_other_story(오귀속 의심 단서, 페드루 PO 追加)."""
    from app.services.tool_call_attribution import attribute_tool_call

    engine, Session = await _session_factory()
    try:
        async with Session() as s:
            ctx = await _seed_org_project_agent(s)
            agent_wide_run = await _make_run(s, **ctx, story_id=None)  # story 없는 running run.
            await s.commit()

            result = await attribute_tool_call(
                s, agent_id=ctx["agent_id"], header_run_id=None, story_id=str(uuid.uuid4()),
            )
            assert result.run_id == agent_wide_run.id
            assert result.reason == "single_running_other_story"
    finally:
        await engine.dispose()


@pytest.mark.anyio
async def test_agent_wide_single_running_when_no_story_id():
    from app.services.tool_call_attribution import attribute_tool_call

    engine, Session = await _session_factory()
    try:
        async with Session() as s:
            ctx = await _seed_org_project_agent(s)
            run = await _make_run(s, **ctx)
            await s.commit()

            result = await attribute_tool_call(
                s, agent_id=ctx["agent_id"], header_run_id=None, story_id=None,
            )
            assert result.run_id == run.id
            assert result.reason == "single_running"
    finally:
        await engine.dispose()


@pytest.mark.anyio
async def test_no_running_run_is_unattributed():
    from app.services.tool_call_attribution import attribute_tool_call

    engine, Session = await _session_factory()
    try:
        async with Session() as s:
            ctx = await _seed_org_project_agent(s)
            await _make_run(s, **ctx, status="completed")  # running 아님 — 카운트 안 됨.
            await s.commit()

            result = await attribute_tool_call(
                s, agent_id=ctx["agent_id"], header_run_id=None, story_id=None,
            )
            assert result.run_id is None
            assert result.reason == "no_running_run"
    finally:
        await engine.dispose()


@pytest.mark.anyio
async def test_agent_wide_ambiguous_when_multiple_running_no_story():
    from app.services.tool_call_attribution import attribute_tool_call

    engine, Session = await _session_factory()
    try:
        async with Session() as s:
            ctx = await _seed_org_project_agent(s)
            await _make_run(s, **ctx)
            await _make_run(s, **ctx)
            await s.commit()

            result = await attribute_tool_call(
                s, agent_id=ctx["agent_id"], header_run_id=None, story_id=None,
            )
            assert result.run_id is None
            assert result.reason == "ambiguous_multi_run"
    finally:
        await engine.dispose()
