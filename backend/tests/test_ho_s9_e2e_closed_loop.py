"""HO-S9: E-HO-TRUST 끝단 E2E 회귀 (가설→outcome→trust→게이트).

닫힌루프 1회전을 실 서비스(mock 최소)로 walk: 가설 active→story link→impl participation→PR
merge(CI pass)→**CI pass는 trust 미상승**→measure_after→scorer→verified/falsified→outcome
verdict(bet/execution)→trust는 outcome source만 반영→게이트가 outcome trust로 결정.

substance 회귀(epic의 thesis):
  · ②출하(CI pass) 자체는 신뢰를 올리지 않는다 — 가설이 적중해야 오른다.
  · ③falsified(나쁜 bet)는 owner의 bet만 벌하고 implementer execution은 보류(안 벌함).
  · ④falsified라도 사람이 bad_execution으로 귀속하면 execution trust에 반영된다.

[[reference_create_all_no_pgvector]] 실 PG 풀스키마.
"""
from __future__ import annotations

import os
import uuid
from datetime import datetime, timezone
from unittest.mock import AsyncMock, patch

import pytest

_REAL_DB_URL = os.getenv("PARITY_TEST_DATABASE_URL") or os.getenv("ALEMBIC_DATABASE_URL")

pytestmark = pytest.mark.skipif(
    not _REAL_DB_URL, reason="real Postgres 필요(PARITY/ALEMBIC_DATABASE_URL)"
)

_PAST = datetime(2026, 6, 1, tzinfo=timezone.utc)


@pytest.fixture
def anyio_backend():
    return "asyncio"


def _engine():
    from sqlalchemy.ext.asyncio import create_async_engine

    url = _REAL_DB_URL.replace("postgresql+psycopg2://", "postgresql+asyncpg://").replace(
        "postgresql://", "postgresql+asyncpg://"
    )
    return create_async_engine(url)


async def _seed(s, *, org, project, impl_member, owner_member, impl_role, bet_role,
                story_id, hyp_id, story_done, target):
    """닫힌루프 그래프 시드. story_done=True면 100%→verified·False면 0%→falsified(target=50/up)."""
    from sqlalchemy import text as _text

    from app.models.hypothesis import Hypothesis, HypothesisStoryLink
    from app.models.participation import Participation, ParticipationRole
    from app.models.pm import Story
    from app.services.hypothesis_outcome_verdict import BET_ROLE_KEY

    await s.execute(_text("SET session_replication_role = replica"))
    s.add_all([
        ParticipationRole(id=impl_role, org_id=org, key="implementation", label="구현", is_default=True),
        ParticipationRole(id=bet_role, org_id=org, key=BET_ROLE_KEY, label="가설책임", is_default=False),
        Story(id=story_id, org_id=org, project_id=project, title="S",
              status="done" if story_done else "in_progress", story_points=3),
        Participation(id=uuid.uuid4(), org_id=org, story_id=story_id, member_id=impl_member, role_id=impl_role),
        Hypothesis(id=hyp_id, org_id=org, project_id=project, owner_member_id=owner_member,
                   statement="H", measure_after=_PAST, status="active",
                   metric_definition={"metric": "completion_pct", "source": "internal_ops",
                                      "target": target, "direction": "up"}),
        HypothesisStoryLink(id=uuid.uuid4(), hypothesis_id=hyp_id, story_id=story_id, link_type="supports"),
    ])
    await s.commit()


async def _impl_outcome(s, org, member):
    """implementation 역할의 outcome 신뢰 표본(resolved/hit/hit_rate)."""
    from app.services.trust_score import compute_member_trust_scores

    t = await compute_member_trust_scores(s, org, member, role_key="implementation")
    return t


async def _bet_outcome(s, org, member):
    from app.services.trust_score import compute_member_trust_scores

    return await compute_member_trust_scores(s, org, member, role_key="hypothesis_owner")


# ── AC①②: verified 전체 체인 — CI pass는 trust 미상승, verified가 올린다 ──────────

@pytest.mark.anyio
async def test_verified_chain_ci_pass_does_not_raise_trust():
    from sqlalchemy import text as _text
    from sqlalchemy.ext.asyncio import async_sessionmaker

    from app.core.database import Base
    import app.models  # noqa: F401
    from app.models.gate import Gate  # noqa: F401 — capture가 resolve_gate_from_verdict로 gate 테이블 조회.
    from app.services.hypothesis_scorer import score_hypotheses
    from app.services.verdict_capture import capture_pr_ci_verdict

    eng = _engine()
    org, project = uuid.uuid4(), uuid.uuid4()
    impl_member, owner_member = uuid.uuid4(), uuid.uuid4()
    impl_role, bet_role = uuid.uuid4(), uuid.uuid4()
    story_id, hyp_id = uuid.uuid4(), uuid.uuid4()

    async with eng.begin() as c:
        await c.run_sync(Base.metadata.create_all)
    S = async_sessionmaker(eng, expire_on_commit=False)
    try:
        async with S() as s:
            await _seed(s, org=org, project=project, impl_member=impl_member, owner_member=owner_member,
                        impl_role=impl_role, bet_role=bet_role, story_id=story_id, hyp_id=hyp_id,
                        story_done=True, target=50)

        # 1) PR merge + CI pass → ci verdict 기록.
        with patch("app.services.verdict_capture.fetch_pr_review_rounds", AsyncMock(return_value=0)):
            async with S() as s:
                await s.execute(_text("SET session_replication_role = replica"))
                await capture_pr_ci_verdict(s, org, story_id, 7, "o/r", merged=True, ci_result="pass")
                await s.commit()

        # 2) AC②: CI pass는 outcome trust를 올리지 않는다(ci ∉ OUTCOME_SOURCES).
        async with S() as s:
            t = await _impl_outcome(s, org, impl_member)
            assert t["resolved"] == 0 and t["hypothesis_hit_rate"] is None, "CI pass가 trust를 올리면 안 됨"
            assert t["source_breakdown"].get("ci", 0) >= 1  # 출하 자체는 관측됨.

        # 3) measure_after 도래 → scorer → verified → outcome verdict(bet/execution).
        async with S() as s:
            await s.execute(_text("SET session_replication_role = replica"))
            summary = await score_hypotheses(s)
            await s.commit()
            assert str(hyp_id) in summary["verified"]
            assert summary["verdicts_recorded"], summary

        # 4) 이제 implementer execution trust가 오른다(verified→execution pass).
        async with S() as s:
            t = await _impl_outcome(s, org, impl_member)
            assert t["resolved"] == 1 and t["hit"] == 1 and t["hypothesis_hit_rate"] == 1.0
            b = await _bet_outcome(s, org, owner_member)
            assert b["resolved"] == 1 and b["hit"] == 1  # owner bet도 적중(pass).
    finally:
        async with eng.begin() as c:
            await c.run_sync(Base.metadata.drop_all)
        await eng.dispose()


# ── AC③: falsified(나쁜 bet)는 implementer를 벌하지 않는다 ───────────────────────

@pytest.mark.anyio
async def test_falsified_bad_bet_spares_implementer():
    from sqlalchemy import text as _text
    from sqlalchemy.ext.asyncio import async_sessionmaker

    from app.core.database import Base
    import app.models  # noqa: F401
    from app.services.hypothesis_scorer import score_hypotheses

    eng = _engine()
    org, project = uuid.uuid4(), uuid.uuid4()
    impl_member, owner_member = uuid.uuid4(), uuid.uuid4()
    impl_role, bet_role = uuid.uuid4(), uuid.uuid4()
    story_id, hyp_id = uuid.uuid4(), uuid.uuid4()

    async with eng.begin() as c:
        await c.run_sync(Base.metadata.create_all)
    S = async_sessionmaker(eng, expire_on_commit=False)
    try:
        async with S() as s:
            # story 미완료(0%) + target=50 → miss → falsified.
            await _seed(s, org=org, project=project, impl_member=impl_member, owner_member=owner_member,
                        impl_role=impl_role, bet_role=bet_role, story_id=story_id, hyp_id=hyp_id,
                        story_done=False, target=50)
        async with S() as s:
            await s.execute(_text("SET session_replication_role = replica"))
            summary = await score_hypotheses(s)
            await s.commit()
            assert str(hyp_id) in summary["falsified"]

        async with S() as s:
            # implementer execution: falsified→None(보류) → resolved 0(안 벌함·AC③).
            t = await _impl_outcome(s, org, impl_member)
            assert t["resolved"] == 0 and t["pending"] >= 1, "falsified가 implementer를 벌하면 안 됨"
            # owner bet: falsified→fail → 벌점 반영.
            b = await _bet_outcome(s, org, owner_member)
            assert b["resolved"] == 1 and b["hit"] == 0 and b["hypothesis_hit_rate"] == 0.0
    finally:
        async with eng.begin() as c:
            await c.run_sync(Base.metadata.drop_all)
        await eng.dispose()


# ── AC④: falsified라도 사람이 bad_execution 귀속하면 execution trust 반영 ─────────

@pytest.mark.anyio
async def test_falsified_bad_execution_attribution_reflects():
    from sqlalchemy import text as _text
    from sqlalchemy.ext.asyncio import async_sessionmaker

    from app.core.database import Base
    import app.models  # noqa: F401
    from app.services.hypothesis_scorer import score_hypotheses
    from app.services.hypothesis_outcome_verdict import EXECUTION_SOURCE
    from app.services.verdict_capture import resolve_implementation_participation
    from app.services.verdict_recorder import record_verdict

    eng = _engine()
    org, project = uuid.uuid4(), uuid.uuid4()
    impl_member, owner_member = uuid.uuid4(), uuid.uuid4()
    impl_role, bet_role = uuid.uuid4(), uuid.uuid4()
    story_id, hyp_id = uuid.uuid4(), uuid.uuid4()

    async with eng.begin() as c:
        await c.run_sync(Base.metadata.create_all)
    S = async_sessionmaker(eng, expire_on_commit=False)
    try:
        async with S() as s:
            await _seed(s, org=org, project=project, impl_member=impl_member, owner_member=owner_member,
                        impl_role=impl_role, bet_role=bet_role, story_id=story_id, hyp_id=hyp_id,
                        story_done=False, target=50)
        async with S() as s:
            await s.execute(_text("SET session_replication_role = replica"))
            await score_hypotheses(s)  # → falsified, execution None(보류).
            await s.commit()

        # 사람 post-review attribution: bad_execution → execution fail로 확정(record_verdict upsert).
        async with S() as s:
            await s.execute(_text("SET session_replication_role = replica"))
            impl = await resolve_implementation_participation(s, org, story_id)
            await record_verdict(s, org, impl.id, EXECUTION_SOURCE, "fail")
            await s.commit()

        async with S() as s:
            # 이제 execution trust에 반영(resolved 1·hit 0·hit_rate 0)=AC④.
            t = await _impl_outcome(s, org, impl_member)
            assert t["resolved"] == 1 and t["hit"] == 0 and t["hypothesis_hit_rate"] == 0.0
    finally:
        async with eng.begin() as c:
            await c.run_sync(Base.metadata.drop_all)
        await eng.dispose()
