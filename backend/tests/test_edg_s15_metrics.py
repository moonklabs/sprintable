"""E-DG S15: line metrics + baseline instrumentation 테스트.

핵심: default-off org no-op·handoff_stuck/degraded rate·duplicate_pending_gate·step_run_events
집계·window bounded.
"""
from __future__ import annotations

import os
import uuid
from datetime import datetime, timedelta, timezone

import pytest

_REAL_DB_URL = os.getenv("PARITY_TEST_DATABASE_URL") or os.getenv("ALEMBIC_DATABASE_URL")
_NOW = datetime(2026, 6, 20, 12, 0, 0, tzinfo=timezone.utc)


@pytest.fixture
def anyio_backend():
    return "asyncio"


async def _session():
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


async def _run(s, org, *, status="dispatched", mode="advisory_only", delivery="not_required",
               degraded=False, age_days=1, from_status="in-review", to_status="done",
               gate_type=None, entity_id=None):
    from app.models.workflow_line import WorkflowLineStepRun
    sr = WorkflowLineStepRun(
        org_id=org, project_id=uuid.uuid4(), entity_type="story", entity_id=entity_id or uuid.uuid4(),
        from_status=from_status, to_status=to_status, status=status, mode=mode,
        delivery_status=delivery, degraded_to_plain=degraded, effective_gate_type=gate_type,
        correlation_id=uuid.uuid4(), transition_id=uuid.uuid4().hex,
        started_at=_NOW - timedelta(days=age_days))
    s.add(sr)
    await s.flush()
    return sr


async def _event(s, org, sr, event_type):
    from app.models.workflow_line import WorkflowLineStepRunEvent
    s.add(WorkflowLineStepRunEvent(
        org_id=org, project_id=sr.project_id, step_run_id=sr.id, event_type=event_type,
        correlation_id=sr.correlation_id, created_at=_NOW - timedelta(days=1)))
    await s.flush()


@pytest.mark.skipif(not _REAL_DB_URL, reason="real Postgres 필요")
@pytest.mark.anyio
async def test_default_off_org_no_op():
    from app.services.workflow_line_metrics import compute_line_metrics
    engine, Session = await _session()
    async with Session() as s:
        m = await compute_line_metrics(s, uuid.uuid4(), now=_NOW)
        assert m["no_op"] is True and m["total_step_runs"] == 0
    await engine.dispose()


@pytest.mark.skipif(not _REAL_DB_URL, reason="real Postgres 필요")
@pytest.mark.anyio
async def test_handoff_stuck_and_degraded_rates():
    from app.services.workflow_line_metrics import compute_line_metrics
    engine, Session = await _session()
    async with Session() as s:
        org = uuid.uuid4()
        await _run(s, org, delivery="timed_out")   # stuck
        await _run(s, org, delivery="acked")
        await _run(s, org, delivery="queued")
        await _run(s, org, status="engine_failed", mode="engine_failed", degraded=True)  # degraded
        m = await compute_line_metrics(s, org, now=_NOW)
        assert m["total_step_runs"] == 4 and m["handoff_total"] == 3
        assert m["handoff_stuck_rate"] == round(1 / 3, 4)        # 1 timed_out / 3 handoff
        assert m["engine_degraded_transition_rate"] == round(1 / 4, 4)  # 1 degraded / 4 total
        assert m["handoff_acked_count"] == 1
    await engine.dispose()


@pytest.mark.skipif(not _REAL_DB_URL, reason="real Postgres 필요")
@pytest.mark.anyio
async def test_duplicate_pending_gate_and_events():
    from app.services.workflow_line_metrics import compute_line_metrics
    engine, Session = await _session()
    async with Session() as s:
        org = uuid.uuid4()
        # 같은 (entity, from, to, gate_type) pending-gate 2건 → duplicate 그룹 1
        eid = uuid.uuid4()
        await _run(s, org, status="gate_pending", gate_type="merge", entity_id=eid)
        await _run(s, org, status="waiting_gate", gate_type="merge", entity_id=eid)
        sr = await _run(s, org, status="gate_pending")
        await _event(s, org, sr, "reminded")
        await _event(s, org, sr, "reminded")
        await _event(s, org, sr, "escalated")
        m = await compute_line_metrics(s, org, now=_NOW)
        assert m["duplicate_pending_gate_count"] == 1
        assert m["reminder_count"] == 2 and m["escalation_count"] == 1
    await engine.dispose()


@pytest.mark.skipif(not _REAL_DB_URL, reason="real Postgres 필요")
@pytest.mark.anyio
async def test_window_bounds_exclude_old():
    from app.services.workflow_line_metrics import compute_line_metrics
    engine, Session = await _session()
    async with Session() as s:
        org = uuid.uuid4()
        await _run(s, org, delivery="timed_out", age_days=2)    # 창 내
        await _run(s, org, delivery="timed_out", age_days=30)   # 창 밖(14d)
        m = await compute_line_metrics(s, org, window_days=14, now=_NOW)
        assert m["total_step_runs"] == 1  # old 제외
    await engine.dispose()
