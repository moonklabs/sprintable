"""E-DG S18: runtime mode + allowlist + circuit breaker 테스트.

핵심: default-off→off(엔진 미진입)·allowlist 필터·mode 해소·circuit breaker(5분 5회→advisory 강등)·
min_mode 결합·엔진 통합(default-off→plain / enabled+shadow→advisory+step_run).
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


def _set(mp, *, enabled=False, allowlist="", mode="off"):
    from app.core.config import settings
    mp.setattr(settings, "decision_gate_line_enabled", enabled)
    mp.setattr(settings, "decision_gate_line_org_allowlist", allowlist)
    mp.setattr(settings, "decision_gate_line_mode", mode)


async def _engine_failure(s, org, started_at):
    from app.models.workflow_line import WorkflowLineStepRun
    s.add(WorkflowLineStepRun(
        org_id=org, project_id=uuid.uuid4(), entity_type="story", entity_id=uuid.uuid4(),
        from_status="a", to_status="b", status="engine_failed", mode="engine_failed",
        correlation_id=uuid.uuid4(), transition_id=uuid.uuid4().hex, started_at=started_at))
    await s.flush()


# ── min_mode unit ───────────────────────────────────────────────────────────
def test_min_mode_picks_conservative():
    from app.services.workflow_runtime_mode import min_mode
    assert min_mode("advisory", "enforcing") == "advisory"
    assert min_mode("enforcing", "enforcing") == "enforcing"
    assert min_mode("off", "shadow") == "off"
    assert min_mode("shadow", "advisory") == "shadow"


# ── resolver: settings 게이트 ────────────────────────────────────────────────
@pytest.mark.skipif(not _REAL_DB_URL, reason="real Postgres 필요")
@pytest.mark.anyio
async def test_disabled_returns_off(monkeypatch):
    from app.services.workflow_runtime_mode import resolve_runtime_mode
    engine, Session = await _session()
    async with Session() as s:
        _set(monkeypatch, enabled=False, mode="enforcing")  # disabled면 mode 무관
        assert await resolve_runtime_mode(s, uuid.uuid4(), now=_NOW) == "off"
    await engine.dispose()


@pytest.mark.skipif(not _REAL_DB_URL, reason="real Postgres 필요")
@pytest.mark.anyio
async def test_enabled_empty_allowlist_all_orgs(monkeypatch):
    from app.services.workflow_runtime_mode import resolve_runtime_mode
    engine, Session = await _session()
    async with Session() as s:
        _set(monkeypatch, enabled=True, allowlist="", mode="enforcing")
        assert await resolve_runtime_mode(s, uuid.uuid4(), now=_NOW) == "enforcing"
    await engine.dispose()


@pytest.mark.skipif(not _REAL_DB_URL, reason="real Postgres 필요")
@pytest.mark.anyio
async def test_allowlist_filters(monkeypatch):
    from app.services.workflow_runtime_mode import resolve_runtime_mode
    engine, Session = await _session()
    async with Session() as s:
        allowed, other = uuid.uuid4(), uuid.uuid4()
        _set(monkeypatch, enabled=True, allowlist=str(allowed), mode="advisory")
        assert await resolve_runtime_mode(s, allowed, now=_NOW) == "advisory"
        assert await resolve_runtime_mode(s, other, now=_NOW) == "off"  # 미allowlist
    await engine.dispose()


@pytest.mark.skipif(not _REAL_DB_URL, reason="real Postgres 필요")
@pytest.mark.anyio
async def test_mode_off_returns_off(monkeypatch):
    from app.services.workflow_runtime_mode import resolve_runtime_mode
    engine, Session = await _session()
    async with Session() as s:
        _set(monkeypatch, enabled=True, mode="off")
        assert await resolve_runtime_mode(s, uuid.uuid4(), now=_NOW) == "off"
    await engine.dispose()


# ── circuit breaker ─────────────────────────────────────────────────────────
@pytest.mark.skipif(not _REAL_DB_URL, reason="real Postgres 필요")
@pytest.mark.anyio
async def test_circuit_breaker_degrades_to_advisory(monkeypatch):
    from app.services.workflow_runtime_mode import resolve_runtime_mode
    engine, Session = await _session()
    async with Session() as s:
        org = uuid.uuid4()
        _set(monkeypatch, enabled=True, mode="enforcing")
        # 5분 창에 5회 engine failure → trip → advisory 강등
        for i in range(5):
            await _engine_failure(s, org, _NOW - timedelta(minutes=2, seconds=i * 10))
        assert await resolve_runtime_mode(s, org, now=_NOW) == "advisory"  # enforcing→advisory cap
    await engine.dispose()


@pytest.mark.skipif(not _REAL_DB_URL, reason="real Postgres 필요")
@pytest.mark.anyio
async def test_circuit_breaker_below_threshold_keeps_mode(monkeypatch):
    from app.services.workflow_runtime_mode import resolve_runtime_mode
    engine, Session = await _session()
    async with Session() as s:
        org = uuid.uuid4()
        _set(monkeypatch, enabled=True, mode="enforcing")
        for i in range(4):  # 4회 < threshold 5
            await _engine_failure(s, org, _NOW - timedelta(minutes=2, seconds=i * 10))
        assert await resolve_runtime_mode(s, org, now=_NOW) == "enforcing"  # 강등 없음
    await engine.dispose()


@pytest.mark.skipif(not _REAL_DB_URL, reason="real Postgres 필요")
@pytest.mark.anyio
async def test_circuit_breaker_spread_out_no_trip(monkeypatch):
    from app.services.workflow_runtime_mode import resolve_runtime_mode
    engine, Session = await _session()
    async with Session() as s:
        org = uuid.uuid4()
        _set(monkeypatch, enabled=True, mode="enforcing")
        # 5회지만 12분에 걸쳐 분산 → 어떤 5분 창에도 5회 없음 → trip 안 됨
        for i in range(5):
            await _engine_failure(s, org, _NOW - timedelta(minutes=3 * i + 1))
        assert await resolve_runtime_mode(s, org, now=_NOW) == "enforcing"
    await engine.dispose()


# ── 엔진 통합: default-off 무영향 / enabled 진입 ─────────────────────────────
async def _seed_line(s, org, mode, *, from_status="in-review", to_status="done", step_type="agent-handoff"):
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
async def test_engine_default_off_returns_plain_even_with_active_line(monkeypatch):
    from app.services.workflow_line_engine import evaluate_line_for_transition
    engine, Session = await _session()
    async with Session() as s:
        org = uuid.uuid4()
        await _seed_line(s, org, "enforcing")  # 활성 enforcing 라인 있어도
        _set(monkeypatch, enabled=False)  # default-off → 엔진 미진입
        d = await evaluate_line_for_transition(
            s, org_id=org, project_id=None, entity_type="story", entity_id=uuid.uuid4(),
            from_status="in-review", to_status="done")
        assert d.mode == "plain_transition" and d.proceeds  # 라이브 무영향(AC②⑥)
    await engine.dispose()


@pytest.mark.skipif(not _REAL_DB_URL, reason="real Postgres 필요")
@pytest.mark.anyio
async def test_engine_enabled_shadow_enters_and_records(monkeypatch):
    from app.services.workflow_line_engine import evaluate_line_for_transition
    engine, Session = await _session()
    async with Session() as s:
        org = uuid.uuid4()
        await _seed_line(s, org, "enforcing")  # config=enforcing
        _set(monkeypatch, enabled=True, mode="shadow")  # runtime=shadow → min=shadow(관측만)
        d = await evaluate_line_for_transition(
            s, org_id=org, project_id=None, entity_type="story", entity_id=uuid.uuid4(),
            from_status="in-review", to_status="done")
        # runtime shadow 가 config enforcing 을 cap → advisory_only(관측·비차단·relay 안 함)
        assert d.mode == "advisory_only" and d.proceeds and d.relay_step_run_id is None
    await engine.dispose()


# ── ⭐SME 회귀: line_merge_gate_active 가 runtime mode 반영(default-off 무영향 계약) ──────
@pytest.mark.skipif(not _REAL_DB_URL, reason="real Postgres 필요")
@pytest.mark.anyio
async def test_line_merge_gate_active_respects_runtime_mode(monkeypatch):
    from app.services.workflow_line_engine import line_merge_gate_active
    engine, Session = await _session()
    async with Session() as s:
        org = uuid.uuid4()
        await _seed_line(s, org, "enforcing", step_type="merge-gate")  # config enforcing merge-gate

        async def _active(**kw):
            return await line_merge_gate_active(
                s, org_id=org, project_id=None, entity_type="story",
                from_status="in-review", to_status="done")

        # ⭐default-off → False(라우터가 legacy H1 done gate 유지·우회 0·무영향 계약)
        _set(monkeypatch, enabled=False)
        assert await _active() is False
        # runtime shadow(config enforcing 을 cap) → effective shadow → False
        _set(monkeypatch, enabled=True, mode="shadow")
        assert await _active() is False
        # 미allowlist org → off → False
        _set(monkeypatch, enabled=True, allowlist=str(uuid.uuid4()), mode="enforcing")
        assert await _active() is False
        # enabled + enforcing + allowlist 포함 → effective enforcing → True(라인이 done gate 소유)
        _set(monkeypatch, enabled=True, allowlist=str(org), mode="enforcing")
        assert await _active() is True
    await engine.dispose()


@pytest.mark.skipif(not _REAL_DB_URL, reason="real Postgres 필요")
@pytest.mark.anyio
async def test_line_merge_gate_active_false_when_circuit_degraded(monkeypatch):
    """circuit breaker advisory 강등 시 effective != enforcing → 라인 미소유(legacy H1 유지)."""
    from app.services.workflow_line_engine import line_merge_gate_active
    engine, Session = await _session()
    async with Session() as s:
        org = uuid.uuid4()
        await _seed_line(s, org, "enforcing", step_type="merge-gate")
        # line_merge_gate_active 는 now 파라미터가 없어 실시간 기준 → failures 도 실시간으로 시드.
        real_now = datetime.now(timezone.utc)
        for i in range(5):  # 실 5분창 5회 → circuit trip → advisory 강등
            await _engine_failure(s, org, real_now - timedelta(seconds=i * 10))
        _set(monkeypatch, enabled=True, mode="enforcing")
        # runtime=enforcing 이지만 circuit 강등으로 advisory → min(advisory,enforcing)=advisory → False
        assert await line_merge_gate_active(
            s, org_id=org, project_id=None, entity_type="story",
            from_status="in-review", to_status="done", ) is False
    await engine.dispose()
