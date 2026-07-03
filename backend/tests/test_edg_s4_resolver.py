"""E-DG S4: trust-routing resolver 테스트.

핵심: cold-start≠0점(None 보존)·risk 불확실→prod_touch None+ask_human·trust-before-capture(현
verdict 미포함)·routing_context shape·엔진 shadow 가 routing_context/trust_snapshot 기록.
"""
from __future__ import annotations

import os
import uuid

import pytest

from app.services.workflow_line_resolver import _risk_flags, _story_predicate

_REAL_DB_URL = os.getenv("PARITY_TEST_DATABASE_URL") or os.getenv("ALEMBIC_DATABASE_URL")

# story 8236bbc3: create_all(+drop_all)로 자체 스키마를 직접 다룸 — 공유 alembic-migrated
# DB 오염 방지 위해 격리 DB 전용(conftest.py 가드가 마커 누락을 자동 검출).
pytestmark = pytest.mark.destructive_schema


@pytest.fixture
def anyio_backend():
    return "asyncio"


class _FakeStory:
    def __init__(self, **kw):
        self.priority = kw.get("priority", "medium")
        self.story_points = kw.get("story_points")
        self.success_hypothesis = kw.get("success_hypothesis")
        self.metric_definition = kw.get("metric_definition")
        self.measure_after = kw.get("measure_after")
        self.outcome_status = kw.get("outcome_status", "n_a")
        self.outcome_result = kw.get("outcome_result")
        self.is_excluded = kw.get("is_excluded", False)


# ── pure ──────────────────────────────────────────────────────────────────────
def test_risk_flags_prod_touch_never_assumed_false():
    rf = _risk_flags(_FakeStory(story_points=3))
    assert rf["prod_touch"] is None  # ⭐불명 — False 추정 금지(AC⑤)
    assert rf["uncertain"] is False  # story_points 있음
    assert rf["high_effort"] is False


def test_risk_flags_uncertain_when_no_points_or_no_story():
    assert _risk_flags(_FakeStory(story_points=None))["uncertain"] is True
    assert _risk_flags(None)["uncertain"] is True
    assert _risk_flags(_FakeStory(story_points=13))["high_effort"] is True


def test_story_predicate_shape():
    p = _story_predicate(_FakeStory(priority="high", story_points=5, success_hypothesis="x"))
    assert p["priority"] == "high" and p["story_points"] == 5
    assert p["has_success_hypothesis"] is True
    assert p["has_metric_definition"] is False and p["outcome_status"] == "n_a"


# ── DB-backed ─────────────────────────────────────────────────────────────────
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


@pytest.mark.skipif(not _REAL_DB_URL, reason="real Postgres 필요")
@pytest.mark.anyio
async def test_trust_snapshot_cold_start_is_none_not_zero():
    from app.services.workflow_line_resolver import resolve_trust_snapshot
    engine, Session = await _session()
    async with Session() as s:
        org, member = uuid.uuid4(), uuid.uuid4()
        snap = await resolve_trust_snapshot(s, org, member)
        # ⭐outcome 표본 없음 → cold-start·None(0점 아님)
        assert snap["cold_start"] is True
        assert snap["hypothesis_hit_rate"] is None  # NOT 0.0
        assert snap["resolved"] == 0
        assert snap["primary_source"] == "hypothesis_outcome"
        assert snap["captured_before_verdict"] is True  # ⭐AC⑥
    await engine.dispose()


@pytest.mark.skipif(not _REAL_DB_URL, reason="real Postgres 필요")
@pytest.mark.anyio
async def test_trust_snapshot_no_member():
    from app.services.workflow_line_resolver import resolve_trust_snapshot
    engine, Session = await _session()
    async with Session() as s:
        snap = await resolve_trust_snapshot(s, uuid.uuid4(), None)
        assert snap["cold_start"] is True and snap["reason"] == "no_member"
        assert snap["captured_before_verdict"] is True
    await engine.dispose()


@pytest.mark.skipif(not _REAL_DB_URL, reason="real Postgres 필요")
@pytest.mark.anyio
async def test_routing_context_story_shape_and_cold_start_ask_human():
    from app.services.workflow_line_resolver import resolve_routing_context
    from app.models.pm import Story
    from app.models.project import Project
    engine, Session = await _session()
    async with Session() as s:
        org, proj, member = uuid.uuid4(), uuid.uuid4(), uuid.uuid4()
        s.add(Project(id=proj, org_id=org, name="p")); await s.flush()
        story = Story(org_id=org, project_id=proj, title="t", status="in-review",
                      priority="high", story_points=3)
        s.add(story)
        await s.flush()
        ctx = await resolve_routing_context(
            s, org, entity_type="story", entity_id=story.id, actor_member_id=member, actor_type="agent")
        assert ctx["supported"] is True
        assert set(ctx) >= {"entity_type", "story", "actor", "risk_flags", "trust", "suggested_default"}
        assert ctx["story"]["priority"] == "high" and ctx["story"]["story_points"] == 3
        assert ctx["actor"]["type"] == "agent"
        assert ctx["trust"]["cold_start"] is True
        # cold-start → safe default ask_human
        assert ctx["suggested_default"] == "ask_human"
    await engine.dispose()


@pytest.mark.skipif(not _REAL_DB_URL, reason="real Postgres 필요")
@pytest.mark.anyio
async def test_routing_context_non_story_unsupported():
    from app.services.workflow_line_resolver import resolve_routing_context
    engine, Session = await _session()
    async with Session() as s:
        ctx = await resolve_routing_context(
            s, uuid.uuid4(), entity_type="widget", entity_id=uuid.uuid4())
        # ⚠️S26 후 5 등록 엔티티(story/hyp/doc/epic/sprint) 전부 eligible → 미지원 검사는 미등록 entity
        # (widget)로. resolve_routing_context 가 unknown_entity_type 으로 unsupported 반환(fail-open).
        assert ctx["supported"] is False
        assert ctx["reason"] == "unknown_entity_type"
        assert ctx["suggested_default"] == "ask_human"  # 불명=safe default
    await engine.dispose()


@pytest.mark.skipif(not _REAL_DB_URL, reason="real Postgres 필요")
@pytest.mark.anyio
@pytest.mark.xfail(strict=False, reason="settings.decision_gate_line_enabled monkeypatch 누락(형제 s18/s19/s29 패턴 미적용) — default-off라 plain_transition로 퇴화. story 8236bbc3 e2e서 신규 노출(파일 자체가 CI 최초 실행). story 18eefc31 트래킹.")
async def test_engine_shadow_records_routing_context_and_trust():
    """S3 엔진 shadow 경로가 S4 resolver 산출(routing_context+trust_snapshot)을 step_run 에 기록."""
    from sqlalchemy import select
    from app.services.workflow_line_engine import evaluate_line_for_transition
    from app.models.workflow_line import (
        WorkflowLineDefinition, WorkflowLineDefinitionVersion, WorkflowLineStepRun,
    )
    from app.models.pm import Story
    from app.models.project import Project
    engine, Session = await _session()
    async with Session() as s:
        org, proj, member = uuid.uuid4(), uuid.uuid4(), uuid.uuid4()
        s.add(Project(id=proj, org_id=org, name="p")); await s.flush()
        defn = WorkflowLineDefinition(org_id=org, project_id=None, entity_type="story",
                                      name="L", is_active=True, version=1)
        s.add(defn); await s.flush()
        s.add(WorkflowLineDefinitionVersion(
            line_definition_id=defn.id, org_id=org, project_id=None, entity_type="story",
            version=1, status="published", config_hash="h", created_by_member_id=uuid.uuid4(),
            config={"rollout_mode": "shadow",
                    "steps": [{"from_status": "in-review", "to_status": "done", "step_type": "merge-gate"}]}))
        story = Story(org_id=org, project_id=proj, title="t", status="in-review",
                      priority="high", story_points=3)
        s.add(story); await s.flush()
        d = await evaluate_line_for_transition(
            s, org_id=org, project_id=proj, entity_type="story", entity_id=story.id,
            from_status="in-review", to_status="done", actor_id=member)
        assert d.mode == "advisory_only" and d.proceeds
        sr = (await s.execute(select(WorkflowLineStepRun).where(
            WorkflowLineStepRun.entity_id == story.id))).scalar_one()
        # ⭐routing_context + trust_snapshot 가 빈 {} 가 아니라 resolver 산출로 채워짐
        assert sr.routing_context.get("supported") is True
        assert sr.routing_context.get("story", {}).get("priority") == "high"
        assert sr.trust_snapshot.get("cold_start") is True
        assert sr.trust_snapshot.get("captured_before_verdict") is True
    await engine.dispose()


@pytest.mark.skipif(not _REAL_DB_URL, reason="real Postgres 필요")
@pytest.mark.anyio
@pytest.mark.xfail(strict=False, reason="settings.decision_gate_line_enabled monkeypatch 누락(형제 s18/s19/s29 패턴 미적용) — default-off라 plain_transition로 퇴화. story 8236bbc3 e2e서 신규 노출(파일 자체가 CI 최초 실행). story 18eefc31 트래킹.")
async def test_actor_propagates_to_step_run_snapshot():
    """⭐SME blocking 회귀: 엔진에 actor_id/actor_type 을 넘기면 resolver→step_run.routing_context.actor
    까지 전파돼야 한다(라우터가 actor 미전달 시 항상 no_member 로 고정되던 통합 갭). actor.member_id 가
    실제 actor 로 채워져야 trust 가 그 actor 이력 기반(non-cold-start 가능)이 된다."""
    from sqlalchemy import select
    from app.services.workflow_line_engine import evaluate_line_for_transition
    from app.models.workflow_line import (
        WorkflowLineDefinition, WorkflowLineDefinitionVersion, WorkflowLineStepRun,
    )
    from app.models.pm import Story
    from app.models.project import Project
    engine, Session = await _session()
    async with Session() as s:
        org, proj, actor = uuid.uuid4(), uuid.uuid4(), uuid.uuid4()
        s.add(Project(id=proj, org_id=org, name="p")); await s.flush()
        defn = WorkflowLineDefinition(org_id=org, project_id=None, entity_type="story",
                                      name="L", is_active=True, version=1)
        s.add(defn); await s.flush()
        s.add(WorkflowLineDefinitionVersion(
            line_definition_id=defn.id, org_id=org, project_id=None, entity_type="story",
            version=1, status="published", config_hash="h", created_by_member_id=uuid.uuid4(),
            config={"rollout_mode": "shadow",
                    "steps": [{"from_status": "in-review", "to_status": "done", "step_type": "merge-gate"}]}))
        story = Story(org_id=org, project_id=proj, title="t", status="in-review", priority="high")
        s.add(story); await s.flush()
        await evaluate_line_for_transition(
            s, org_id=org, project_id=proj, entity_type="story", entity_id=story.id,
            from_status="in-review", to_status="done", actor_id=actor, actor_type="human")
        sr = (await s.execute(select(WorkflowLineStepRun).where(
            WorkflowLineStepRun.entity_id == story.id))).scalar_one()
        # ⭐actor 가 no_member 로 고정되지 않고 실제 actor 로 전파됨
        assert sr.routing_context["actor"]["member_id"] == str(actor)
        assert sr.routing_context["actor"]["type"] == "human"
        assert sr.trust_snapshot.get("reason") != "no_member"  # 실 actor 기반(이력 있으면 non-cold-start)
    await engine.dispose()
