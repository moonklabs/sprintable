"""story 5040: POST /api/v2/sprints/{id}/cancel — 시작 안 한(planning) 스프린트만 접는 비파괴 길.

허용 여부는 도구 이름이 아니라 «스프린트 상태»로 서버가 강제한다: planning → closed(velocity 0·채점 없음),
active · review · closed 는 409 + 행 불변, 다른 project 의 sprint 는 close/activate 와 같이 403 + 행 불변.
실 Postgres(PARITY/ALEMBIC_DATABASE_URL) 필요."""
from __future__ import annotations

import os
import uuid

import pytest

from tests.test_e_security_sec_s8_cc_sprint_project_scope_realdb import (
    _client_for,
    _seed_base,
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


@pytest.fixture(autouse=True)
async def _dispose_global_engine_after_test():
    yield
    from app.core.database import engine as _global_engine
    await _global_engine.dispose()


async def _seed_sprint(session, org_id, project_id, status, velocity=None):
    from app.models.pm import Sprint
    sprint = Sprint(
        id=uuid.uuid4(), org_id=org_id, project_id=project_id, title="Sprint",
        status=status, duration=14, velocity=velocity,
    )
    session.add(sprint)
    await session.commit()
    return sprint.id


async def _reload(Session, sprint_id):
    from sqlalchemy import select
    from app.models.pm import Sprint
    async with Session() as s:
        return (await s.execute(select(Sprint).where(Sprint.id == sprint_id))).scalar_one()


@pytest.mark.anyio
async def test_cancel_planning_sprint_closes_with_velocity_zero():
    from app.main import app

    engine, Session = await _session_factory()
    try:
        async with Session() as s:
            seeded = await _seed_base(s)
            sprint_a = await _seed_sprint(s, seeded["org_id"], seeded["project_a_id"], "planning")

        await _setup_app(app, Session, seeded["human_user_id"], seeded["org_id"])
        client = _client_for(app)
        try:
            resp = await client.post(f"/api/v2/sprints/{sprint_a}/cancel")
            assert resp.status_code == 200, resp.text
            assert resp.json()["status"] == "closed"
            assert resp.json()["velocity"] == 0
        finally:
            await client.aclose()

        reloaded = await _reload(Session, sprint_a)
        assert reloaded.status == "closed"
        assert reloaded.velocity == 0
        # discard 경로 — 한 번도 안 뛴 스프린트를 가설 채점하지 않는다.
        assert reloaded.outcome_status == "n_a"
    finally:
        app.dependency_overrides.clear()
        await engine.dispose()


@pytest.mark.anyio
@pytest.mark.parametrize("status,velocity", [("active", 7), ("review", 5), ("closed", 3)])
async def test_cancel_non_planning_sprint_409_row_unchanged(status, velocity):
    from app.main import app

    engine, Session = await _session_factory()
    try:
        async with Session() as s:
            seeded = await _seed_base(s)
            sprint_a = await _seed_sprint(s, seeded["org_id"], seeded["project_a_id"], status, velocity)

        await _setup_app(app, Session, seeded["human_user_id"], seeded["org_id"])
        client = _client_for(app)
        try:
            resp = await client.post(f"/api/v2/sprints/{sprint_a}/cancel")
            assert resp.status_code == 409, resp.text
            assert "planning" in resp.json()["error"]["message"]
        finally:
            await client.aclose()

        reloaded = await _reload(Session, sprint_a)
        assert reloaded.status == status, "planning 이 아닌 스프린트는 상태가 그대로여야 함"
        assert reloaded.velocity == velocity, "planning 이 아닌 스프린트는 velocity 가 그대로여야 함"
    finally:
        app.dependency_overrides.clear()
        await engine.dispose()


@pytest.mark.anyio
async def test_cancel_cross_project_blocked_no_mutation():
    """close/activate 와 같은 project-scope 봉인 — 접근권 없는 project 의 planning sprint 는 접히지 않는다."""
    from app.main import app

    engine, Session = await _session_factory()
    try:
        async with Session() as s:
            seeded = await _seed_base(s)
            sprint_b = await _seed_sprint(s, seeded["org_id"], seeded["project_b_id"], "planning")

        await _setup_app(app, Session, seeded["human_user_id"], seeded["org_id"])
        client = _client_for(app)
        try:
            resp = await client.post(f"/api/v2/sprints/{sprint_b}/cancel")
            assert resp.status_code == 403, resp.text
        finally:
            await client.aclose()

        reloaded = await _reload(Session, sprint_b)
        assert reloaded.status == "planning", "무권한 project sprint가 접히면 안 됨"
    finally:
        app.dependency_overrides.clear()
        await engine.dispose()
