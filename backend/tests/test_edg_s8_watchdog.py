"""E-DG S8: handoff watchdog + ACK reconciliation 테스트.

핵심: ACK 대사(cursor acked_seq>=recipient_seq→acked)·10m 미ACK→timed_out+fallback notification·
방어(missing event/recipient_seq·human recipient)·idempotent(terminal 제외)·not-yet-stuck 제외.
"""
from __future__ import annotations

import os
import uuid
from datetime import datetime, timedelta, timezone
from unittest.mock import AsyncMock, patch

import pytest

_REAL_DB_URL = os.getenv("PARITY_TEST_DATABASE_URL") or os.getenv("ALEMBIC_DATABASE_URL")
_NOW = datetime(2026, 6, 19, 12, 0, 0, tzinfo=timezone.utc)


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


async def _seed_run(s, org, *, delivery_status="queued", recipient_seq=5, recipient_type="agent",
                    with_event=True, age_min=20, recipient_id=None):
    from app.models.event import Event
    from app.models.project import Project
    from app.models.team import TeamMember
    from app.models.workflow_line import WorkflowLineStepRun
    recipient_id = recipient_id or uuid.uuid4()
    proj = uuid.uuid4()
    s.add(Project(id=proj, org_id=org, name="p"))
    s.add(TeamMember(id=recipient_id, org_id=org, project_id=proj, type=recipient_type, name="rcpt"))
    await s.flush()
    event_id = None
    if with_event:
        ev = Event(org_id=org, project_id=proj, event_type="dispatched",
                   source_entity_type="story", source_entity_id=uuid.uuid4(),
                   recipient_id=recipient_id, recipient_type=recipient_type, payload={}, status="pending")
        s.add(ev); await s.flush()
        event_id = ev.id
    sr = WorkflowLineStepRun(
        org_id=org, project_id=proj, entity_type="story", entity_id=uuid.uuid4(),
        from_status="ready-for-dev", to_status="in-progress", status="dispatched", mode="advisory_only",
        delivery_status=delivery_status, event_id=event_id, recipient_seq=recipient_seq,
        correlation_id=uuid.uuid4(), transition_id=uuid.uuid4().hex,
        created_at=_NOW - timedelta(minutes=age_min))
    s.add(sr); await s.flush()
    return sr, recipient_id


async def _seed_cursor(s, agent_id, acked_seq):
    from app.models.agent_gateway import AgentEventCursor
    s.add(AgentEventCursor(agent_id=agent_id, acked_seq=acked_seq)); await s.flush()


@pytest.mark.skipif(not _REAL_DB_URL, reason="real Postgres 필요")
@pytest.mark.anyio
async def test_ack_reconciled_to_acked():
    from app.services.workflow_handoff_watchdog import reconcile_handoffs
    from app.models.workflow_line import WorkflowLineStepRun
    from sqlalchemy import select
    engine, Session = await _session()
    async with Session() as s:
        org = uuid.uuid4()
        sr, rid = await _seed_run(s, org, recipient_seq=5)
        await _seed_cursor(s, rid, acked_seq=7)  # acked_seq >= recipient_seq
        with patch("app.services.notification_dispatch.dispatch_notification", new=AsyncMock()) as notify:
            counts = await reconcile_handoffs(s, now=_NOW)
        row = (await s.execute(select(WorkflowLineStepRun).where(WorkflowLineStepRun.id == sr.id))).scalar_one()
        assert row.delivery_status == "acked" and counts["acked"] == 1
        assert notify.await_count == 0  # ACK 됨 → notification 불요
    await engine.dispose()


@pytest.mark.skipif(not _REAL_DB_URL, reason="real Postgres 필요")
@pytest.mark.anyio
async def test_stuck_agent_no_ack_timed_out_and_notify():
    from app.services.workflow_handoff_watchdog import reconcile_handoffs
    from app.models.workflow_line import WorkflowLineStepRun
    from sqlalchemy import select
    engine, Session = await _session()
    async with Session() as s:
        org = uuid.uuid4()
        sr, rid = await _seed_run(s, org, recipient_seq=5)
        await _seed_cursor(s, rid, acked_seq=3)  # acked_seq < recipient_seq → 미ACK
        with patch("app.services.notification_dispatch.dispatch_notification", new=AsyncMock()) as notify:
            counts = await reconcile_handoffs(s, now=_NOW)
        row = (await s.execute(select(WorkflowLineStepRun).where(WorkflowLineStepRun.id == sr.id))).scalar_one()
        assert row.delivery_status == "timed_out" and counts["stuck"] == 1
        assert notify.await_count == 1  # fallback notification
    await engine.dispose()


@pytest.mark.skipif(not _REAL_DB_URL, reason="real Postgres 필요")
@pytest.mark.anyio
async def test_stuck_human_recipient():
    from app.services.workflow_handoff_watchdog import reconcile_handoffs
    from app.models.workflow_line import WorkflowLineStepRun
    from sqlalchemy import select
    engine, Session = await _session()
    async with Session() as s:
        org = uuid.uuid4()
        sr, rid = await _seed_run(s, org, recipient_type="human")  # ACK cursor N/A
        with patch("app.services.notification_dispatch.dispatch_notification", new=AsyncMock()) as notify:
            await reconcile_handoffs(s, now=_NOW)
        row = (await s.execute(select(WorkflowLineStepRun).where(WorkflowLineStepRun.id == sr.id))).scalar_one()
        assert row.delivery_status == "timed_out" and notify.await_count == 1
    await engine.dispose()


@pytest.mark.skipif(not _REAL_DB_URL, reason="real Postgres 필요")
@pytest.mark.anyio
async def test_missing_event_and_recipient_seq_defensive():
    from app.services.workflow_handoff_watchdog import reconcile_handoffs
    from app.models.workflow_line import WorkflowLineStepRun
    from sqlalchemy import select
    engine, Session = await _session()
    async with Session() as s:
        org = uuid.uuid4()
        sr_noevent, _ = await _seed_run(s, org, with_event=False)
        sr_noseq, rid = await _seed_run(s, org, recipient_seq=None)
        with patch("app.services.notification_dispatch.dispatch_notification", new=AsyncMock()):
            counts = await reconcile_handoffs(s, now=_NOW)
        r1 = (await s.execute(select(WorkflowLineStepRun).where(WorkflowLineStepRun.id == sr_noevent.id))).scalar_one()
        r2 = (await s.execute(select(WorkflowLineStepRun).where(WorkflowLineStepRun.id == sr_noseq.id))).scalar_one()
        assert r1.delivery_status == "timed_out" and r1.delivery_error == "missing_dispatch_event"
        assert r2.delivery_status == "timed_out" and r2.delivery_error == "missing_recipient_seq"
        assert counts["missing_event"] == 1
    await engine.dispose()


@pytest.mark.skipif(not _REAL_DB_URL, reason="real Postgres 필요")
@pytest.mark.anyio
async def test_concurrent_invocations_skip_locked_notify_once():
    """⭐SME blocking 회귀: cron 겹침 시 두 invocation 이 같은 stuck row 를 동시 처리하면
    재notify 0/idempotent 가 깨진다. FOR UPDATE SKIP LOCKED 로 잠긴 row 는 건너뛰고 1회만 처리·notify."""
    from app.services.workflow_handoff_watchdog import reconcile_handoffs
    from app.models.workflow_line import WorkflowLineStepRun
    from sqlalchemy import select
    engine, Session = await _session()
    async with Session() as seed:
        org = uuid.uuid4()
        sr, rid = await _seed_run(seed, org, recipient_seq=5)
        await _seed_cursor(seed, rid, acked_seq=3)  # 미ACK → stuck 후보
        await seed.commit()

    # 다른 cron invocation 모사: s_lock 이 같은 row 를 SKIP LOCKED 로 잠그고 트랜잭션 보류.
    async with Session() as s_lock, Session() as s_work:
        held = (await s_lock.execute(
            select(WorkflowLineStepRun).where(WorkflowLineStepRun.id == sr.id).with_for_update(skip_locked=True)
        )).scalar_one_or_none()
        assert held is not None  # s_lock 이 row 잠금 보유
        with patch("app.services.notification_dispatch.dispatch_notification", new=AsyncMock()) as notify:
            counts = await reconcile_handoffs(s_work, now=_NOW)
        assert counts["scanned"] == 0  # ⭐잠긴 row 는 건너뜀(중복 처리 0)
        assert notify.await_count == 0
        await s_lock.rollback()  # 잠금 해제

    # 잠금 해제 후 재실행 → 정확히 1회 처리·notify 1회.
    async with Session() as s2:
        with patch("app.services.notification_dispatch.dispatch_notification", new=AsyncMock()) as notify2:
            counts2 = await reconcile_handoffs(s2, now=_NOW)
        assert counts2["stuck"] == 1 and notify2.await_count == 1
        row = (await s2.execute(select(WorkflowLineStepRun).where(WorkflowLineStepRun.id == sr.id))).scalar_one()
        assert row.delivery_status == "timed_out"
    await engine.dispose()


@pytest.mark.skipif(not _REAL_DB_URL, reason="real Postgres 필요")
@pytest.mark.anyio
async def test_idempotent_and_not_yet_stuck_excluded():
    from app.services.workflow_handoff_watchdog import reconcile_handoffs
    from app.models.workflow_line import WorkflowLineStepRun
    from sqlalchemy import select
    engine, Session = await _session()
    async with Session() as s:
        org = uuid.uuid4()
        # 이미 terminal(acked/timed_out) → 재처리 안 함
        sr_acked, _ = await _seed_run(s, org, delivery_status="acked")
        sr_to, _ = await _seed_run(s, org, delivery_status="timed_out")
        # 아직 10분 안 지남(age 3m) → 제외
        sr_fresh, rid = await _seed_run(s, org, age_min=3)
        await _seed_cursor(s, rid, acked_seq=1)
        with patch("app.services.notification_dispatch.dispatch_notification", new=AsyncMock()) as notify:
            counts = await reconcile_handoffs(s, now=_NOW)
        assert counts["scanned"] == 0  # 셋 다 제외(terminal 2 + fresh 1)
        fresh = (await s.execute(select(WorkflowLineStepRun).where(WorkflowLineStepRun.id == sr_fresh.id))).scalar_one()
        assert fresh.delivery_status == "queued"  # 아직 미처리
        assert notify.await_count == 0
    await engine.dispose()
