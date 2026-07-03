"""E-DG S29: dry-run resolve-preview API + engine dry_run 모드.

핵심: ①evaluate_line(dry_run=True)=side-effect 0(step_run insert·grandfather consume·gate write 스킵·
commit 0) ②grandfather는 peek(consume 금지·preview 거짓말 안 함) ③LineDecision→FE 3축 투영(routing_
path·gates·trust_branch·⭐trust null≠0 보존). admin-gated·published-only(Phase-1).
"""
from __future__ import annotations

import os
import uuid

import pytest

from app.routers.workflow_line_config import _project_preview
from app.services.workflow_line_engine import LineDecision

_REAL_DB_URL = os.getenv("PARITY_TEST_DATABASE_URL") or os.getenv("ALEMBIC_DATABASE_URL")

# story 8236bbc3: create_all(+drop_all)로 자체 스키마를 직접 다룸 — 공유 alembic-migrated
# DB 오염 방지 위해 격리 DB 전용(conftest.py 가드가 마커 누락을 자동 검출).
pytestmark = pytest.mark.destructive_schema


@pytest.fixture
def anyio_backend():
    return "asyncio"


# ── 3축 투영(unit·CI-runnable·FE 계약) ────────────────────────────────────────
def test_project_plain_empty_axes():
    """default-off/라인없음(plain) → matched=False·routing_path/gates 빈배열·trust null(cold-start)."""
    d = LineDecision(mode="plain_transition", status_to_apply=None)
    r = _project_preview(d, "draft", "confirmed", {"trust": {"hypothesis_hit_rate": None, "cold_start": True}})
    assert r.matched is False and r.routing_path == [] and r.gates == []
    assert r.trust_branch.trust is None and r.trust_branch.cold_start is True
    assert r.trust_branch.decision == "auto_merge" and r.proceeds is True


def test_project_gate_pending_human():
    """gate_pending → gate_type=human·decision=ask_human·proceeds=False."""
    d = LineDecision(mode="gate_pending", status_to_apply=None, blocking_reason="human review")
    r = _project_preview(d, "draft", "confirmed", {"trust": {"hypothesis_hit_rate": 0.0, "cold_start": False}})
    assert r.matched is True and r.proceeds is False
    assert r.routing_path[0].from_status == "draft" and r.routing_path[0].to_status == "confirmed"
    assert r.gates[0].gate_type == "human" and r.gates[0].target == "human review"
    assert r.trust_branch.decision == "ask_human"
    # ⭐null≠0: 0.0 은 실값으로 보존(None 으로 강등 금지).
    assert r.trust_branch.trust == 0.0 and r.trust_branch.cold_start is False


def test_project_blocked_policy():
    d = LineDecision(mode="blocked_by_policy", status_to_apply=None, blocking_reason="policy blocks")
    r = _project_preview(d, "active", "done", {"trust": {"hypothesis_hit_rate": 0.7, "cold_start": False}})
    assert r.gates[0].gate_type == "policy" and r.trust_branch.decision == "block"
    assert r.proceeds is False and r.trust_branch.trust == 0.7


# ── engine dry_run = write 0 (real-PG) ────────────────────────────────────────
async def _session():
    from sqlalchemy.ext.asyncio import async_sessionmaker, create_async_engine
    from app.core.database import Base
    import app.models  # noqa: F401
    import app.models.workflow_line  # noqa: F401
    url = _REAL_DB_URL
    for prefix in ("postgresql+psycopg2://", "postgresql://"):
        if url.startswith(prefix):
            url = "postgresql+asyncpg://" + url[len(prefix):]
            break
    engine = create_async_engine(url)
    async with engine.begin() as conn:
        await conn.run_sync(Base.metadata.create_all)
    return engine, async_sessionmaker(engine, expire_on_commit=False)


def _enable_shadow(mp, mode="shadow"):
    from app.core.config import settings
    mp.setattr(settings, "decision_gate_line_enabled", True)
    mp.setattr(settings, "decision_gate_line_org_allowlist", "")
    mp.setattr(settings, "decision_gate_line_mode", mode)


async def _seed_line(s, org, *, rollout="shadow", from_status="draft", to_status="confirmed"):
    from app.models.project import Project
    from app.models.doc import Doc
    from app.models.workflow_line import WorkflowLineDefinition, WorkflowLineDefinitionVersion
    proj = uuid.uuid4()
    s.add(Project(id=proj, org_id=org, name="p"))
    await s.flush()
    defn = WorkflowLineDefinition(org_id=org, project_id=None, entity_type="doc",
                                  name="L", is_active=True, version=1)
    s.add(defn)
    await s.flush()
    s.add(WorkflowLineDefinitionVersion(
        line_definition_id=defn.id, org_id=org, project_id=None, entity_type="doc", version=1,
        status="published", config_hash="h", created_by_member_id=uuid.uuid4(),
        config={"rollout_mode": rollout, "steps": [{
            "from_status": from_status, "to_status": to_status, "step_type": "human-gate"}]}))
    doc = Doc(org_id=org, project_id=proj, title="d", slug=f"d-{uuid.uuid4().hex[:8]}",
              content="x", status=from_status)
    s.add(doc)
    await s.flush()
    return proj, doc


@pytest.mark.skipif(not _REAL_DB_URL, reason="real Postgres 필요")
@pytest.mark.anyio
async def test_dry_run_records_no_step_run(monkeypatch):
    """⭐dry_run=True 는 step_run insert 0(real 은 1) — write-0 증명(QA 집중)."""
    from app.services.workflow_line_engine import evaluate_line_for_transition
    from app.models.workflow_line import WorkflowLineStepRun
    from sqlalchemy import select, func
    _enable_shadow(monkeypatch)
    engine, Session = await _session()
    async with Session() as s:
        org = uuid.uuid4()
        proj, doc = await _seed_line(s, org)
        await s.commit()

        async def _count():
            return (await s.execute(
                select(func.count()).select_from(WorkflowLineStepRun)
                .where(WorkflowLineStepRun.entity_id == doc.id)
            )).scalar()

        dec_dry = await evaluate_line_for_transition(
            s, org_id=org, project_id=proj, entity_type="doc", entity_id=doc.id,
            from_status="draft", to_status="confirmed", dry_run=True)
        await s.commit()
        assert await _count() == 0  # ⭐write 0

        dec_real = await evaluate_line_for_transition(
            s, org_id=org, project_id=proj, entity_type="doc", entity_id=doc.id,
            from_status="draft", to_status="confirmed", dry_run=False)
        await s.commit()
        assert await _count() == 1  # real 은 step_run 기록 → 라인 active 입증
        # 결정 parity: dry 와 real 의 mode 동일(같은 로직·드리프트 0).
        assert dec_dry.mode == dec_real.mode == "advisory_only"
    await engine.dispose()


@pytest.mark.skipif(not _REAL_DB_URL, reason="real Postgres 필요")
@pytest.mark.anyio
async def test_dry_run_peek_does_not_consume_grandfather(monkeypatch):
    """⭐grandfather peek: dry_run 은 marker 를 consume 하지 않는다(preview 가 거짓말 안 함·PO Q3)."""
    from app.services.workflow_line_engine import evaluate_line_for_transition
    from app.models.project import Project
    from app.models.pm import Story
    from app.models.workflow_line import (
        WorkflowLineDefinition, WorkflowLineDefinitionVersion, WorkflowLineStepRun,
    )
    from sqlalchemy import select
    _enable_shadow(monkeypatch, mode="enforcing")
    engine, Session = await _session()
    async with Session() as s:
        org = uuid.uuid4()
        proj = uuid.uuid4()
        s.add(Project(id=proj, org_id=org, name="p"))
        await s.flush()
        defn = WorkflowLineDefinition(org_id=org, project_id=None, entity_type="story",
                                      name="L", is_active=True, version=1)
        s.add(defn)
        await s.flush()
        s.add(WorkflowLineDefinitionVersion(
            line_definition_id=defn.id, org_id=org, project_id=None, entity_type="story", version=1,
            status="published", config_hash="h", created_by_member_id=uuid.uuid4(),
            config={"rollout_mode": "enforcing", "steps": [{
                "from_status": "in-review", "to_status": "done", "step_type": "human-gate"}]}))
        story = Story(org_id=org, project_id=proj, title="t", status="in-review", priority="high")
        s.add(story)
        await s.flush()
        marker = WorkflowLineStepRun(
            org_id=org, project_id=proj, entity_type="story", entity_id=story.id,
            from_status="in-review", to_status="in-review", status="grandfathered",
            mode="advisory_only", correlation_id=uuid.uuid4(), transition_id=uuid.uuid4().hex)
        s.add(marker)
        await s.flush()
        await s.commit()

        await evaluate_line_for_transition(
            s, org_id=org, project_id=proj, entity_type="story", entity_id=story.id,
            from_status="in-review", to_status="done", dry_run=True)
        await s.commit()
        # ⭐marker 여전히 open(consume 안 됨) — dry_run peek.
        st = (await s.execute(
            select(WorkflowLineStepRun.status).where(WorkflowLineStepRun.id == marker.id)
        )).scalar()
        assert st == "grandfathered"
    await engine.dispose()


def test_project_merge_gate_type():
    """⭐QA Nit2: merge-gate dry-run(mode=gate_pending·effective_gate_type='merge') → gate_type='merge'
    (human 오라벨 방지·FE merge_verdict 배지). effective_gate_type 우선."""
    d = LineDecision(mode="gate_pending", status_to_apply=None,
                     blocking_reason="merge-gate (dry-run preview)", effective_gate_type="merge")
    r = _project_preview(d, "in-review", "done", {"trust": {"hypothesis_hit_rate": None, "cold_start": True}})
    assert r.gates[0].gate_type == "merge"  # human 아님
    assert r.trust_branch.decision == "ask_human"  # gate_pending → ask_human 분기는 유지
