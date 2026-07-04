"""E-DG S12 BE: recipient_agent 노출(Gap1) + fallback-notify(Gap2) 테스트.

Gap1: 단건/배치 status 에 recipient_agent(event recipient 기반·member 없으면 id-only).
Gap2: fallback_notify(project human 통지 + marker)·idempotent(already_notified)·not_found·status rollback 0.
"""
from __future__ import annotations

import os
import uuid
from unittest.mock import AsyncMock, patch

import pytest

_REAL_DB_URL = os.getenv("PARITY_TEST_DATABASE_URL") or os.getenv("ALEMBIC_DATABASE_URL")

# story 8236bbc3: create_all(+drop_all)로 자체 스키마를 직접 다룸 — 공유 alembic-migrated
# DB 오염 방지 위해 격리 DB 전용(conftest.py 가드가 마커 누락을 자동 검출).
pytestmark = pytest.mark.destructive_schema
_NOTIFY = "app.services.notification_dispatch.dispatch_notification"


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


async def _member(s, org, proj, *, mtype="agent", name="rcpt", is_active=True):
    from app.models.team import TeamMember
    mid = uuid.uuid4()
    s.add(TeamMember(id=mid, org_id=org, project_id=proj, type=mtype, name=name, is_active=is_active))
    await s.flush()
    return mid


async def _run_with_event(s, org, proj, *, recipient_id=None, with_member=True, status="dispatched"):
    from app.models.event import Event
    from app.models.workflow_line import WorkflowLineStepRun
    if recipient_id is None:
        recipient_id = (await _member(s, org, proj, mtype="agent", name="에이전트A")) if with_member else uuid.uuid4()
    ev = Event(org_id=org, project_id=proj, event_type="dispatched", source_entity_type="story",
               source_entity_id=uuid.uuid4(), recipient_id=recipient_id, recipient_type="agent",
               payload={}, status="pending", recipient_seq=7)
    s.add(ev)
    await s.flush()
    story_id = uuid.uuid4()
    sr = WorkflowLineStepRun(
        org_id=org, project_id=proj, entity_type="story", entity_id=story_id,
        from_status="in-review", to_status="done", status=status, mode="advisory_only",
        delivery_status="timed_out", event_id=ev.id, recipient_seq=7,
        correlation_id=uuid.uuid4(), transition_id=uuid.uuid4().hex)
    s.add(sr)
    await s.flush()
    return sr, story_id, recipient_id


async def _project(s, org):
    from app.models.project import Project
    proj = uuid.uuid4()
    s.add(Project(id=proj, org_id=org, name="p"))
    await s.flush()
    return proj


# ── Gap1: recipient_agent ────────────────────────────────────────────────────
@pytest.mark.skipif(not _REAL_DB_URL, reason="real Postgres 필요")
@pytest.mark.anyio
async def test_single_status_exposes_recipient_agent():
    from app.services.workflow_line_status import build_workflow_line_status
    engine, Session = await _session()
    async with Session() as s:
        org = uuid.uuid4()
        proj = await _project(s, org)
        sr, story_id, rid = await _run_with_event(s, org, proj, status="dispatched")
        res = await build_workflow_line_status(s, org, story_id)
        assert res.active is not None and res.active.recipient_agent is not None
        assert res.active.recipient_agent.id == rid
        assert res.active.recipient_agent.name == "에이전트A" and res.active.recipient_agent.type == "agent"
    await engine.dispose()


@pytest.mark.skipif(not _REAL_DB_URL, reason="real Postgres 필요")
@pytest.mark.anyio
async def test_recipient_agent_id_only_when_member_missing():
    # events.recipient_id 는 team_members FK 라 'member 없는 recipient' 는 단위로 검증한다
    # (_resolve_recipient_agent 가 session.get None → id-only 반환·FE '에이전트' 폴백).
    from app.services.workflow_line_status import _resolve_recipient_agent
    engine, Session = await _session()
    async with Session() as s:
        orphan = uuid.uuid4()
        ra = await _resolve_recipient_agent(s, orphan)
        assert ra is not None and ra.id == orphan and ra.name is None  # id-only(FE '에이전트' 폴백)
        assert await _resolve_recipient_agent(s, None) is None
    await engine.dispose()


@pytest.mark.skipif(not _REAL_DB_URL, reason="real Postgres 필요")
@pytest.mark.anyio
async def test_batch_status_exposes_recipient_agent_no_nplus1():
    from app.services.workflow_line_status import build_workflow_line_status_batch
    engine, Session = await _session()
    async with Session() as s:
        org = uuid.uuid4()
        proj = await _project(s, org)
        sr, story_id, rid = await _run_with_event(s, org, proj, status="dispatched")
        res = await build_workflow_line_status_batch(s, org, [story_id])
        assert len(res) == 1 and res[0].has_active
        assert res[0].recipient_agent is not None and res[0].recipient_agent.id == rid
        assert res[0].recipient_agent.name == "에이전트A" and res[0].handoff_stuck is True
    await engine.dispose()


# ── Gap2: fallback-notify ─────────────────────────────────────────────────────
@pytest.mark.skipif(not _REAL_DB_URL, reason="real Postgres 필요")
@pytest.mark.anyio
async def test_fallback_notify_notifies_humans_and_idempotent():
    from app.services.workflow_fallback_notify import fallback_notify
    from app.models.workflow_line import WorkflowLineStepRunEvent
    from sqlalchemy import select, func
    engine, Session = await _session()
    async with Session() as s:
        org = uuid.uuid4()
        proj = await _project(s, org)
        sr, story_id, _ = await _run_with_event(s, org, proj)
        await _member(s, org, proj, mtype="human", name="owner")   # human owner
        await _member(s, org, proj, mtype="agent", name="bot")     # agent(제외)
        await s.commit()
        with patch(_NOTIFY, new=AsyncMock()) as notify:
            r1 = await fallback_notify(s, org, story_id, sr.id)
        assert r1["status"] == "notified" and r1["target_count"] == 1  # human 1명만
        assert notify.await_count == 1
        # idempotent: 2nd 호출 → already_notified·재통지 0·marker 1개
        with patch(_NOTIFY, new=AsyncMock()) as notify2:
            r2 = await fallback_notify(s, org, story_id, sr.id)
        assert r2["status"] == "already_notified" and notify2.await_count == 0
        n = (await s.execute(select(func.count()).select_from(WorkflowLineStepRunEvent).where(
            WorkflowLineStepRunEvent.step_run_id == sr.id,
            WorkflowLineStepRunEvent.event_type == "fallback_notified"))).scalar()
        assert n == 1  # marker 정확히 1개
    await engine.dispose()


@pytest.mark.skipif(not _REAL_DB_URL, reason="real Postgres 필요")
@pytest.mark.anyio
async def test_fallback_notify_not_found_and_no_status_rollback():
    from app.services.workflow_fallback_notify import fallback_notify
    from app.models.workflow_line import WorkflowLineStepRun
    from sqlalchemy import select
    engine, Session = await _session()
    async with Session() as s:
        org = uuid.uuid4()
        proj = await _project(s, org)
        sr, story_id, _ = await _run_with_event(s, org, proj, status="dispatched")
        await s.commit()
        # not_found: 엉뚱한 step_run_id
        r = await fallback_notify(s, org, story_id, uuid.uuid4())
        assert r["status"] == "not_found"
        # ⭐status rollback 0: 통지해도 step_run.status 불변
        with patch(_NOTIFY, new=AsyncMock()):
            await fallback_notify(s, org, story_id, sr.id)
        row = (await s.execute(select(WorkflowLineStepRun).where(WorkflowLineStepRun.id == sr.id))).scalar_one()
        assert row.status == "dispatched"  # 미변경(rollback/전이 없음)
    await engine.dispose()
