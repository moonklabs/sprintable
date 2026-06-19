"""E-DG S13: SLA processor for human-gate 테스트.

핵심: reminder(step_run_events.reminded+notify·idempotent·cap)·timeout keep_pending 기본·
escalation(escalated_to_member_id)·auto_approve(허용 시 resolver_id=None / high-risk·sp>=8·
trust-unresolved 금지).
"""
from __future__ import annotations

import os
import uuid
from datetime import datetime, timedelta, timezone
from unittest.mock import AsyncMock, patch

import pytest

_REAL_DB_URL = os.getenv("PARITY_TEST_DATABASE_URL") or os.getenv("ALEMBIC_DATABASE_URL")
_NOW = datetime(2026, 6, 19, 12, 0, 0, tzinfo=timezone.utc)
_NOTIFY = "app.services.notification_dispatch.dispatch_notification"


@pytest.fixture
def anyio_backend():
    return "asyncio"


async def _session():
    from sqlalchemy.ext.asyncio import async_sessionmaker, create_async_engine
    from app.core.database import Base
    import app.models  # noqa: F401
    import app.models.workflow_line  # noqa: F401
    import app.models.participation  # noqa: F401 — gate_resolver FK 등록
    import app.models.gate  # noqa: F401
    url = _REAL_DB_URL
    for prefix in ("postgresql+psycopg2://", "postgresql+asyncpg://", "postgresql://"):
        if url.startswith(prefix):
            url = "postgresql+asyncpg://" + url[len(prefix):]
            break
    import sqlalchemy as sa
    engine = create_async_engine(url)
    async with engine.begin() as conn:
        await conn.run_sync(Base.metadata.create_all)
        # process_sla 는 cron 시맨틱상 org 필터 없이 전 org 스캔 → 공유 DB 의 이전 테스트 row 가
        # 카운트를 오염시킨다. 테스트 격리: 워크플로/게이트 테이블을 매 셋업서 비운다.
        await conn.execute(sa.text(
            "TRUNCATE workflow_line_step_runs, workflow_step_run_events, workflow_step_approvals, "
            "gate, workflow_line_definitions, workflow_line_definition_versions CASCADE"))
    return engine, async_sessionmaker(engine, expire_on_commit=False)


async def _seed_line(s, org, sla_policy, *, from_status="in-review", to_status="done"):
    from app.models.workflow_line import WorkflowLineDefinition, WorkflowLineDefinitionVersion
    defn = WorkflowLineDefinition(org_id=org, project_id=None, entity_type="story", name="L",
                                  is_active=True, version=1)
    s.add(defn)
    await s.flush()
    s.add(WorkflowLineDefinitionVersion(
        line_definition_id=defn.id, org_id=org, project_id=None, entity_type="story", version=1,
        status="published", config_hash="h", created_by_member_id=uuid.uuid4(),
        config={"steps": [{"from_status": from_status, "to_status": to_status,
                           "step_type": "human-gate", "sla_policy": sla_policy}]}))
    await s.flush()
    return defn.id


async def _seed_run(s, org, defn_id, *, age_h, status="gate_pending", from_status="in-review",
                    to_status="done", entity_id=None, **kw):
    from app.models.workflow_line import WorkflowLineStepRun
    sr = WorkflowLineStepRun(
        org_id=org, project_id=uuid.uuid4(), line_definition_id=defn_id, entity_type="story",
        entity_id=entity_id or uuid.uuid4(), from_status=from_status, to_status=to_status,
        status=status, mode="gate_pending", correlation_id=uuid.uuid4(), transition_id=uuid.uuid4().hex,
        started_at=_NOW - timedelta(hours=age_h), **kw)
    s.add(sr)
    await s.flush()
    return sr


@pytest.mark.skipif(not _REAL_DB_URL, reason="real Postgres 필요")
@pytest.mark.anyio
async def test_reminder_fires_records_event_and_idempotent():
    from app.services.workflow_sla_processor import process_sla
    from app.models.workflow_line import WorkflowLineStepRun, WorkflowLineStepRunEvent
    from sqlalchemy import select
    engine, Session = await _session()
    async with Session() as s:
        org = uuid.uuid4()
        defn = await _seed_line(s, org, {"timeout_hours": 24, "reminder_after_hours": 2,
                                         "reminder_every_hours": 2, "max_reminders": 3})
        sr = await _seed_run(s, org, defn, age_h=3, resolved_member_id=uuid.uuid4())
        with patch(_NOTIFY, new=AsyncMock()) as notify:
            c1 = await process_sla(s, now=_NOW)
        assert c1["reminded"] == 1 and notify.await_count == 1
        row = (await s.execute(select(WorkflowLineStepRun).where(WorkflowLineStepRun.id == sr.id))).scalar_one()
        assert row.reminder_count == 1 and row.status == "reminded" and row.next_reminder_at is not None
        evs = (await s.execute(select(WorkflowLineStepRunEvent).where(
            WorkflowLineStepRunEvent.step_run_id == sr.id,
            WorkflowLineStepRunEvent.event_type == "reminded"))).scalars().all()
        assert len(evs) == 1
        # 같은 now 재실행 → next_reminder_at 미도래 → 재reminder 0(idempotent)
        with patch(_NOTIFY, new=AsyncMock()) as notify2:
            c2 = await process_sla(s, now=_NOW)
        assert c2["reminded"] == 0 and notify2.await_count == 0
    await engine.dispose()


@pytest.mark.skipif(not _REAL_DB_URL, reason="real Postgres 필요")
@pytest.mark.anyio
async def test_reminder_cap_respected():
    from app.services.workflow_sla_processor import process_sla
    engine, Session = await _session()
    async with Session() as s:
        org = uuid.uuid4()
        defn = await _seed_line(s, org, {"timeout_hours": 24, "reminder_after_hours": 2,
                                         "reminder_every_hours": 2, "max_reminders": 1})
        await _seed_run(s, org, defn, age_h=10, reminder_count=1)  # 이미 cap 도달
        with patch(_NOTIFY, new=AsyncMock()) as notify:
            c = await process_sla(s, now=_NOW)
        assert c["reminded"] == 0 and notify.await_count == 0
    await engine.dispose()


@pytest.mark.skipif(not _REAL_DB_URL, reason="real Postgres 필요")
@pytest.mark.anyio
async def test_timeout_keep_pending_default_no_transition():
    from app.services.workflow_sla_processor import process_sla
    from app.models.workflow_line import WorkflowLineStepRun
    from sqlalchemy import select
    engine, Session = await _session()
    async with Session() as s:
        org = uuid.uuid4()
        defn = await _seed_line(s, org, {"timeout_hours": 4})  # on_timeout 미지정 → keep_pending
        sr = await _seed_run(s, org, defn, age_h=10)
        with patch(_NOTIFY, new=AsyncMock()):
            c = await process_sla(s, now=_NOW)
        assert c["kept_pending"] == 1 and c["auto_approved"] == 0
        row = (await s.execute(select(WorkflowLineStepRun).where(WorkflowLineStepRun.id == sr.id))).scalar_one()
        assert row.status == "gate_pending"  # 전이 없음(보수적)
    await engine.dispose()


@pytest.mark.skipif(not _REAL_DB_URL, reason="real Postgres 필요")
@pytest.mark.anyio
async def test_timeout_escalates_and_idempotent():
    from app.services.workflow_sla_processor import process_sla
    from app.models.workflow_line import WorkflowLineStepRun
    from sqlalchemy import select
    engine, Session = await _session()
    async with Session() as s:
        org, deputy = uuid.uuid4(), uuid.uuid4()
        defn = await _seed_line(s, org, {"timeout_hours": 4, "escalate_to": str(deputy)})
        sr = await _seed_run(s, org, defn, age_h=10)
        with patch(_NOTIFY, new=AsyncMock()) as notify:
            c = await process_sla(s, now=_NOW)
        assert c["escalated"] == 1 and notify.await_count == 1
        row = (await s.execute(select(WorkflowLineStepRun).where(WorkflowLineStepRun.id == sr.id))).scalar_one()
        assert row.escalated_to_member_id == deputy and row.status == "escalated"
        # 재실행 → 이미 escalated_to 세팅 → 재escalate 0(idempotent)
        with patch(_NOTIFY, new=AsyncMock()):
            c2 = await process_sla(s, now=_NOW)
        assert c2["escalated"] == 0 and c2["kept_pending"] == 1
    await engine.dispose()


@pytest.mark.skipif(not _REAL_DB_URL, reason="real Postgres 필요")
@pytest.mark.anyio
async def test_timeout_auto_approve_when_allowed_resolver_none():
    from app.services.workflow_sla_processor import process_sla
    from app.models.gate import Gate
    from app.models.project import Project
    from app.models.pm import Story
    from sqlalchemy import select
    engine, Session = await _session()
    async with Session() as s:
        org, story_id = uuid.uuid4(), uuid.uuid4()
        proj = uuid.uuid4()
        s.add(Project(id=proj, org_id=org, name="p"))
        await s.flush()  # Project 선확정(Story FK 순서 보장)
        s.add(Story(id=story_id, org_id=org, project_id=proj, title="t", status="in-review",
                    story_points=3))
        gate = Gate(id=uuid.uuid4(), org_id=org, work_item_id=story_id, work_item_type="story",
                    gate_type="merge", status="pending")
        s.add(gate)
        await s.flush()
        defn = await _seed_line(s, org, {"timeout_hours": 4, "on_timeout": "auto_approve"})
        await _seed_run(s, org, defn, age_h=10, entity_id=story_id, gate_id=gate.id,
                        risk_snapshot={}, trust_snapshot={})
        with patch(_NOTIFY, new=AsyncMock()):
            c = await process_sla(s, now=_NOW)
        assert c["auto_approved"] == 1
        g = (await s.execute(select(Gate).where(Gate.id == gate.id))).scalar_one()
        assert g.status == "approved" and g.resolver_id is None  # ⭐system transition·trust 환류 차단
    await engine.dispose()


@pytest.mark.skipif(not _REAL_DB_URL, reason="real Postgres 필요")
@pytest.mark.anyio
async def test_auto_approve_forbidden_high_risk_falls_back():
    from app.services.workflow_sla_processor import process_sla
    from app.models.gate import Gate
    from sqlalchemy import select
    engine, Session = await _session()
    async with Session() as s:
        org, story_id = uuid.uuid4(), uuid.uuid4()
        gate = Gate(id=uuid.uuid4(), org_id=org, work_item_id=story_id, work_item_type="story",
                    gate_type="merge", status="pending")
        s.add(gate)
        await s.flush()
        defn = await _seed_line(s, org, {"timeout_hours": 4, "on_timeout": "auto_approve"})
        # ⭐prod_touch high-risk → auto_approve 금지 → keep_pending fallback
        await _seed_run(s, org, defn, age_h=10, entity_id=story_id, gate_id=gate.id,
                        risk_snapshot={"prod_touch": True}, trust_snapshot={})
        with patch(_NOTIFY, new=AsyncMock()):
            c = await process_sla(s, now=_NOW)
        assert c["auto_approved"] == 0 and c["kept_pending"] == 1
        g = (await s.execute(select(Gate).where(Gate.id == gate.id))).scalar_one()
        assert g.status == "pending"  # 자동승인 안 됨(금지조건)
    await engine.dispose()
