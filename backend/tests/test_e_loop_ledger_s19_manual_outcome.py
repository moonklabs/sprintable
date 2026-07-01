"""E-LOOP-LEDGER S19(story 6208de76): manual outcome path — hypothesis 수동 해소가 GA4/
internal_ops와 동일한 다운스트림(HO-S4 verdict + S7 loop 귀속)을 타는지 검증.

핵심 증명: source='manual'(GA4/광고 통합 0개) 가설도 사람이 직접 transition_hypothesis로
verified/falsified 전이시키면 연결 loop이 실제로 closed된다 — "통합=자동화 업그레이드지
loop 완결의 전제조건 아님"을 실 DB round-trip으로 증명.

DB env(ALEMBIC_DATABASE_URL) 없으면 realdb 파트 skip.
"""
from __future__ import annotations

import os
import uuid
from datetime import datetime, timezone

import pytest
from sqlalchemy import select, text
from sqlalchemy.ext.asyncio import async_sessionmaker, create_async_engine

_RAW = os.environ.get("ALEMBIC_DATABASE_URL") or os.environ.get("PARITY_TEST_DATABASE_URL") or ""
_ASYNC = _RAW.replace("postgresql+psycopg2://", "postgresql+asyncpg://").replace(
    "postgresql://", "postgresql+asyncpg://"
)

pytestmark = pytest.mark.skipif(not _RAW, reason="real-DB URL 미설정 — skip")


@pytest.fixture
def anyio_backend():
    return "asyncio"


ORG = uuid.UUID("22000000-0000-0000-0000-000000000001")
PROJ = uuid.UUID("22000000-0000-0000-0000-000000000002")


async def _engine():
    eng = create_async_engine(_ASYNC)
    return eng, async_sessionmaker(eng, expire_on_commit=False)


async def _seed_org_project(s):
    for sql in [
        f"DELETE FROM projects WHERE org_id='{ORG}'",
        f"DELETE FROM organizations WHERE id='{ORG}'",
        f"INSERT INTO organizations (id,name,slug,plan) VALUES ('{ORG}','C22','c22org','free')",
        f"INSERT INTO projects (id,org_id,name) VALUES ('{PROJ}','{ORG}','P')",
    ]:
        await s.execute(text(sql))
    await s.commit()


async def _cleanup(s):
    for sql in [
        f"DELETE FROM loop_runs WHERE org_id='{ORG}'",
        f"DELETE FROM hypotheses WHERE org_id='{ORG}'",
    ]:
        await s.execute(text(sql))
    await s.commit()


async def _seed_manual_hypothesis(s, status="measuring") -> "object":
    from app.models.hypothesis import Hypothesis
    hyp = Hypothesis(
        id=uuid.uuid4(), org_id=ORG, project_id=PROJ, owner_member_id=uuid.uuid4(),
        statement="s", metric_definition={"metric": "revenue", "source": "manual", "target": 1000, "direction": "up"},
        measure_after=datetime(2026, 1, 1, tzinfo=timezone.utc), status=status,
    )
    s.add(hyp)
    await s.commit()
    await s.refresh(hyp)
    return hyp


async def _seed_loop(s, hypothesis_id, status="measuring") -> uuid.UUID:
    from app.repositories.loop import LoopRunRepository
    repo = LoopRunRepository(s, ORG)
    loop = await repo.create(
        project_id=PROJ, title="L", goal_tags=[], status=status,
        hypothesis_id=hypothesis_id, created_by_member_id=uuid.uuid4(),
    )
    await s.commit()
    return loop.id


async def _fetch_loop(s, loop_id):
    from app.models.loop import LoopRun
    return (await s.execute(select(LoopRun).where(LoopRun.id == loop_id))).scalar_one()


def _caller():
    from app.services.member_resolver import ResolvedMember
    return ResolvedMember(
        id=uuid.uuid4(), user_id=uuid.uuid4(), name="t", type="human", role="member", org_id=ORG,
    )


# ── 핵심: manual source가 GA4/internal_ops 통합 0개로도 loop을 닫는다 ─────────────

@pytest.mark.anyio
async def test_manual_verified_transition_closes_linked_measuring_loop_without_any_integration():
    from app.schemas.hypothesis import HypothesisTransition
    from app.services.hypothesis import transition_hypothesis

    eng, Session = await _engine()
    try:
        async with Session() as s:
            await _seed_org_project(s)
            await _cleanup(s)
            hyp = await _seed_manual_hypothesis(s)
            loop_id = await _seed_loop(s, hyp.id)

            await transition_hypothesis(
                s, ORG, _caller(), hyp.id,
                HypothesisTransition(status="verified", outcome_result={"actual_revenue": 1500}),
            )
            await s.commit()

            loop = await _fetch_loop(s, loop_id)
            assert loop.status == "closed"
            assert loop.outcome_attributed_at is not None
            assert loop.outcome_snapshot["hypothesis_status"] == "verified"
            assert loop.outcome_snapshot["outcome_result"] == {"actual_revenue": 1500}
    finally:
        await eng.dispose()


@pytest.mark.anyio
async def test_manual_falsified_transition_closes_linked_measuring_loop():
    from app.schemas.hypothesis import HypothesisTransition
    from app.services.hypothesis import transition_hypothesis

    eng, Session = await _engine()
    try:
        async with Session() as s:
            await _seed_org_project(s)
            await _cleanup(s)
            hyp = await _seed_manual_hypothesis(s)
            loop_id = await _seed_loop(s, hyp.id)

            await transition_hypothesis(
                s, ORG, _caller(), hyp.id,
                HypothesisTransition(status="falsified", outcome_result={"actual_revenue": 100}),
            )
            await s.commit()

            loop = await _fetch_loop(s, loop_id)
            assert loop.status == "closed"
            assert loop.outcome_snapshot["hypothesis_status"] == "falsified"
    finally:
        await eng.dispose()


# ── 격리: verified/falsified 아닌 target은 다운스트림 무영향 ───────────────────

@pytest.mark.anyio
async def test_transition_to_killed_does_not_touch_linked_loop():
    """killed는 verified/falsified가 아니므로 attribute_loop_outcome이 호출조차 안 되고,
    연결 loop은 measuring 그대로 남아야 한다(다운스트림 무영향 실증)."""
    from app.schemas.hypothesis import HypothesisTransition
    from app.services.hypothesis import transition_hypothesis

    eng, Session = await _engine()
    try:
        async with Session() as s:
            await _seed_org_project(s)
            await _cleanup(s)
            hyp = await _seed_manual_hypothesis(s, status="active")
            loop_id = await _seed_loop(s, hyp.id)

            await transition_hypothesis(
                s, ORG, _caller(), hyp.id, HypothesisTransition(status="killed", note="scrap"),
            )
            await s.commit()

            loop = await _fetch_loop(s, loop_id)
            assert loop.status == "measuring"
            assert loop.outcome_snapshot is None
    finally:
        await eng.dispose()


# ── loop 없어도 회귀 0(다운스트림 skip이 hypothesis 전이 자체를 막지 않음) ───────────

@pytest.mark.anyio
async def test_manual_verified_transition_with_no_linked_loop_still_succeeds():
    from app.schemas.hypothesis import HypothesisTransition
    from app.services.hypothesis import transition_hypothesis

    eng, Session = await _engine()
    try:
        async with Session() as s:
            await _seed_org_project(s)
            await _cleanup(s)
            hyp = await _seed_manual_hypothesis(s)

            out = await transition_hypothesis(
                s, ORG, _caller(), hyp.id,
                HypothesisTransition(status="verified", outcome_result={"actual": 1}),
            )
            await s.commit()
            assert out.status == "verified"
    finally:
        await eng.dispose()


# ── 재-해소 방지: 이미 closed된 loop은 재전이해도 불변 ──────────────────────────

@pytest.mark.anyio
async def test_transition_does_not_corrupt_already_closed_loop_snapshot():
    """S19 wiring이 attribute_loop_outcome의 기존 불변 가드(outcome_attributed_at)를 우회하지
    않는지 — 이미 closed된 loop에 재차 verified 전이(가정상 illegal이지만 서비스 함수 직접
    호출로 attribute_loop_outcome만 재확인)해도 스냅샷이 그대로인지."""
    from app.services.loop_outcome_attribution import attribute_loop_outcome

    eng, Session = await _engine()
    try:
        async with Session() as s:
            await _seed_org_project(s)
            await _cleanup(s)
            hyp = await _seed_manual_hypothesis(s, status="verified")
            loop_id = await _seed_loop(s, hyp.id)

            await attribute_loop_outcome(s, hyp)
            await s.commit()
            loop_v1 = await _fetch_loop(s, loop_id)
            snapshot_v1 = dict(loop_v1.outcome_snapshot)

            # 재호출(예: transition 재시도) — loop이 이미 closed(measuring 아님)라 no-op.
            result2 = await attribute_loop_outcome(s, hyp)
            await s.commit()
            assert result2 == {"skipped_reason": "no_measuring_loop", "attributed": []}

            loop_v2 = await _fetch_loop(s, loop_id)
            assert dict(loop_v2.outcome_snapshot) == snapshot_v1
    finally:
        await eng.dispose()
