"""E-DG S23: hypothesis proposed→active line overlay.

핵심: gate 승인 applier 가 native ``transition_hypothesis``(via_gate) 재사용(parallel 0·confirmed_by
=approver)·⭐SoD(approver≠owner_member_id) 차단·멱등·default-off byte-동일(overlay off→inline 폴백).
"""
from __future__ import annotations

import os
import uuid
from datetime import datetime, timezone

import pytest

_REAL_DB_URL = os.getenv("PARITY_TEST_DATABASE_URL") or os.getenv("ALEMBIC_DATABASE_URL")


@pytest.fixture
def anyio_backend():
    return "asyncio"


async def _session():
    from sqlalchemy.ext.asyncio import async_sessionmaker, create_async_engine
    from app.core.database import Base
    import app.models  # noqa: F401
    url = _REAL_DB_URL
    for prefix in ("postgresql+psycopg2://", "postgresql+asyncpg://", "postgresql://"):
        if url.startswith(prefix):
            url = "postgresql+asyncpg://" + url[len(prefix):]
            break
    engine = create_async_engine(url)
    async with engine.begin() as conn:
        await conn.run_sync(Base.metadata.create_all)
    return engine, async_sessionmaker(engine, expire_on_commit=False)


async def _seed_hyp(s, org, proj, owner, status="proposed"):
    from app.models.hypothesis import Hypothesis
    h = Hypothesis(
        org_id=org, project_id=proj, owner_member_id=owner, statement="가설",
        metric_definition={"metric": "x"}, measure_after=datetime.now(timezone.utc), status=status,
    )
    s.add(h)
    await s.flush()
    return h


async def _seed_sr(s, org, proj, hyp_id):
    from app.models.workflow_line import WorkflowLineStepRun
    sr = WorkflowLineStepRun(
        org_id=org, project_id=proj, entity_type="hypothesis", entity_id=hyp_id,
        from_status="proposed", to_status="active", status="gate_pending", mode="enforcing",
        correlation_id=uuid.uuid4(), transition_id=uuid.uuid4().hex,
    )
    s.add(sr)
    await s.flush()
    return sr


@pytest.mark.skipif(not _REAL_DB_URL, reason="real Postgres 필요")
@pytest.mark.anyio
async def test_apply_sod_blocks_owner_self_approve():
    """⭐SoD: approver == owner_member_id → 차단(skipped)·hyp proposed 유지(trust-gaming 봉)."""
    from app.services.workflow_line_resolution import _apply_hypothesis_active
    from sqlalchemy import text as sa_text
    engine, Session = await _session()
    async with Session() as s:
        org, proj, owner = uuid.uuid4(), uuid.uuid4(), uuid.uuid4()
        from app.models.project import Project
        s.add(Project(id=proj, org_id=org, name="p"))
        await s.flush()
        hyp = await _seed_hyp(s, org, proj, owner)
        sr = await _seed_sr(s, org, proj, hyp.id)
        await _apply_hypothesis_active(s, sr, resolver_id=owner)  # approver=owner 자기 confirm
        await s.commit()
        st = (await s.execute(sa_text("SELECT status FROM hypotheses WHERE id=:i"), {"i": hyp.id})).scalar()
        assert st == "proposed"  # 활성화 차단
        assert sr.status == "skipped"
    await engine.dispose()


@pytest.mark.skipif(not _REAL_DB_URL, reason="real Postgres 필요")
@pytest.mark.anyio
async def test_apply_different_approver_activates_with_confirmed_by():
    """approver ≠ owner → active + confirmed_by_member_id=approver(native transition_hypothesis 재사용)."""
    from app.services.workflow_line_resolution import _apply_hypothesis_active
    from sqlalchemy import text as sa_text
    engine, Session = await _session()
    async with Session() as s:
        org, proj, owner, approver = uuid.uuid4(), uuid.uuid4(), uuid.uuid4(), uuid.uuid4()
        from app.models.project import Project
        s.add(Project(id=proj, org_id=org, name="p"))
        await s.flush()
        hyp = await _seed_hyp(s, org, proj, owner)
        sr = await _seed_sr(s, org, proj, hyp.id)
        await _apply_hypothesis_active(s, sr, resolver_id=approver)
        await s.commit()
        row = (await s.execute(sa_text(
            "SELECT status, confirmed_by_member_id FROM hypotheses WHERE id=:i"), {"i": hyp.id})).one()
        assert row[0] == "active" and row[1] == approver  # AC3: 동일결과+confirmed_by
        assert sr.status == "applied"
    await engine.dispose()


@pytest.mark.skipif(not _REAL_DB_URL, reason="real Postgres 필요")
@pytest.mark.anyio
async def test_apply_idempotent_already_active():
    """이미 active(다른 경로 도달) → applied no-op(중복 활성화 0·에러 없음)."""
    from app.services.workflow_line_resolution import _apply_hypothesis_active
    engine, Session = await _session()
    async with Session() as s:
        org, proj, owner, approver = uuid.uuid4(), uuid.uuid4(), uuid.uuid4(), uuid.uuid4()
        from app.models.project import Project
        s.add(Project(id=proj, org_id=org, name="p"))
        await s.flush()
        hyp = await _seed_hyp(s, org, proj, owner, status="active")
        sr = await _seed_sr(s, org, proj, hyp.id)
        await _apply_hypothesis_active(s, sr, resolver_id=approver)
        await s.commit()
        assert sr.status == "applied"  # no-op·예외 0
    await engine.dispose()


@pytest.mark.skipif(not _REAL_DB_URL, reason="real Postgres 필요")
@pytest.mark.anyio
async def test_default_off_agent_active_still_blocked():
    """default-off(라인 없음): agent active 시도 → overlay decision=plain → inline HUMAN_CONFIRM_REQUIRED
    유지(byte-동일·fail-open=통과 아님)."""
    from app.services.hypothesis import transition_hypothesis, HypothesisServiceError
    from app.schemas.hypothesis import HypothesisTransition
    from app.services.member_resolver import ResolvedMember
    engine, Session = await _session()
    async with Session() as s:
        org, proj, owner = uuid.uuid4(), uuid.uuid4(), uuid.uuid4()
        from app.models.project import Project
        s.add(Project(id=proj, org_id=org, name="p"))
        await s.flush()
        hyp = await _seed_hyp(s, org, proj, owner)
        await s.commit()
        agent = ResolvedMember(id=uuid.uuid4(), user_id=None, name="a", type="agent", role="member", org_id=org)
        with pytest.raises(HypothesisServiceError) as ei:
            await transition_hypothesis(s, org, agent, hyp.id, HypothesisTransition(status="active"))
        assert ei.value.code == "HUMAN_CONFIRM_REQUIRED"  # agent 차단 유지
    await engine.dispose()


@pytest.mark.skipif(not _REAL_DB_URL, reason="real Postgres 필요")
@pytest.mark.anyio
async def test_via_gate_human_activates_without_regate():
    """via_gate=True(gate 승인 적용 경로): human approver → active + confirmed_by·overlay 재진입 안 함."""
    from app.services.hypothesis import transition_hypothesis
    from app.schemas.hypothesis import HypothesisTransition
    from app.services.member_resolver import ResolvedMember
    from sqlalchemy import text as sa_text
    engine, Session = await _session()
    async with Session() as s:
        org, proj, owner, approver = uuid.uuid4(), uuid.uuid4(), uuid.uuid4(), uuid.uuid4()
        from app.models.project import Project
        s.add(Project(id=proj, org_id=org, name="p"))
        await s.flush()
        hyp = await _seed_hyp(s, org, proj, owner)
        await s.commit()
        human = ResolvedMember(id=approver, user_id=None, name="h", type="human", role="member", org_id=org)
        await transition_hypothesis(
            s, org, human, hyp.id, HypothesisTransition(status="active"), via_gate=True)
        await s.commit()
        row = (await s.execute(sa_text(
            "SELECT status, confirmed_by_member_id FROM hypotheses WHERE id=:i"), {"i": hyp.id})).one()
        assert row[0] == "active" and row[1] == approver
    await engine.dispose()
