"""story #4185(E-MOBILE-SPEED) — agent-stats 묶음 조회. 에이전트 성과 패널이 에이전트마다 단건을 부르던 N+1을
한 번으로. 핵심 불변식: **묶음의 각 값 == 같은 에이전트의 단건 값**(같은 계산 한 벌), 프로젝트 밖·에이전트 아닌 id는
빠진다(단건 None과 같은 판정), is_excluded·삭제 스토리는 빠진다."""
from __future__ import annotations

import os
import uuid
from datetime import datetime, timedelta, timezone

import pytest

from tests.test_e4fc29fa_site_post_orchestration import _seed_org, _session_factory

_REAL_DB_URL = os.getenv("PARITY_TEST_DATABASE_URL") or os.getenv("ALEMBIC_DATABASE_URL")

pytestmark = [
    pytest.mark.destructive_schema,
    pytest.mark.skipif(not _REAL_DB_URL, reason="real Postgres 필요"),
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


async def _seed(s, org_id, project_id):
    from app.models.pm import Story
    from app.models.team import TeamMember

    agents = []
    for name in ("a1", "a2", "a3"):
        m = TeamMember(id=uuid.uuid4(), org_id=org_id, project_id=project_id, type="agent", name=name, is_active=True)
        s.add(m)
        agents.append(m.id)
    human = TeamMember(id=uuid.uuid4(), org_id=org_id, project_id=project_id, type="human", name="h", is_active=True)
    s.add(human)
    await s.commit()

    t0 = datetime(2026, 9, 1, tzinfo=timezone.utc)
    rows = [
        # a1: done 2(3pt·5pt, 리드타임 1일·3일) + in-progress 1 + excluded done 1 + 삭제 done 1
        (agents[0], "done", 3, t0, t0 + timedelta(days=1), False, None),
        (agents[0], "done", 5, t0, t0 + timedelta(days=3), False, None),
        (agents[0], "in-progress", 8, t0, t0, False, None),
        (agents[0], "done", 13, t0, t0 + timedelta(days=9), True, None),
        (agents[0], "done", 21, t0, t0 + timedelta(days=9), False, t0),
        # a2: done 1(points None)
        (agents[1], "done", None, t0, t0 + timedelta(hours=6), False, None),
        # a3: 스토리 0
    ]
    for assignee, status, points, created, updated, excluded, deleted in rows:
        s.add(Story(
            id=uuid.uuid4(), org_id=org_id, project_id=project_id, title=f"s-{uuid.uuid4().hex[:6]}",
            status=status, story_points=points, assignee_id=assignee, is_excluded=excluded, deleted_at=deleted,
            created_at=created, updated_at=updated,
        ))
    await s.commit()
    return agents, human.id


async def test_batch_equals_single_per_agent_and_filters_like_single():
    from app.repositories.analytics import AnalyticsRepository

    engine, Session = await _session_factory()
    try:
        async with Session() as s:
            org_id, project_id = await _seed_org(s)
            agents, human_id = await _seed(s, org_id, project_id)
            repo = AnalyticsRepository(s, org_id)
            outsider = uuid.uuid4()
            batch = await repo.get_agent_stats_batch(project_id, [*agents, human_id, outsider])

            assert set(batch) == set(agents)  # 사람·없는 id는 빠진다
            for aid in agents:
                assert batch[aid] == await repo.get_agent_stats(project_id, aid)
            assert await repo.get_agent_stats(project_id, human_id) is None

            a1 = batch[agents[0]]
            assert (a1["completed"], a1["total_stories"], a1["done_story_points"]) == (2, 3, 8)
            assert a1["avg_lead_time_ms"] == 2 * 24 * 3600 * 1000  # (1일+3일)/2
            assert batch[agents[1]]["done_story_points"] == 0
            assert batch[agents[2]]["total_stories"] == 0
            assert await repo.get_agent_stats_batch(project_id, []) == {}
    finally:
        await engine.dispose()


async def test_batch_is_scoped_to_the_project():
    """다른 프로젝트의 에이전트 id는 묶음에서 빠진다(단건 404와 같은 판정)."""
    from app.models.project import Project
    from app.repositories.analytics import AnalyticsRepository

    engine, Session = await _session_factory()
    try:
        async with Session() as s:
            org_id, project_id = await _seed_org(s)
            agents, _ = await _seed(s, org_id, project_id)
            other = Project(id=uuid.uuid4(), org_id=org_id, name="other")
            s.add(other)
            await s.commit()
            repo = AnalyticsRepository(s, org_id)
            assert await repo.get_agent_stats_batch(other.id, agents) == {}
    finally:
        await engine.dispose()
