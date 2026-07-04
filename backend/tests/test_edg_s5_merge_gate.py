"""E-DG S5: H1 merge-gate wrapper unification (P0-2) 테스트.

핵심: enforcing 라인 merge-gate step → evaluate_merge_gate 정확히 1회 + AUTO_MERGE/ASK_HUMAN/BLOCK
매핑(ASK_HUMAN은 H1 gate_id 대표·별도 Gate 미생성) + line_merge_gate_active(라우터 skip 판정) +
S3 fail-open 보존(merge-gate 평가 예외도 plain degrade).
"""
from __future__ import annotations

import os
import uuid
from unittest.mock import patch

import pytest

_REAL_DB_URL = os.getenv("PARITY_TEST_DATABASE_URL") or os.getenv("ALEMBIC_DATABASE_URL")

# story 8236bbc3: create_all(+drop_all)로 자체 스키마를 직접 다룸 — 공유 alembic-migrated
# DB 오염 방지 위해 격리 DB 전용(conftest.py 가드가 마커 누락을 자동 검출).
pytestmark = pytest.mark.destructive_schema


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


async def _seed_line(s, org, mode, *, step_type="merge-gate", from_status="in-review", to_status="done"):
    from app.models.workflow_line import WorkflowLineDefinition, WorkflowLineDefinitionVersion
    defn = WorkflowLineDefinition(org_id=org, project_id=None, entity_type="story",
                                  name="L", is_active=True, version=1)
    s.add(defn); await s.flush()
    s.add(WorkflowLineDefinitionVersion(
        line_definition_id=defn.id, org_id=org, project_id=None, entity_type="story",
        version=1, status="published", config_hash="h", created_by_member_id=uuid.uuid4(),
        config={"rollout_mode": mode,
                "steps": [{"from_status": from_status, "to_status": to_status, "step_type": step_type}]}))
    await s.flush()


def _decision(decision, gate_id):
    from app.services.merge_verdict_gate import MergeGateDecision
    return MergeGateDecision(
        decision=decision, reason="test", gate_id=gate_id, gate_status="pending",
        disposition="ask", trust=None, ci_result=None,
    )


# ── line_merge_gate_active (라우터 skip 판정) ─────────────────────────────────
@pytest.mark.skipif(not _REAL_DB_URL, reason="real Postgres 필요")
@pytest.mark.anyio
async def test_line_merge_gate_active_only_for_enforcing_merge_gate(monkeypatch):
    from app.core.config import settings
    monkeypatch.setattr(settings, "decision_gate_line_enabled", True)
    monkeypatch.setattr(settings, "decision_gate_line_mode", "enforcing")
    from app.services.workflow_line_engine import line_merge_gate_active
    engine, Session = await _session()
    kw = dict(entity_type="story", from_status="in-review", to_status="done")
    async with Session() as s:
        org_off, org_shadow, org_enf, org_enf_nonmerge, org_none = (uuid.uuid4() for _ in range(5))
        await _seed_line(s, org_off, "off")
        await _seed_line(s, org_shadow, "shadow")
        await _seed_line(s, org_enf, "enforcing")
        await _seed_line(s, org_enf_nonmerge, "enforcing", step_type="agent-handoff")
        assert await line_merge_gate_active(s, org_id=org_enf, project_id=None, **kw) is True
        assert await line_merge_gate_active(s, org_id=org_off, project_id=None, **kw) is False
        assert await line_merge_gate_active(s, org_id=org_shadow, project_id=None, **kw) is False
        assert await line_merge_gate_active(s, org_id=org_enf_nonmerge, project_id=None, **kw) is False
        assert await line_merge_gate_active(s, org_id=org_none, project_id=None, **kw) is False
        # 다른 전이(in-review→done 아님)는 False
        assert await line_merge_gate_active(
            s, org_id=org_enf, project_id=None, entity_type="story",
            from_status="backlog", to_status="ready-for-dev") is False
    await engine.dispose()


# ── wrapper decision 매핑 (evaluate_merge_gate patch로 결정 격리) ─────────────
@pytest.mark.skipif(not _REAL_DB_URL, reason="real Postgres 필요")
@pytest.mark.anyio
async def test_merge_gate_wrapper_ask_human_uses_h1_gate_no_double(monkeypatch):
    from app.core.config import settings
    monkeypatch.setattr(settings, "decision_gate_line_enabled", True)
    monkeypatch.setattr(settings, "decision_gate_line_mode", "enforcing")
    from sqlalchemy import func, select
    from app.services import workflow_line_engine as eng
    from app.services.merge_verdict_gate import ASK_HUMAN
    from app.models.workflow_line import WorkflowLineStepRun
    from app.models.gate import Gate
    engine, Session = await _session()
    async with Session() as s:
        org, eid = uuid.uuid4(), uuid.uuid4()
        await _seed_line(s, org, "enforcing")
        h1_gate = uuid.uuid4()
        with patch("app.services.merge_verdict_gate.evaluate_merge_gate",
                   return_value=_decision(ASK_HUMAN, h1_gate)) as m:
            d = await eng.evaluate_line_for_transition(
                s, org_id=org, project_id=None, entity_type="story", entity_id=eid,
                from_status="in-review", to_status="done", actor_id=uuid.uuid4())
        assert m.call_count == 1  # ⭐evaluate_merge_gate 정확히 1회(AC②)
        assert d.mode == "gate_pending" and not d.proceeds
        assert d.gate_id == h1_gate and d.http_status == 409  # ⭐H1 gate id 대표
        sr = (await s.execute(select(WorkflowLineStepRun).where(
            WorkflowLineStepRun.entity_id == eid))).scalar_one()
        assert sr.effective_gate_type == "merge" and sr.effective_step_type == "merge-gate"
        assert sr.h1_gate_id == h1_gate and sr.gate_id == h1_gate
        # ⭐wrapper 자체는 Gate 를 안 만든다(evaluate_merge_gate patch라 0)·이중 Gate 방지
        assert (await s.execute(select(func.count()).select_from(Gate))).scalar() == 0
    await engine.dispose()


@pytest.mark.skipif(not _REAL_DB_URL, reason="real Postgres 필요")
@pytest.mark.anyio
async def test_merge_gate_wrapper_auto_merge_and_block(monkeypatch):
    from app.core.config import settings
    monkeypatch.setattr(settings, "decision_gate_line_enabled", True)
    monkeypatch.setattr(settings, "decision_gate_line_mode", "enforcing")
    from app.services import workflow_line_engine as eng
    from app.services.merge_verdict_gate import AUTO_MERGE, BLOCK
    engine, Session = await _session()
    async with Session() as s:
        org = uuid.uuid4()
        await _seed_line(s, org, "enforcing")
        g = uuid.uuid4()
        with patch("app.services.merge_verdict_gate.evaluate_merge_gate", return_value=_decision(AUTO_MERGE, g)):
            d = await eng.evaluate_line_for_transition(
                s, org_id=org, project_id=None, entity_type="story", entity_id=uuid.uuid4(),
                from_status="in-review", to_status="done")
        assert d.mode == "advisory_only" and d.proceeds and d.status_to_apply == "done"
        with patch("app.services.merge_verdict_gate.evaluate_merge_gate", return_value=_decision(BLOCK, g)):
            d2 = await eng.evaluate_line_for_transition(
                s, org_id=org, project_id=None, entity_type="story", entity_id=uuid.uuid4(),
                from_status="in-review", to_status="done")
        assert d2.mode == "blocked_by_policy" and not d2.proceeds and d2.http_status == 409
    await engine.dispose()


@pytest.mark.skipif(not _REAL_DB_URL, reason="real Postgres 필요")
@pytest.mark.anyio
async def test_merge_gate_wrapper_failopen(monkeypatch):
    from app.core.config import settings
    monkeypatch.setattr(settings, "decision_gate_line_enabled", True)
    monkeypatch.setattr(settings, "decision_gate_line_mode", "enforcing")
    """⭐S3 fail-open 보존: merge-gate 평가(evaluate_merge_gate) 예외도 engine_failed→plain(전이 진행)."""
    from app.services import workflow_line_engine as eng
    engine, Session = await _session()
    async with Session() as s:
        org = uuid.uuid4()
        await _seed_line(s, org, "enforcing")
        with patch("app.services.merge_verdict_gate.evaluate_merge_gate", side_effect=RuntimeError("boom")):
            d = await eng.evaluate_line_for_transition(
                s, org_id=org, project_id=None, entity_type="story", entity_id=uuid.uuid4(),
                from_status="in-review", to_status="done")
        assert d.mode == "engine_failed" and d.degraded_to_plain and d.proceeds
    await engine.dispose()


@pytest.mark.skipif(not _REAL_DB_URL, reason="real Postgres 필요")
@pytest.mark.anyio
async def test_merge_gate_audit_persists_after_raise_commit(monkeypatch):
    from app.core.config import settings
    monkeypatch.setattr(settings, "decision_gate_line_enabled", True)
    monkeypatch.setattr(settings, "decision_gate_line_mode", "enforcing")
    """⭐SME blocking 회귀: gate_pending(라우터가 raise 前 db.commit) 후 engine 이 만든 step_run audit
    이 살아남아야 한다. commit 없이 raise 하면 get_db rollback 으로 사라지던 갭."""
    from sqlalchemy import select
    from app.services import workflow_line_engine as eng
    from app.services.merge_verdict_gate import ASK_HUMAN
    from app.models.workflow_line import WorkflowLineStepRun
    engine, Session = await _session()
    org, eid, gid = uuid.uuid4(), uuid.uuid4(), uuid.uuid4()
    async with Session() as s:
        await _seed_line(s, org, "enforcing")
        await s.commit()
    async with Session() as s:  # 라우터 트랜잭션 모사
        with patch("app.services.merge_verdict_gate.evaluate_merge_gate",
                   return_value=_decision(ASK_HUMAN, gid)):
            d = await eng.evaluate_line_for_transition(
                s, org_id=org, project_id=None, entity_type="story", entity_id=eid,
                from_status="in-review", to_status="done")
        assert not d.proceeds  # gate_pending → 라우터가 raise
        await s.commit()  # ⭐라우터의 raise-前 commit 모사
    async with Session() as s2:  # 새 세션 — audit 영속 확認(rollback 됐으면 None)
        sr = (await s2.execute(select(WorkflowLineStepRun).where(
            WorkflowLineStepRun.entity_id == eid))).scalar_one_or_none()
        assert sr is not None and sr.h1_gate_id == gid and sr.mode == "gate_pending"
    await engine.dispose()
