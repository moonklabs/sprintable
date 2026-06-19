"""E-DG S11-unblock: workflow-line status 배치 read 테스트.

핵심: 여러 story 의 active 요약(mode/status+flags+delivery_status)·run 없거나 terminal-only 면
has_active=False·handoff_stuck(timed_out)·engine_degraded/grandfathered·story_ids 순서 보존·N+1 0.
"""
from __future__ import annotations

import os
import uuid

import pytest

_REAL_DB_URL = os.getenv("PARITY_TEST_DATABASE_URL") or os.getenv("ALEMBIC_DATABASE_URL")


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


async def _run(s, org, story_id, *, status="gate_pending", mode="advisory_only", **kw):
    from app.models.workflow_line import WorkflowLineStepRun
    sr = WorkflowLineStepRun(
        org_id=org, project_id=uuid.uuid4(), entity_type="story", entity_id=story_id,
        from_status="in-review", to_status="done", status=status, mode=mode,
        correlation_id=uuid.uuid4(), transition_id=uuid.uuid4().hex, **kw)
    s.add(sr)
    await s.flush()
    return sr


@pytest.mark.skipif(not _REAL_DB_URL, reason="real Postgres 필요")
@pytest.mark.anyio
async def test_batch_summary_active_and_missing():
    from app.services.workflow_line_status import build_workflow_line_status_batch
    engine, Session = await _session()
    async with Session() as s:
        org = uuid.uuid4()
        s1, s2, s3 = uuid.uuid4(), uuid.uuid4(), uuid.uuid4()
        await _run(s, org, s1, status="gate_pending", delivery_status="not_required")
        await _run(s, org, s2, status="applied")  # terminal-only → has_active=False
        # s3: run 없음
        res = await build_workflow_line_status_batch(s, org, [s1, s2, s3])
        by_id = {r.story_id: r for r in res}
        assert by_id[s1].has_active is True and by_id[s1].status == "gate_pending"
        assert by_id[s2].has_active is False  # terminal-only(active 아님)
        assert by_id[s3].has_active is False  # run 없음
        # ⭐순서 보존(story_ids 순)
        assert [r.story_id for r in res] == [s1, s2, s3]
    await engine.dispose()


@pytest.mark.skipif(not _REAL_DB_URL, reason="real Postgres 필요")
@pytest.mark.anyio
async def test_batch_handoff_stuck_and_degraded_flags():
    from app.services.workflow_line_status import build_workflow_line_status_batch
    engine, Session = await _session()
    async with Session() as s:
        org = uuid.uuid4()
        stuck, degraded, grand = uuid.uuid4(), uuid.uuid4(), uuid.uuid4()
        await _run(s, org, stuck, status="dispatched", delivery_status="timed_out")  # handoff_stuck
        await _run(s, org, degraded, status="gate_pending", degraded_to_plain=True)
        await _run(s, org, grand, status="gate_pending", mode="plain_transition")
        res = {r.story_id: r for r in
               await build_workflow_line_status_batch(s, org, [stuck, degraded, grand])}
        assert res[stuck].handoff_stuck is True and res[stuck].delivery_status == "timed_out"
        assert res[degraded].engine_degraded is True
        assert res[grand].grandfathered is True
    await engine.dispose()


@pytest.mark.skipif(not _REAL_DB_URL, reason="real Postgres 필요")
@pytest.mark.anyio
async def test_batch_latest_active_per_story_and_org_scope():
    from app.services.workflow_line_status import build_workflow_line_status_batch
    from datetime import datetime, timedelta, timezone
    engine, Session = await _session()
    async with Session() as s:
        org, other_org = uuid.uuid4(), uuid.uuid4()
        sid = uuid.uuid4()
        now = datetime(2026, 6, 19, tzinfo=timezone.utc)
        await _run(s, org, sid, status="gate_pending", started_at=now - timedelta(hours=5))
        await _run(s, org, sid, status="waiting_gate", started_at=now - timedelta(hours=1))  # 최신
        # 다른 org 의 동일 story id run → org-scope 로 제외돼야
        await _run(s, other_org, sid, status="escalated")
        res = await build_workflow_line_status_batch(s, org, [sid])
        assert len(res) == 1 and res[0].status == "waiting_gate"  # 최신 active·타 org 미혼입
    await engine.dispose()


@pytest.mark.skipif(not _REAL_DB_URL, reason="real Postgres 필요")
@pytest.mark.anyio
async def test_batch_empty_ids():
    from app.services.workflow_line_status import build_workflow_line_status_batch
    engine, Session = await _session()
    async with Session() as s:
        assert await build_workflow_line_status_batch(s, uuid.uuid4(), []) == []
    await engine.dispose()
