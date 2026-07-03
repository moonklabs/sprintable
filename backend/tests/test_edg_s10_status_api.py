"""E-DG S10: workflow-line status read model 테스트.

핵심: active step_run 조립(gate H1 evidence·approvers·last_event·blocking_reason·correlation)·
active 없으면 terminal 5개 history(desc)·engine_degraded/grandfathered 명시.
"""
from __future__ import annotations

import os
import uuid
from datetime import datetime, timedelta, timezone

import pytest

_REAL_DB_URL = os.getenv("PARITY_TEST_DATABASE_URL") or os.getenv("ALEMBIC_DATABASE_URL")

# story 8236bbc3: create_all(+drop_all)로 자체 스키마를 직접 다룸 — 공유 alembic-migrated
# DB 오염 방지 위해 격리 DB 전용(conftest.py 가드가 마커 누락을 자동 검출).
pytestmark = pytest.mark.destructive_schema
_NOW = datetime(2026, 6, 19, 12, 0, 0, tzinfo=timezone.utc)


@pytest.fixture
def anyio_backend():
    return "asyncio"


async def _session():
    from sqlalchemy.ext.asyncio import async_sessionmaker, create_async_engine
    from app.core.database import Base
    import app.models  # noqa: F401
    import app.models.workflow_line  # noqa: F401
    import app.models.gate  # noqa: F401
    url = _REAL_DB_URL
    for prefix in ("postgresql+psycopg2://", "postgresql+asyncpg://", "postgresql://"):
        if url.startswith(prefix):
            url = "postgresql+asyncpg://" + url[len(prefix):]
            break
    engine = create_async_engine(url)
    async with engine.begin() as conn:
        await conn.run_sync(Base.metadata.create_all)
    return engine, async_sessionmaker(engine, expire_on_commit=False)


async def _seed_run(s, org, story_id, *, status="gate_pending", mode="advisory_only",
                    age_min=0, **kw):
    from app.models.workflow_line import WorkflowLineStepRun
    sr = WorkflowLineStepRun(
        org_id=org, project_id=uuid.uuid4(), entity_type="story", entity_id=story_id,
        from_status="in-review", to_status="done", status=status, mode=mode,
        correlation_id=uuid.uuid4(), transition_id=uuid.uuid4().hex,
        started_at=_NOW - timedelta(minutes=age_min), **kw)
    s.add(sr)
    await s.flush()
    return sr


@pytest.mark.skipif(not _REAL_DB_URL, reason="real Postgres 필요")
@pytest.mark.anyio
async def test_active_with_gate_evidence_and_approvers():
    from app.services.workflow_line_status import build_workflow_line_status
    from app.models.gate import Gate
    from app.models.workflow_line import WorkflowLineStepApproval
    engine, Session = await _session()
    async with Session() as s:
        org, story = uuid.uuid4(), uuid.uuid4()
        gate = Gate(id=uuid.uuid4(), org_id=org, work_item_id=story, work_item_type="story",
                    gate_type="merge", status="pending", requires_human=True,
                    evidence_status="ready", decision_basis="trust_low", auto_decision_reason=None)
        s.add(gate)
        await s.flush()
        group = uuid.uuid4()
        sr = await _seed_run(s, org, story, status="gate_pending", gate_id=gate.id,
                             approval_group_id=group, routing_reason="trust_below_threshold")
        for kind in ("approver", "consult"):
            s.add(WorkflowLineStepApproval(
                org_id=org, project_id=sr.project_id, step_run_id=sr.id, gate_id=gate.id,
                approval_group_id=group, approver_member_id=uuid.uuid4(), approver_member_type="human",
                kind=kind, blocking=(kind == "approver"), status="pending"))
        await s.flush()

        res = await build_workflow_line_status(s, org, story)
        assert res.has_active is True and res.active is not None
        a = res.active
        assert a.gate_id == gate.id and a.correlation_id == sr.correlation_id
        assert a.blocking_reason == "trust_below_threshold"
        assert a.h1_evidence["requires_human"] is True and a.h1_evidence["evidence_status"] == "ready"
        assert a.h1_evidence["gate_status"] == "pending"
        assert len(a.approvers) == 2  # approver + consult 둘 다 노출(audit)
        assert a.last_event is None
    await engine.dispose()


@pytest.mark.skipif(not _REAL_DB_URL, reason="real Postgres 필요")
@pytest.mark.anyio
async def test_active_with_last_event():
    from app.services.workflow_line_status import build_workflow_line_status
    from app.models.event import Event
    from app.models.project import Project
    from app.models.team import TeamMember
    engine, Session = await _session()
    async with Session() as s:
        org, story = uuid.uuid4(), uuid.uuid4()
        proj, rcpt = uuid.uuid4(), uuid.uuid4()
        s.add(Project(id=proj, org_id=org, name="p"))
        s.add(TeamMember(id=rcpt, org_id=org, project_id=proj, type="agent", name="r"))
        await s.flush()
        ev = Event(org_id=org, project_id=proj, event_type="dispatched", source_entity_type="story",
                   source_entity_id=story, recipient_id=rcpt, recipient_type="agent", payload={},
                   status="pending", recipient_seq=7)
        s.add(ev)
        await s.flush()
        await _seed_run(s, org, story, status="dispatched", event_id=ev.id, delivery_status="queued")

        res = await build_workflow_line_status(s, org, story)
        assert res.active is not None and res.active.last_event is not None
        assert res.active.last_event.recipient_seq == 7 and res.active.delivery_status == "queued"
    await engine.dispose()


@pytest.mark.skipif(not _REAL_DB_URL, reason="real Postgres 필요")
@pytest.mark.anyio
async def test_no_active_returns_terminal_history_capped_5_desc():
    from app.services.workflow_line_status import build_workflow_line_status
    engine, Session = await _session()
    async with Session() as s:
        org, story = uuid.uuid4(), uuid.uuid4()
        # 6개 terminal run(전부 applied) — i=0 가 가장 최근(age 10m)·i=5 가 가장 오래(age 60m)
        srs = [await _seed_run(s, org, story, status="applied", age_min=(i + 1) * 10) for i in range(6)]
        res = await build_workflow_line_status(s, org, story)
        assert res.has_active is False and res.active is None
        assert len(res.history) == 5  # 5개로 cap(AC③)
        # started_at desc — 최근 5개(i=0..4)만·desc 순서. 가장 오래된 i=5 는 탈락.
        expected = [srs[i].correlation_id for i in range(5)]  # i=0(최근)…i=4
        assert [h.correlation_id for h in res.history] == expected
        assert srs[5].correlation_id not in {h.correlation_id for h in res.history}
    await engine.dispose()


@pytest.mark.skipif(not _REAL_DB_URL, reason="real Postgres 필요")
@pytest.mark.anyio
async def test_engine_degraded_flag_and_note():
    from app.services.workflow_line_status import build_workflow_line_status
    engine, Session = await _session()
    async with Session() as s:
        org, story = uuid.uuid4(), uuid.uuid4()
        # degraded_to_plain True + open status → active 로 잡혀 engine_degraded 노출
        await _seed_run(s, org, story, status="gate_pending", degraded_to_plain=True)
        res = await build_workflow_line_status(s, org, story)
        assert res.active.engine_degraded is True
        assert "관측만 실패" in (res.active.observability_note or "")
    await engine.dispose()


@pytest.mark.skipif(not _REAL_DB_URL, reason="real Postgres 필요")
@pytest.mark.anyio
async def test_grandfathered_flag():
    from app.services.workflow_line_status import build_workflow_line_status
    engine, Session = await _session()
    async with Session() as s:
        org, story = uuid.uuid4(), uuid.uuid4()
        await _seed_run(s, org, story, status="gate_pending", mode="plain_transition")
        res = await build_workflow_line_status(s, org, story)
        assert res.active.grandfathered is True
        assert "grandfathered" in (res.active.observability_note or "")
    await engine.dispose()


@pytest.mark.skipif(not _REAL_DB_URL, reason="real Postgres 필요")
@pytest.mark.anyio
async def test_no_runs_empty_status():
    from app.services.workflow_line_status import build_workflow_line_status
    engine, Session = await _session()
    async with Session() as s:
        org, story = uuid.uuid4(), uuid.uuid4()
        res = await build_workflow_line_status(s, org, story)
        assert res.has_active is False and res.active is None and res.history == []
    await engine.dispose()
