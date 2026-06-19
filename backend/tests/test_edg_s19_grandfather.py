"""E-DG S19: in-flight grandfather + advisory backfill 테스트.

핵심: backfill(in-flight story 마킹·backlog/done 제외·Gate 0·idempotent·disabled org skip)·
엔진 consume(grandfather marker→첫 transition 비차단 plain·marker applied·2nd transition 거버닝).
"""
from __future__ import annotations

import os
import uuid
from datetime import datetime, timezone

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


def _set(mp, *, enabled=True, allowlist="", mode="shadow"):
    from app.core.config import settings
    mp.setattr(settings, "decision_gate_line_enabled", enabled)
    mp.setattr(settings, "decision_gate_line_org_allowlist", allowlist)
    mp.setattr(settings, "decision_gate_line_mode", mode)


async def _story(s, org, status):
    from app.models.project import Project
    from app.models.pm import Story
    proj = uuid.uuid4()
    s.add(Project(id=proj, org_id=org, name="p"))
    await s.flush()
    sid = uuid.uuid4()
    s.add(Story(id=sid, org_id=org, project_id=proj, title="t", status=status))
    await s.flush()
    return sid


async def _markers(s, org, entity_id, status):
    from app.models.workflow_line import WorkflowLineStepRun
    from sqlalchemy import select
    return (await s.execute(select(WorkflowLineStepRun).where(
        WorkflowLineStepRun.org_id == org, WorkflowLineStepRun.entity_id == entity_id,
        WorkflowLineStepRun.status == status))).scalars().all()


# ── backfill ────────────────────────────────────────────────────────────────
@pytest.mark.skipif(not _REAL_DB_URL, reason="real Postgres 필요")
@pytest.mark.anyio
async def test_backfill_marks_inflight_only_no_gate(monkeypatch):
    from app.services.workflow_grandfather import backfill_grandfather
    from app.models.gate import Gate
    from sqlalchemy import select, func
    engine, Session = await _session()
    async with Session() as s:
        org = uuid.uuid4()
        _set(monkeypatch, enabled=True, allowlist="", mode="enforcing")  # org active
        inprog = await _story(s, org, "in-progress")
        inrev = await _story(s, org, "in-review")
        await _story(s, org, "backlog")   # 비대상
        await _story(s, org, "done")      # 비대상
        await s.commit()
        c = await backfill_grandfather(s, org, now=_NOW)
        assert c["grandfathered"] == 2 and c["gate_created"] == 0 and c["scanned"] == 2
        assert len(await _markers(s, org, inprog, "grandfathered")) == 1
        assert len(await _markers(s, org, inrev, "grandfathered")) == 1
        # ⭐Gate row 0(read-only·라이브 무영향·AC②)
        gate_n = (await s.execute(select(func.count()).select_from(Gate).where(Gate.org_id == org))).scalar()
        assert gate_n == 0
    await engine.dispose()


@pytest.mark.skipif(not _REAL_DB_URL, reason="real Postgres 필요")
@pytest.mark.anyio
async def test_backfill_idempotent(monkeypatch):
    from app.services.workflow_grandfather import backfill_grandfather
    engine, Session = await _session()
    async with Session() as s:
        org = uuid.uuid4()
        _set(monkeypatch, enabled=True, mode="shadow")
        sid = await _story(s, org, "in-review")
        await s.commit()
        c1 = await backfill_grandfather(s, org, now=_NOW)
        c2 = await backfill_grandfather(s, org, now=_NOW)  # 재실행
        assert c1["grandfathered"] == 1 and c2["grandfathered"] == 0  # idempotent
        assert len(await _markers(s, org, sid, "grandfathered")) == 1  # 중복 0
    await engine.dispose()


@pytest.mark.skipif(not _REAL_DB_URL, reason="real Postgres 필요")
@pytest.mark.anyio
async def test_backfill_skips_disabled_org(monkeypatch):
    from app.services.workflow_grandfather import backfill_grandfather
    engine, Session = await _session()
    async with Session() as s:
        org = uuid.uuid4()
        _set(monkeypatch, enabled=False)  # runtime off → backfill skip(AC⑤)
        await _story(s, org, "in-review")
        await s.commit()
        c = await backfill_grandfather(s, org, now=_NOW)
        assert c.get("skipped_disabled") == 1 and c["grandfathered"] == 0
    await engine.dispose()


# ── 엔진 consume ─────────────────────────────────────────────────────────────
async def _seed_line(s, org, mode, *, from_status, to_status, step_type):
    from app.models.workflow_line import WorkflowLineDefinition, WorkflowLineDefinitionVersion
    defn = WorkflowLineDefinition(org_id=org, project_id=None, entity_type="story", name="L",
                                  is_active=True, version=1)
    s.add(defn)
    await s.flush()
    s.add(WorkflowLineDefinitionVersion(
        line_definition_id=defn.id, org_id=org, project_id=None, entity_type="story", version=1,
        status="published", config_hash="h", created_by_member_id=uuid.uuid4(),
        config={"rollout_mode": mode, "steps": [{
            "from_status": from_status, "to_status": to_status, "step_type": step_type}]}))
    await s.flush()


@pytest.mark.skipif(not _REAL_DB_URL, reason="real Postgres 필요")
@pytest.mark.anyio
async def test_engine_grandfathered_first_transition_not_blocked(monkeypatch):
    from app.services.workflow_line_engine import evaluate_line_for_transition
    from app.services.workflow_grandfather import backfill_grandfather
    engine, Session = await _session()
    async with Session() as s:
        org = uuid.uuid4()
        _set(monkeypatch, enabled=True, allowlist=str(org), mode="enforcing")
        await _seed_line(s, org, "enforcing", from_status="in-progress", to_status="in-review",
                         step_type="agent-handoff")
        sid = await _story(s, org, "in-progress")
        await s.commit()
        await backfill_grandfather(s, org, now=_NOW)  # marker 생성

        # 첫 transition: grandfather 소비 → plain(비차단)
        d1 = await evaluate_line_for_transition(
            s, org_id=org, project_id=None, entity_type="story", entity_id=sid,
            from_status="in-progress", to_status="in-review")
        assert d1.mode == "plain_transition" and d1.proceeds  # board freeze 0
        # marker applied(소비됨)
        assert len(await _markers(s, org, sid, "grandfathered")) == 0
        assert len(await _markers(s, org, sid, "grandfathered_applied")) == 1

        # 2nd transition: marker 없음 → 정상 거버닝(advisory record·grandfather plain 아님)
        d2 = await evaluate_line_for_transition(
            s, org_id=org, project_id=None, entity_type="story", entity_id=sid,
            from_status="in-progress", to_status="in-review")
        assert d2.mode == "advisory_only" and d2.step_run_id is not None  # 거버닝됨
    await engine.dispose()


@pytest.mark.skipif(not _REAL_DB_URL, reason="real Postgres 필요")
@pytest.mark.anyio
async def test_duplicate_markers_consume_closes_all_plain_exactly_once(monkeypatch):
    """⭐SME 회귀: 동시 backfill 로 duplicate open marker 2개여도 첫 transition 이 전부 close →
    plain 정확히 1회(이후 transition 은 거버닝). consume all-open close 검증."""
    from app.services.workflow_line_engine import evaluate_line_for_transition
    from app.models.workflow_line import WorkflowLineStepRun
    engine, Session = await _session()
    async with Session() as s:
        org = uuid.uuid4()
        _set(monkeypatch, enabled=True, allowlist=str(org), mode="enforcing")
        await _seed_line(s, org, "enforcing", from_status="in-progress", to_status="in-review",
                         step_type="agent-handoff")
        sid = await _story(s, org, "in-progress")
        # 동시 cron 모사: duplicate open marker 2개 직접 삽입
        for _ in range(2):
            s.add(WorkflowLineStepRun(
                org_id=org, project_id=uuid.uuid4(), entity_type="story", entity_id=sid,
                from_status="in-progress", to_status="in-progress", status="grandfathered",
                mode="advisory_only", correlation_id=uuid.uuid4(), transition_id=uuid.uuid4().hex))
        await s.commit()

        d1 = await evaluate_line_for_transition(
            s, org_id=org, project_id=None, entity_type="story", entity_id=sid,
            from_status="in-progress", to_status="in-review")
        assert d1.mode == "plain_transition"  # 첫 transition grandfather(비차단)
        assert len(await _markers(s, org, sid, "grandfathered")) == 0  # ⭐둘 다 closed
        assert len(await _markers(s, org, sid, "grandfathered_applied")) == 2
        # 2nd transition: open marker 0 → grandfather plain 아님·정상 거버닝
        d2 = await evaluate_line_for_transition(
            s, org_id=org, project_id=None, entity_type="story", entity_id=sid,
            from_status="in-progress", to_status="in-review")
        assert d2.mode == "advisory_only" and d2.step_run_id is not None
    await engine.dispose()
