"""E-DG S7: agent-handoff relay transaction + delivery status 테스트.

핵심: relay_agent_handoff(dispatch commit=False)·delivery_status step_run 기록·no_assignee/
unresolved 가시화·예외 fail-open · 엔진이 enforcing agent-handoff 에 relay_step_run_id 세팅.
"""
from __future__ import annotations

import os
import uuid
from unittest.mock import patch

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


async def _seed_step_run(s, org, *, from_status="ready-for-dev", to_status="in-progress"):
    from app.models.workflow_line import WorkflowLineStepRun
    sr = WorkflowLineStepRun(
        org_id=org, project_id=uuid.uuid4(), entity_type="story", entity_id=uuid.uuid4(),
        from_status=from_status, to_status=to_status, status="routing_resolved", mode="advisory_only",
        correlation_id=uuid.uuid4(), transition_id=uuid.uuid4().hex)
    s.add(sr); await s.flush()
    return sr


def _resp(dispatched, **kw):
    from app.services.agent_dispatch import DispatchResponse
    return DispatchResponse(dispatched=dispatched, **kw)


# ── relay_agent_handoff (dispatch patch로 격리) ──────────────────────────────
@pytest.mark.skipif(not _REAL_DB_URL, reason="real Postgres 필요")
@pytest.mark.anyio
async def test_relay_dispatched_records_delivery_and_returns_wake():
    from app.services.workflow_line_resolution import relay_agent_handoff
    from app.models.workflow_line import WorkflowLineStepRun
    from sqlalchemy import select
    engine, Session = await _session()
    async with Session() as s:
        org = uuid.uuid4()
        sr = await _seed_step_run(s, org)
        ev, aid = uuid.uuid4(), uuid.uuid4()
        ok = _resp(True, event_id=ev, assignee_id=aid, assignee_type="agent", recipient_seq=7, reason="ok")
        delivery = {"org_id": org, "recipient_id": aid, "content": "x", "event_type": "dispatched",
                    "source_entity_type": "story", "source_entity_id": sr.entity_id, "hypothesis_anchor": None}
        with patch("app.services.agent_dispatch.dispatch_entity_to_assignee",
                   return_value=(ok, delivery)) as m:
            wake = await relay_agent_handoff(s, sr.id, sender_id=uuid.uuid4())
        # commit=False 로 호출됐는지
        assert m.await_count == 1 and m.call_args.kwargs.get("commit") is False
        tm = m.call_args.kwargs.get("trigger_metadata") or {}
        assert tm.get("source") == "workflow_line" and tm.get("step_run_id") == str(sr.id)
        row = (await s.execute(select(WorkflowLineStepRun).where(WorkflowLineStepRun.id == sr.id))).scalar_one()
        assert row.delivery_status == "queued" and row.event_id == ev and row.recipient_seq == 7
        assert row.status == "dispatched"
        # after-commit wake payload(agent)
        assert wake["agent_wake"] == {"recipient_id": str(aid), "recipient_seq": 7}
    await engine.dispose()


@pytest.mark.skipif(not _REAL_DB_URL, reason="real Postgres 필요")
@pytest.mark.anyio
async def test_relay_no_assignee_visible_not_silent():
    from app.services.workflow_line_resolution import relay_agent_handoff
    from app.models.workflow_line import WorkflowLineStepRun
    from sqlalchemy import select
    engine, Session = await _session()
    async with Session() as s:
        org = uuid.uuid4()
        sr = await _seed_step_run(s, org)
        with patch("app.services.agent_dispatch.dispatch_entity_to_assignee",
                   return_value=(_resp(False, reason="no_assignee"), None)):
            wake = await relay_agent_handoff(s, sr.id)
        row = (await s.execute(select(WorkflowLineStepRun).where(WorkflowLineStepRun.id == sr.id))).scalar_one()
        assert row.delivery_status == "no_assignee" and wake is None  # ⭐silent pass 아님(AC⑤)
    await engine.dispose()


@pytest.mark.skipif(not _REAL_DB_URL, reason="real Postgres 필요")
@pytest.mark.anyio
async def test_relay_unresolved_assignee_visible():
    from app.services.workflow_line_resolution import relay_agent_handoff
    from app.models.workflow_line import WorkflowLineStepRun
    from sqlalchemy import select
    engine, Session = await _session()
    async with Session() as s:
        org = uuid.uuid4()
        sr = await _seed_step_run(s, org)
        with patch("app.services.agent_dispatch.dispatch_entity_to_assignee",
                   return_value=(_resp(False, reason="unresolved_assignee"), None)):
            await relay_agent_handoff(s, sr.id)
        row = (await s.execute(select(WorkflowLineStepRun).where(WorkflowLineStepRun.id == sr.id))).scalar_one()
        assert row.delivery_status == "unresolved_assignee"
    await engine.dispose()


@pytest.mark.skipif(not _REAL_DB_URL, reason="real Postgres 필요")
@pytest.mark.anyio
async def test_relay_exception_failopen_dead_letter():
    from app.services.workflow_line_resolution import relay_agent_handoff
    from app.models.workflow_line import WorkflowLineStepRun
    from sqlalchemy import select
    engine, Session = await _session()
    async with Session() as s:
        org = uuid.uuid4()
        sr = await _seed_step_run(s, org)
        with patch("app.services.agent_dispatch.dispatch_entity_to_assignee",
                   side_effect=RuntimeError("boom")):
            wake = await relay_agent_handoff(s, sr.id)  # ⭐예외도 raise 안 함(fail-open)
        row = (await s.execute(select(WorkflowLineStepRun).where(WorkflowLineStepRun.id == sr.id))).scalar_one()
        assert row.delivery_status == "dead_letter" and row.failure_class == "dispatch_exception"
        assert wake is None
    await engine.dispose()


@pytest.mark.skipif(not _REAL_DB_URL, reason="real Postgres 필요")
@pytest.mark.anyio
async def test_relay_db_poison_isolated_by_savepoint():
    """⭐SME blocking 회귀(S3 동류): dispatch 중 DB 예외가 outer 트랜잭션을 poison하면 안 된다.
    SAVEPOINT 격리로 outer tx 보존 → dead_letter 기록 + 후속 commit 성공(전이 비차단)."""
    import sqlalchemy as sa
    from app.services.workflow_line_resolution import relay_agent_handoff
    from app.models.workflow_line import WorkflowLineStepRun
    from sqlalchemy import select
    engine, Session = await _session()
    async with Session() as s:
        org = uuid.uuid4()
        sr = await _seed_step_run(s, org)

        async def _poison(*a, **k):
            await s.execute(sa.text("SELECT 1/0"))  # DB 에러 → 서브트랜잭션 abort

        with patch("app.services.agent_dispatch.dispatch_entity_to_assignee", side_effect=_poison):
            wake = await relay_agent_handoff(s, sr.id)  # ⭐예외도 raise 안 함
        assert wake is None
        row = (await s.execute(select(WorkflowLineStepRun).where(WorkflowLineStepRun.id == sr.id))).scalar_one()
        assert row.delivery_status == "dead_letter"
        # ⭐outer tx 살아있음: 후속 read/write/commit 성공(poison이면 PendingRollbackError)
        assert (await s.execute(sa.text("SELECT 1"))).scalar() == 1
        await s.commit()
    await engine.dispose()


# ── 엔진 relay 플래그 (enforcing agent-handoff만) ────────────────────────────
@pytest.mark.skipif(not _REAL_DB_URL, reason="real Postgres 필요")
@pytest.mark.anyio
async def test_engine_sets_relay_only_for_enforcing_agent_handoff():
    from app.services.workflow_line_engine import evaluate_line_for_transition
    from app.models.workflow_line import WorkflowLineDefinition, WorkflowLineDefinitionVersion

    async def _seed_line(s, org, mode):
        defn = WorkflowLineDefinition(org_id=org, project_id=None, entity_type="story",
                                      name="L", is_active=True, version=1)
        s.add(defn); await s.flush()
        s.add(WorkflowLineDefinitionVersion(
            line_definition_id=defn.id, org_id=org, project_id=None, entity_type="story", version=1,
            status="published", config_hash="h", created_by_member_id=uuid.uuid4(),
            config={"rollout_mode": mode, "steps": [{
                "from_status": "ready-for-dev", "to_status": "in-progress", "step_type": "agent-handoff"}]}))
        await s.flush()

    engine, Session = await _session()
    async with Session() as s:
        org_enf, org_shadow = uuid.uuid4(), uuid.uuid4()
        await _seed_line(s, org_enf, "enforcing")
        await _seed_line(s, org_shadow, "shadow")
        d_enf = await evaluate_line_for_transition(
            s, org_id=org_enf, project_id=None, entity_type="story", entity_id=uuid.uuid4(),
            from_status="ready-for-dev", to_status="in-progress")
        d_shadow = await evaluate_line_for_transition(
            s, org_id=org_shadow, project_id=None, entity_type="story", entity_id=uuid.uuid4(),
            from_status="ready-for-dev", to_status="in-progress")
        assert d_enf.mode == "advisory_only" and d_enf.proceeds and d_enf.relay_step_run_id is not None
        assert d_shadow.relay_step_run_id is None  # shadow=관측만·relay 안 함
    await engine.dispose()
