"""E-DG S14: deputy/availability/SoD role resolver 테스트.

핵심: active/effective-period/availability 필터·OOO+deputy 대체(original 보존)·inactive 제외·
human-gate agent 불허·SoD self-approval fallback·후보 없음→unresolved_assignee·priority/project 우선.
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
    url = _REAL_DB_URL
    for prefix in ("postgresql+psycopg2://", "postgresql+asyncpg://", "postgresql://"):
        if url.startswith(prefix):
            url = "postgresql+asyncpg://" + url[len(prefix):]
            break
    engine = create_async_engine(url)
    async with engine.begin() as conn:
        await conn.run_sync(Base.metadata.create_all)
    return engine, async_sessionmaker(engine, expire_on_commit=False)


async def _member(s, org, *, is_active=True, mtype="human", proj=None):
    from app.models.project import Project
    from app.models.team import TeamMember
    mid = uuid.uuid4()
    proj = proj or uuid.uuid4()
    s.add(Project(id=proj, org_id=org, name="p"))
    await s.flush()
    s.add(TeamMember(id=mid, org_id=org, project_id=proj, type=mtype, name="m", is_active=is_active))
    await s.flush()
    return mid


async def _assign(s, org, role_key, member_id, mtype="human", **kw):
    from app.models.workflow_line import WorkflowRoleAssignment
    a = WorkflowRoleAssignment(org_id=org, role_key=role_key, member_id=member_id,
                               member_type=mtype, **kw)
    s.add(a)
    await s.flush()
    return a


async def _seed_sla_run(s, org, sla_policy, *, age_h, from_status="in-review", to_status="done"):
    """S13 SLA escalation × S14 resolver 통합용: published line + timed-out gate step_run."""
    from app.models.workflow_line import (
        WorkflowLineDefinition, WorkflowLineDefinitionVersion, WorkflowLineStepRun)
    defn = WorkflowLineDefinition(org_id=org, project_id=None, entity_type="story", name="L",
                                  is_active=True, version=1)
    s.add(defn)
    await s.flush()
    s.add(WorkflowLineDefinitionVersion(
        line_definition_id=defn.id, org_id=org, project_id=None, entity_type="story", version=1,
        status="published", config_hash="h", created_by_member_id=uuid.uuid4(),
        config={"steps": [{"from_status": from_status, "to_status": to_status,
                           "step_type": "human-gate", "sla_policy": sla_policy}]}))
    sr = WorkflowLineStepRun(
        org_id=org, project_id=uuid.uuid4(), line_definition_id=defn.id, entity_type="story",
        entity_id=uuid.uuid4(), from_status=from_status, to_status=to_status, status="gate_pending",
        mode="gate_pending", correlation_id=uuid.uuid4(), transition_id=uuid.uuid4().hex,
        started_at=_NOW - timedelta(hours=age_h))
    s.add(sr)
    await s.flush()
    return sr


@pytest.mark.skipif(not _REAL_DB_URL, reason="real Postgres 필요")
@pytest.mark.anyio
async def test_basic_active_available_resolves():
    from app.services.workflow_role_resolver import resolve_role_candidate
    engine, Session = await _session()
    async with Session() as s:
        org = uuid.uuid4()
        m = await _member(s, org)
        await _assign(s, org, "reviewer", m)
        cand = await resolve_role_candidate(s, org, "reviewer", now=_NOW)
        assert cand is not None and cand.member_id == m and not cand.via_deputy
    await engine.dispose()


@pytest.mark.skipif(not _REAL_DB_URL, reason="real Postgres 필요")
@pytest.mark.anyio
async def test_effective_period_filters_out():
    from app.services.workflow_role_resolver import resolve_role_candidate
    engine, Session = await _session()
    async with Session() as s:
        org = uuid.uuid4()
        m = await _member(s, org)
        await _assign(s, org, "reviewer", m, effective_from=_NOW + timedelta(days=1))  # 미래
        assert await resolve_role_candidate(s, org, "reviewer", now=_NOW) is None
        m2 = await _member(s, org)
        await _assign(s, org, "rev2", m2, effective_to=_NOW - timedelta(days=1))  # 만료
        assert await resolve_role_candidate(s, org, "rev2", now=_NOW) is None
    await engine.dispose()


@pytest.mark.skipif(not _REAL_DB_URL, reason="real Postgres 필요")
@pytest.mark.anyio
async def test_ooo_with_deputy_substitutes_and_preserves_original():
    from app.services.workflow_role_resolver import resolve_role_candidate
    engine, Session = await _session()
    async with Session() as s:
        org = uuid.uuid4()
        owner = await _member(s, org)
        deputy = await _member(s, org)
        await _assign(s, org, "reviewer", owner, availability_status="ooo",
                      deputy_member_id=deputy, deputy_member_type="human",
                      delegation_policy={"deputy_allowed": True})
        cand = await resolve_role_candidate(s, org, "reviewer", now=_NOW)
        assert cand.member_id == deputy and cand.via_deputy is True
        assert cand.original_approver_member_id == owner  # ② 원 approver 보존
    await engine.dispose()


@pytest.mark.skipif(not _REAL_DB_URL, reason="real Postgres 필요")
@pytest.mark.anyio
async def test_ooo_without_deputy_excluded():
    from app.services.workflow_role_resolver import resolve_role_candidate
    engine, Session = await _session()
    async with Session() as s:
        org = uuid.uuid4()
        owner = await _member(s, org)
        await _assign(s, org, "reviewer", owner, availability_status="ooo",
                      delegation_policy={"deputy_allowed": False})
        assert await resolve_role_candidate(s, org, "reviewer", now=_NOW) is None
    await engine.dispose()


@pytest.mark.skipif(not _REAL_DB_URL, reason="real Postgres 필요")
@pytest.mark.anyio
async def test_inactive_member_excluded():
    from app.services.workflow_role_resolver import resolve_role_candidate
    engine, Session = await _session()
    async with Session() as s:
        org = uuid.uuid4()
        m = await _member(s, org, is_active=False)  # terminated/inactive
        await _assign(s, org, "reviewer", m)
        assert await resolve_role_candidate(s, org, "reviewer", now=_NOW) is None
    await engine.dispose()


@pytest.mark.skipif(not _REAL_DB_URL, reason="real Postgres 필요")
@pytest.mark.anyio
async def test_agent_approver_blocked_for_human_gate():
    from app.services.workflow_role_resolver import resolve_role_candidate
    engine, Session = await _session()
    async with Session() as s:
        org = uuid.uuid4()
        agent = await _member(s, org, mtype="agent")
        await _assign(s, org, "reviewer", agent, mtype="agent")
        assert await resolve_role_candidate(s, org, "reviewer", prefer_human=True, now=_NOW) is None
        # prefer_human=False 면 허용
        c = await resolve_role_candidate(s, org, "reviewer", prefer_human=False, now=_NOW)
        assert c is not None and c.member_id == agent
    await engine.dispose()


@pytest.mark.skipif(not _REAL_DB_URL, reason="real Postgres 필요")
@pytest.mark.anyio
async def test_sod_self_approval_falls_back_to_next():
    from app.services.workflow_role_resolver import resolve_role_candidate
    engine, Session = await _session()
    async with Session() as s:
        org = uuid.uuid4()
        author = await _member(s, org)
        other = await _member(s, org)
        await _assign(s, org, "reviewer", author, priority=10)   # 1순위지만 SoD 제외
        await _assign(s, org, "reviewer", other, priority=20)    # fallback
        cand = await resolve_role_candidate(s, org, "reviewer", sod_exclude={author}, now=_NOW)
        assert cand is not None and cand.member_id == other  # ⑤ self-approval fallback
        # author 만 있으면 후보 없음
        cand2 = await resolve_role_candidate(s, org, "rev_solo", sod_exclude={author}, now=_NOW)
        assert cand2 is None
    await engine.dispose()


@pytest.mark.skipif(not _REAL_DB_URL, reason="real Postgres 필요")
@pytest.mark.anyio
async def test_priority_order_and_unresolved_marks_step_run():
    from app.services.workflow_role_resolver import resolve_role_candidate, resolve_or_mark_unresolved
    from app.models.workflow_line import WorkflowLineStepRun
    engine, Session = await _session()
    async with Session() as s:
        org = uuid.uuid4()
        lo = await _member(s, org)
        hi = await _member(s, org)
        await _assign(s, org, "reviewer", hi, priority=50)
        await _assign(s, org, "reviewer", lo, priority=5)  # 더 낮은 숫자=우선
        cand = await resolve_role_candidate(s, org, "reviewer", now=_NOW)
        assert cand.member_id == lo  # priority 5 우선
        # 후보 없는 role → resolve_or_mark_unresolved 가 step_run 가시화(⑥)
        sr = WorkflowLineStepRun(
            org_id=org, project_id=uuid.uuid4(), entity_type="story", entity_id=uuid.uuid4(),
            from_status="in-review", to_status="done", status="gate_pending", mode="gate_pending",
            correlation_id=uuid.uuid4(), transition_id=uuid.uuid4().hex)
        s.add(sr)
        await s.flush()
        out = await resolve_or_mark_unresolved(s, sr, "no_such_role", now=_NOW)
        assert out is None and sr.delivery_status == "unresolved_assignee"
    await engine.dispose()


# ── S13 SLA escalation × S14 resolver 통합(fold-in) ──────────────────────────
@pytest.mark.skipif(not _REAL_DB_URL, reason="real Postgres 필요")
@pytest.mark.anyio
async def test_s13_escalation_resolves_role_key_via_s14_resolver():
    """⭐fold-in: S13 SLA escalate_to=role_key → S14 resolver 로 해소(silent keep_pending 금지)."""
    import sqlalchemy as sa
    from app.services.workflow_sla_processor import process_sla
    from app.models.workflow_line import WorkflowLineStepRun
    from sqlalchemy import select
    engine, Session = await _session()
    async with Session() as s:
        await s.execute(sa.text("TRUNCATE workflow_line_step_runs CASCADE"))  # process_sla 전역 스캔 격리
        org = uuid.uuid4()
        deputy = await _member(s, org)
        await _assign(s, org, "manager", deputy)  # role_key='manager' → deputy
        sr = await _seed_sla_run(s, org, {"timeout_hours": 4, "escalate_to": "manager"}, age_h=10)
        c = await process_sla(s, now=_NOW)
        assert c["escalated"] == 1 and c["unresolved"] == 0
        row = (await s.execute(select(WorkflowLineStepRun).where(WorkflowLineStepRun.id == sr.id))).scalar_one()
        assert row.escalated_to_member_id == deputy and row.status == "escalated"
    await engine.dispose()


@pytest.mark.skipif(not _REAL_DB_URL, reason="real Postgres 필요")
@pytest.mark.anyio
async def test_s13_escalation_unresolved_role_visible_not_silent():
    """⭐fold-in: role_key 후보 없으면 silent keep_pending 금지 → unresolved_assignee 가시화."""
    import sqlalchemy as sa
    from app.services.workflow_sla_processor import process_sla
    from app.models.workflow_line import WorkflowLineStepRun
    from sqlalchemy import select
    engine, Session = await _session()
    async with Session() as s:
        await s.execute(sa.text("TRUNCATE workflow_line_step_runs CASCADE"))
        org = uuid.uuid4()
        sr = await _seed_sla_run(s, org, {"timeout_hours": 4, "escalate_to": "no_role"}, age_h=10)
        c = await process_sla(s, now=_NOW)
        assert c["unresolved"] == 1 and c["escalated"] == 0 and c["kept_pending"] == 0
        row = (await s.execute(select(WorkflowLineStepRun).where(WorkflowLineStepRun.id == sr.id))).scalar_one()
        assert row.delivery_status == "unresolved_assignee"  # silent prison 아님

        # ⭐멱등(산티아고 SME): cron 재실행해도 escalated(unresolved) event 중복 기록 안 함.
        from app.models.workflow_line import WorkflowLineStepRunEvent
        c2 = await process_sla(s, now=_NOW)
        assert c2["unresolved"] == 0 and c2["kept_pending"] == 1  # 재기록 skip
        evs = (await s.execute(select(WorkflowLineStepRunEvent).where(
            WorkflowLineStepRunEvent.step_run_id == sr.id,
            WorkflowLineStepRunEvent.event_type == "escalated"))).scalars().all()
        assert len(evs) == 1  # append-only event 1개만(중복 0)
    await engine.dispose()
