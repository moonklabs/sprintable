"""E-LOOP-LEDGER S7(story acdd92eb): hypothesis 해소 → loop outcome 귀속 배선 검증.

hypothesis_outcome_verdict.record_outcome_verdicts(HO-S4)와 동형 패턴 — 격리(비-tautological,
happy-path만이 아님)·idempotent·immutable을 실 DB round-trip으로 검증한다.

DB env(ALEMBIC_DATABASE_URL) 없으면 realdb 파트 skip.
"""
from __future__ import annotations

import os
import uuid
from datetime import datetime, timezone
from types import SimpleNamespace

import pytest
from sqlalchemy import select, text
from sqlalchemy.ext.asyncio import async_sessionmaker, create_async_engine

from app.services.loop_outcome_attribution import attribute_loop_outcome

_RAW = os.environ.get("ALEMBIC_DATABASE_URL") or os.environ.get("PARITY_TEST_DATABASE_URL") or ""
_ASYNC = _RAW.replace("postgresql+psycopg2://", "postgresql+asyncpg://").replace(
    "postgresql://", "postgresql+asyncpg://"
)


@pytest.fixture
def anyio_backend():
    return "asyncio"


# ── 유닛(DB 불요): not_resolved 게이팅 ────────────────────────────────────────

@pytest.mark.anyio
@pytest.mark.parametrize("status", ["proposed", "active", "measuring", "killed", "archived"])
async def test_unresolved_status_skips_without_touching_db(status):
    """verified/falsified가 아닌 전 상태는 DB 조회조차 없이 즉시 skip — session.execute가
    호출되면 이 mock은 AttributeError로 즉시 실패한다(happy-path만이 아닌 실 게이팅 증명)."""
    hyp = SimpleNamespace(id=uuid.uuid4(), status=status, outcome_result=None)
    session = object()  # execute 속성 자체가 없음 — 호출되면 즉시 AttributeError.
    result = await attribute_loop_outcome(session, hyp)
    assert result == {"skipped_reason": "not_resolved", "attributed": []}


# ── realdb ───────────────────────────────────────────────────────────────────

pytestmark_db = pytest.mark.skipif(not _RAW, reason="real-DB URL 미설정 — skip")

ORG = uuid.UUID("20000000-0000-0000-0000-000000000001")
PROJ = uuid.UUID("20000000-0000-0000-0000-000000000002")


async def _engine():
    eng = create_async_engine(_ASYNC)
    return eng, async_sessionmaker(eng, expire_on_commit=False)


async def _seed_org_project(s):
    for sql in [
        f"DELETE FROM projects WHERE org_id='{ORG}'",
        f"DELETE FROM organizations WHERE id='{ORG}'",
        f"INSERT INTO organizations (id,name,slug,plan) VALUES ('{ORG}','C2O','c2oorg','free')",
        f"INSERT INTO projects (id,org_id,name) VALUES ('{PROJ}','{ORG}','P')",
    ]:
        await s.execute(text(sql))
    await s.commit()


async def _seed_hypothesis(s, status, outcome_result=None):
    from app.models.hypothesis import Hypothesis
    hyp = Hypothesis(
        id=uuid.uuid4(), org_id=ORG, project_id=PROJ, owner_member_id=uuid.uuid4(),
        statement="s", metric_definition={"metric": "m", "source": "manual", "target": 1, "direction": "up"},
        measure_after=datetime(2026, 1, 1, tzinfo=timezone.utc), status=status,
        outcome_result=outcome_result,
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


async def _cleanup(s):
    for sql in [
        f"DELETE FROM loop_runs WHERE org_id='{ORG}'",
        f"DELETE FROM hypotheses WHERE org_id='{ORG}'",
    ]:
        await s.execute(text(sql))
    await s.commit()


# ── happy path: verified/falsified 양쪽 ───────────────────────────────────────

@pytestmark_db
@pytest.mark.anyio
async def test_verified_hypothesis_attributes_measuring_loop_and_closes_it():
    eng, Session = await _engine()
    try:
        async with Session() as s:
            await _seed_org_project(s)
            await _cleanup(s)
            hyp = await _seed_hypothesis(s, "verified", outcome_result={"actual": 120})
            loop_id = await _seed_loop(s, hyp.id)

            result = await attribute_loop_outcome(s, hyp)
            await s.commit()
            assert result["attributed"] == [str(loop_id)]

            loop = await _fetch_loop(s, loop_id)
            assert loop.status == "closed"
            assert loop.outcome_attributed_at is not None
            assert loop.outcome_snapshot == {
                "hypothesis_id": str(hyp.id),
                "hypothesis_status": "verified",
                "outcome_result": {"actual": 120},
                "attributed_at": loop.outcome_attributed_at.isoformat(),
            }
    finally:
        await eng.dispose()


@pytestmark_db
@pytest.mark.anyio
async def test_falsified_hypothesis_attributes_and_closes_loop():
    eng, Session = await _engine()
    try:
        async with Session() as s:
            await _seed_org_project(s)
            await _cleanup(s)
            hyp = await _seed_hypothesis(s, "falsified", outcome_result={"actual": 5})
            loop_id = await _seed_loop(s, hyp.id)

            result = await attribute_loop_outcome(s, hyp)
            await s.commit()
            assert result["attributed"] == [str(loop_id)]

            loop = await _fetch_loop(s, loop_id)
            assert loop.status == "closed"
            assert loop.outcome_snapshot["hypothesis_status"] == "falsified"
    finally:
        await eng.dispose()


# ── 격리(비-tautological): 잘못된 상태서 outcome_snapshot 안 채워짐 ─────────────

@pytestmark_db
@pytest.mark.anyio
async def test_active_hypothesis_does_not_attribute_measuring_loop():
    """manual/active(미해소) 가설은 measuring loop이 있어도 귀속 0 — snapshot/attributed_at
    둘 다 None으로 남는지, status도 measuring 그대로인지까지 확인(단순 return값만 X)."""
    eng, Session = await _engine()
    try:
        async with Session() as s:
            await _seed_org_project(s)
            await _cleanup(s)
            hyp = await _seed_hypothesis(s, "active")
            loop_id = await _seed_loop(s, hyp.id)

            result = await attribute_loop_outcome(s, hyp)
            await s.commit()
            assert result == {"skipped_reason": "not_resolved", "attributed": []}

            loop = await _fetch_loop(s, loop_id)
            assert loop.status == "measuring"
            assert loop.outcome_attributed_at is None
            assert loop.outcome_snapshot is None
    finally:
        await eng.dispose()


@pytestmark_db
@pytest.mark.anyio
async def test_measuring_hypothesis_does_not_attribute():
    eng, Session = await _engine()
    try:
        async with Session() as s:
            await _seed_org_project(s)
            await _cleanup(s)
            hyp = await _seed_hypothesis(s, "measuring")
            loop_id = await _seed_loop(s, hyp.id)

            result = await attribute_loop_outcome(s, hyp)
            await s.commit()
            assert result["skipped_reason"] == "not_resolved"

            loop = await _fetch_loop(s, loop_id)
            assert loop.outcome_snapshot is None
    finally:
        await eng.dispose()


@pytestmark_db
@pytest.mark.anyio
async def test_verified_hypothesis_with_loop_not_in_measuring_skips():
    """loop이 executing(measuring 아님)이면 hypothesis가 verified여도 귀속 0 — executing→measuring
    전이 배선 갭(별도 스토리 스코프) 전제에서 안전하게 no-op함을 확인."""
    eng, Session = await _engine()
    try:
        async with Session() as s:
            await _seed_org_project(s)
            await _cleanup(s)
            hyp = await _seed_hypothesis(s, "verified", outcome_result={"actual": 1})
            loop_id = await _seed_loop(s, hyp.id, status="executing")

            result = await attribute_loop_outcome(s, hyp)
            await s.commit()
            assert result == {"skipped_reason": "no_measuring_loop", "attributed": []}

            loop = await _fetch_loop(s, loop_id)
            assert loop.status == "executing"
            assert loop.outcome_snapshot is None
    finally:
        await eng.dispose()


# ── idempotent + immutable ────────────────────────────────────────────────────

@pytestmark_db
@pytest.mark.anyio
async def test_already_attributed_loop_stays_immutable_on_second_call():
    """이미 attributed된 loop을 재호출해도 outcome_snapshot이 바뀌지 않는다(불변) — status가
    이미 closed(measuring 아님)라 자연 필터로도 걸리지만, outcome_attributed_at 가드로 이중 방어."""
    eng, Session = await _engine()
    try:
        async with Session() as s:
            await _seed_org_project(s)
            await _cleanup(s)
            hyp = await _seed_hypothesis(s, "verified", outcome_result={"actual": 1})
            loop_id = await _seed_loop(s, hyp.id)

            await attribute_loop_outcome(s, hyp)
            await s.commit()
            loop_v1 = await _fetch_loop(s, loop_id)
            snapshot_v1 = dict(loop_v1.outcome_snapshot)
            attributed_at_v1 = loop_v1.outcome_attributed_at

            # 재호출 — loop이 이미 closed(measuring 아님)라 no_measuring_loop로 skip.
            result2 = await attribute_loop_outcome(s, hyp)
            await s.commit()
            assert result2 == {"skipped_reason": "no_measuring_loop", "attributed": []}

            loop_v2 = await _fetch_loop(s, loop_id)
            assert dict(loop_v2.outcome_snapshot) == snapshot_v1
            assert loop_v2.outcome_attributed_at == attributed_at_v1
    finally:
        await eng.dispose()


@pytestmark_db
@pytest.mark.anyio
async def test_manually_reopened_measuring_loop_with_prior_attribution_guarded_by_flag():
    """outcome_attributed_at이 이미 세팅된 채로(방어적 시나리오) status만 measuring으로 되돌려도
    attribute_loop_outcome은 그 loop을 재-스탬프하지 않는다(불변 가드가 status 필터와 독립적으로 동작)."""
    eng, Session = await _engine()
    try:
        async with Session() as s:
            await _seed_org_project(s)
            await _cleanup(s)
            hyp = await _seed_hypothesis(s, "verified", outcome_result={"actual": 1})
            loop_id = await _seed_loop(s, hyp.id)
            await attribute_loop_outcome(s, hyp)
            await s.commit()
            loop_v1 = await _fetch_loop(s, loop_id)
            original_snapshot = dict(loop_v1.outcome_snapshot)

            # 방어적 시나리오 시뮬레이션: status를 measuring으로 되돌림(outcome_attributed_at은 유지).
            from app.repositories.loop import LoopRunRepository
            await LoopRunRepository(s, ORG).update(loop_id, status="measuring")
            await s.commit()

            result = await attribute_loop_outcome(s, hyp)
            await s.commit()
            assert result["attributed"] == []
            assert str(loop_id) in result.get("already_attributed", [])

            loop_v2 = await _fetch_loop(s, loop_id)
            assert dict(loop_v2.outcome_snapshot) == original_snapshot
    finally:
        await eng.dispose()


# ── 다중 loop 동시 귀속 ────────────────────────────────────────────────────────

@pytestmark_db
@pytest.mark.anyio
async def test_multiple_measuring_loops_linked_to_same_hypothesis_all_attributed():
    eng, Session = await _engine()
    try:
        async with Session() as s:
            await _seed_org_project(s)
            await _cleanup(s)
            hyp = await _seed_hypothesis(s, "verified", outcome_result={"actual": 1})
            loop1 = await _seed_loop(s, hyp.id)
            loop2 = await _seed_loop(s, hyp.id)

            result = await attribute_loop_outcome(s, hyp)
            await s.commit()
            assert set(result["attributed"]) == {str(loop1), str(loop2)}

            for lid in (loop1, loop2):
                loop = await _fetch_loop(s, lid)
                assert loop.status == "closed"
    finally:
        await eng.dispose()


# ── 까심 QA CRITICAL(#1818) — org_id defense-in-depth(cross-org 유출 근본 2차 방어) ──

OTHER_ORG = uuid.UUID("20000000-0000-0000-0000-0000000000ee")
OTHER_PROJ = uuid.UUID("20000000-0000-0000-0000-0000000000ef")


@pytestmark_db
@pytest.mark.anyio
async def test_cross_org_loop_not_attributed_org_scope_defense():
    """근본 fix는 create_loop(S3)의 hypothesis 소유검증이지만, 여기서는 그 가드를 우회해
    (레거시 데이터/미래 버그 가정) 타 org의 loop이 이 hypothesis_id를 참조하는 상황을 직접
    구성해 attribute_loop_outcome 쿼리의 org_id 필터가 독립적으로 유출을 막는지 실증한다."""
    eng, Session = await _engine()
    try:
        async with Session() as s:
            await _seed_org_project(s)
            await _cleanup(s)
            for sql in [
                f"DELETE FROM loop_runs WHERE org_id='{OTHER_ORG}'",
                f"DELETE FROM projects WHERE org_id='{OTHER_ORG}'",
                f"DELETE FROM organizations WHERE id='{OTHER_ORG}'",
                f"INSERT INTO organizations (id,name,slug,plan) VALUES ('{OTHER_ORG}','C2X','c2xorg','free')",
                f"INSERT INTO projects (id,org_id,name) VALUES ('{OTHER_PROJ}','{OTHER_ORG}','OP')",
            ]:
                await s.execute(text(sql))
            await s.commit()

            hyp = await _seed_hypothesis(s, "verified", outcome_result={"secret": "org-A-revenue"})
            from app.repositories.loop import LoopRunRepository
            other_loop = await LoopRunRepository(s, OTHER_ORG).create(
                project_id=OTHER_PROJ, title="leak-target", goal_tags=[], status="measuring",
                hypothesis_id=hyp.id, created_by_member_id=uuid.uuid4(),
            )
            await s.commit()

            result = await attribute_loop_outcome(s, hyp)
            await s.commit()
            assert result == {"skipped_reason": "no_measuring_loop", "attributed": []}

            fetched = await _fetch_loop(s, other_loop.id)
            assert fetched.status == "measuring"
            assert fetched.outcome_snapshot is None
    finally:
        await eng.dispose()


# ── 통합: score_hypotheses 배선 경유 ──────────────────────────────────────────

@pytestmark_db
@pytest.mark.anyio
async def test_score_hypotheses_wires_loop_attribution_end_to_end():
    from unittest.mock import patch

    from app.models.hypothesis import Hypothesis
    from app.services import hypothesis_scorer as sc

    eng, Session = await _engine()
    try:
        async with Session() as s:
            await _seed_org_project(s)
            await _cleanup(s)
            hyp = Hypothesis(
                id=uuid.uuid4(), org_id=ORG, project_id=PROJ, owner_member_id=uuid.uuid4(),
                statement="s", metric_definition={"metric": "m", "source": "ga4", "target": 1, "direction": "up"},
                measure_after=datetime(2020, 1, 1, tzinfo=timezone.utc), status="active",
            )
            s.add(hyp)
            await s.commit()
            loop_id = await _seed_loop(s, hyp.id)

            with patch.object(
                sc, "score_ga4_outcome",
                return_value={"outcome_status": "hit", "outcome_result": {"actual": 5}},
            ), patch(
                "app.services.hypothesis_outcome_verdict.record_outcome_verdicts",
                return_value={"skipped_reason": "no_linked_story", "bet": [], "execution": []},
            ):
                summary = await sc.score_hypotheses(s)
            await s.commit()

            assert str(hyp.id) in summary["verified"]
            assert summary["loops_attributed"] == [{"hypothesis_id": str(hyp.id), "loop_ids": [str(loop_id)]}]

            loop = await _fetch_loop(s, loop_id)
            assert loop.status == "closed"
    finally:
        await eng.dispose()
