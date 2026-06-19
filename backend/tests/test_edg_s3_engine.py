"""E-DG S3: workflow line engine (P0-1 fail-open core) 테스트.

핵심: 엔진의 어떤 실패도 board 전이를 freeze하지 않는다(fail-open). + off/no-line→plain,
shadow→advisory_only+step_run, enforcing 정적 block→blocked_by_policy.
"""
from __future__ import annotations

import os
import uuid
from unittest.mock import patch

import pytest

from app.services.workflow_line_engine import LineDecision

_REAL_DB_URL = os.getenv("PARITY_TEST_DATABASE_URL") or os.getenv("ALEMBIC_DATABASE_URL")


@pytest.fixture
def anyio_backend():
    return "asyncio"


# ── pure: proceeds 분류 ──────────────────────────────────────────────────────
def test_decision_proceeds_classification():
    assert LineDecision("plain_transition", None).proceeds
    assert LineDecision("advisory_only", "done").proceeds
    assert LineDecision("engine_failed", "done", degraded_to_plain=True).proceeds
    assert not LineDecision("blocked_by_policy", None, http_status=409).proceeds
    assert not LineDecision("gate_pending", None).proceeds


# ── DB-backed ────────────────────────────────────────────────────────────────
async def _engine_session():
    from sqlalchemy.ext.asyncio import async_sessionmaker, create_async_engine

    from app.core.database import Base
    import app.models  # noqa: F401
    import app.models.workflow_line  # noqa: F401

    url = _REAL_DB_URL
    for prefix in ("postgresql+psycopg2://", "postgresql+asyncpg://", "postgresql://"):
        if url.startswith(prefix):
            url = "postgresql+asyncpg://" + url[len(prefix):]
            break
    engine = create_async_engine(url)
    async with engine.begin() as conn:
        await conn.run_sync(Base.metadata.create_all)
    return engine, async_sessionmaker(engine, expire_on_commit=False)


async def _seed_active_line(session, org_id, entity_type, config, project_id=None):
    from app.models.workflow_line import WorkflowLineDefinition, WorkflowLineDefinitionVersion
    defn = WorkflowLineDefinition(
        org_id=org_id, project_id=project_id, entity_type=entity_type, name="line",
        is_active=True, version=1,
    )
    session.add(defn)
    await session.flush()
    ver = WorkflowLineDefinitionVersion(
        line_definition_id=defn.id, org_id=org_id, project_id=project_id, entity_type=entity_type,
        version=1, status="published", config=config, config_hash="hash",
        created_by_member_id=uuid.uuid4(),
    )
    session.add(ver)
    await session.flush()
    return defn


async def _count_step_runs(session, entity_id):
    from sqlalchemy import func, select
    from app.models.workflow_line import WorkflowLineStepRun
    r = await session.execute(
        select(func.count()).select_from(WorkflowLineStepRun).where(
            WorkflowLineStepRun.entity_id == entity_id)
    )
    return r.scalar()


@pytest.mark.skipif(not _REAL_DB_URL, reason="real Postgres 필요(PARITY/ALEMBIC_DATABASE_URL)")
@pytest.mark.anyio
async def test_no_active_line_plain_no_step_run():
    from app.services.workflow_line_engine import evaluate_line_for_transition
    engine, Session = await _engine_session()
    async with Session() as session:
        org, eid = uuid.uuid4(), uuid.uuid4()
        d = await evaluate_line_for_transition(
            session, org_id=org, project_id=None, entity_type="story", entity_id=eid,
            from_status="in-review", to_status="done")
        assert d.mode == "plain_transition" and d.proceeds
        assert await _count_step_runs(session, eid) == 0  # step_run 미생성
    await engine.dispose()


@pytest.mark.skipif(not _REAL_DB_URL, reason="real Postgres 필요(PARITY/ALEMBIC_DATABASE_URL)")
@pytest.mark.anyio
async def test_off_mode_plain():
    from app.services.workflow_line_engine import evaluate_line_for_transition
    engine, Session = await _engine_session()
    async with Session() as session:
        org, eid = uuid.uuid4(), uuid.uuid4()
        await _seed_active_line(session, org, "story", {
            "rollout_mode": "off",
            "steps": [{"from_status": "in-review", "to_status": "done", "step_type": "merge-gate"}]})
        d = await evaluate_line_for_transition(
            session, org_id=org, project_id=None, entity_type="story", entity_id=eid,
            from_status="in-review", to_status="done")
        assert d.mode == "plain_transition" and d.proceeds
        assert await _count_step_runs(session, eid) == 0
    await engine.dispose()


@pytest.mark.skipif(not _REAL_DB_URL, reason="real Postgres 필요(PARITY/ALEMBIC_DATABASE_URL)")
@pytest.mark.anyio
async def test_shadow_mode_records_step_run_but_proceeds():
    from app.services.workflow_line_engine import evaluate_line_for_transition
    from app.models.workflow_line import WorkflowLineStepRun
    from sqlalchemy import select
    engine, Session = await _engine_session()
    async with Session() as session:
        org, eid = uuid.uuid4(), uuid.uuid4()
        await _seed_active_line(session, org, "story", {
            "rollout_mode": "shadow",
            "steps": [{"from_status": "in-review", "to_status": "done", "step_type": "merge-gate"}]})
        d = await evaluate_line_for_transition(
            session, org_id=org, project_id=None, entity_type="story", entity_id=eid,
            from_status="in-review", to_status="done")
        assert d.mode == "advisory_only" and d.proceeds  # shadow는 전이 비차단
        sr = (await session.execute(
            select(WorkflowLineStepRun).where(WorkflowLineStepRun.entity_id == eid))).scalar_one()
        assert sr.mode == "advisory_only" and sr.to_status == "done"
    await engine.dispose()


@pytest.mark.skipif(not _REAL_DB_URL, reason="real Postgres 필요(PARITY/ALEMBIC_DATABASE_URL)")
@pytest.mark.anyio
async def test_enforcing_static_block_blocked_by_policy():
    from app.services.workflow_line_engine import evaluate_line_for_transition
    engine, Session = await _engine_session()
    async with Session() as session:
        org, eid = uuid.uuid4(), uuid.uuid4()
        await _seed_active_line(session, org, "story", {
            "rollout_mode": "enforcing",
            "steps": [{"from_status": "in-review", "to_status": "done", "enforcement": "block"}]})
        d = await evaluate_line_for_transition(
            session, org_id=org, project_id=None, entity_type="story", entity_id=eid,
            from_status="in-review", to_status="done")
        # 정상 차단 decision — 예외(engine_failed)와 구분.
        assert d.mode == "blocked_by_policy" and not d.proceeds
        assert d.http_status == 409 and not d.degraded_to_plain
    await engine.dispose()


@pytest.mark.skipif(not _REAL_DB_URL, reason="real Postgres 필요(PARITY/ALEMBIC_DATABASE_URL)")
@pytest.mark.anyio
async def test_fault_injection_engine_failure_degrades_to_plain():
    """⭐P0-1: 엔진 내부 예외 → engine_failed + degraded_to_plain → 전이 진행(proceeds=True)."""
    from app.services import workflow_line_engine as eng
    engine, Session = await _engine_session()
    async with Session() as session:
        org, eid = uuid.uuid4(), uuid.uuid4()
        await _seed_active_line(session, org, "story", {
            "rollout_mode": "shadow",
            "steps": [{"from_status": "in-review", "to_status": "done"}]})
        # _published_config 가 터지도록 강제 주입(resolver/config 예외 시뮬레이션).
        with patch.object(eng, "_published_config", side_effect=RuntimeError("boom")):
            d = await eng.evaluate_line_for_transition(
                session, org_id=org, project_id=None, entity_type="story", entity_id=eid,
                from_status="in-review", to_status="done")
        assert d.mode == "engine_failed"
        assert d.degraded_to_plain is True
        assert d.proceeds is True  # ⭐엔진이 터져도 전이는 진행
        assert d.status_to_apply == "done"
        # best-effort engine_failed step_run 기록 확인
        from sqlalchemy import select
        from app.models.workflow_line import WorkflowLineStepRun
        sr = (await session.execute(
            select(WorkflowLineStepRun).where(WorkflowLineStepRun.entity_id == eid))).scalar_one()
        assert sr.status == "engine_failed" and sr.failure_class == "RuntimeError"
    await engine.dispose()


@pytest.mark.skipif(not _REAL_DB_URL, reason="real Postgres 필요(PARITY/ALEMBIC_DATABASE_URL)")
@pytest.mark.anyio
async def test_step_run_flush_failure_savepoint_does_not_poison_session():
    """⭐P0-1(레드팀 적출): step_run insert flush 실패(active partial unique 충돌=double-fire)가
    outer 트랜잭션을 poison하면 안 된다. SAVEPOINT 격리로 outer tx 보존 → 후속 set_status/commit 정상.
    """
    import sqlalchemy as sa
    from app.services.workflow_line_engine import evaluate_line_for_transition
    engine, Session = await _engine_session()
    async with Session() as session:
        org, eid, eid2 = uuid.uuid4(), uuid.uuid4(), uuid.uuid4()
        await _seed_active_line(session, org, "story", {
            "rollout_mode": "shadow",
            "steps": [{"from_status": "in-review", "to_status": "done", "step_type": "merge-gate"}]})
        kw = dict(org_id=org, project_id=None, entity_type="story",
                  from_status="in-review", to_status="done")
        d1 = await evaluate_line_for_transition(session, entity_id=eid, **kw)
        assert d1.mode == "advisory_only" and d1.step_run_id is not None
        # 동일 전이 재평가 → 2번째 step_run insert가 active partial unique 충돌(non-terminal 'routing_resolved').
        d2 = await evaluate_line_for_transition(session, entity_id=eid, **kw)
        assert d2.proceeds is True  # ⭐충돌해도 전이는 진행(비차단)
        # ⭐session 비-poison 증명: 후속 read/write/commit 모두 성공(poison이면 PendingRollbackError).
        assert (await session.execute(sa.text("SELECT 1"))).scalar() == 1
        d3 = await evaluate_line_for_transition(session, entity_id=eid2, **kw)  # 다른 entity write 정상
        assert d3.mode == "advisory_only" and d3.step_run_id is not None
        await session.commit()  # commit 성공 = outer tx 살아있음
    await engine.dispose()
