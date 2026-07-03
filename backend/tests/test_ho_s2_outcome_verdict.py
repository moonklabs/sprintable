"""HO-S2: hypothesis outcome→verdict 배선 테스트(키스톤).

verified→bet pass+execution pass·falsified→bet fail+execution None·measuring skip·linked 없으면 skip·
impl/bet participation 독립 skip·멱등. 단위(mock) + 실DB.
"""
from __future__ import annotations

import os
import uuid
from types import SimpleNamespace
from unittest.mock import AsyncMock, MagicMock, patch

import pytest
from sqlalchemy import select

from app.services import hypothesis_outcome_verdict as mod
from app.services.hypothesis_outcome_verdict import (
    BET_SOURCE,
    EXECUTION_SOURCE,
    record_outcome_verdicts,
)

_REAL_DB_URL = os.getenv("PARITY_TEST_DATABASE_URL") or os.getenv("ALEMBIC_DATABASE_URL")

# story 8236bbc3: create_all/drop_all로 자체 스키마 직접 관리 — 공유 alembic-migrated DB
# 오염 방지 위해 격리 DB 전용(conftest.py 가드가 마커 누락을 자동 검출).
pytestmark = pytest.mark.destructive_schema


@pytest.fixture
def anyio_backend():
    return "asyncio"


def _hyp(status="verified", owner=None, confirmed_by=None):
    return SimpleNamespace(
        id=uuid.uuid4(), org_id=uuid.uuid4(), status=status,
        owner_member_id=owner or uuid.uuid4(), confirmed_by_member_id=confirmed_by,
    )


def _session_with_links(story_ids):
    s = AsyncMock()
    res = MagicMock()
    res.scalars.return_value.all.return_value = story_ids
    s.execute = AsyncMock(return_value=res)
    return s


def _patches(*, impl=True, bet=True):
    impl_part = SimpleNamespace(id=uuid.uuid4()) if impl else None
    bet_part = SimpleNamespace(id=uuid.uuid4()) if bet else None
    rv = AsyncMock()
    return (
        patch.object(mod, "resolve_implementation_participation", AsyncMock(return_value=impl_part)),
        patch.object(mod, "ensure_review_participation", AsyncMock(return_value=bet_part)),
        patch.object(mod, "record_verdict", rv),
        rv, impl_part, bet_part,
    )


# ── AC④: 미해소 가설 verdict 0 ─────────────────────────────────────────────────

@pytest.mark.anyio
async def test_measuring_records_nothing():
    p1, p2, p3, rv, *_ = _patches()
    with p1, p2, p3:
        out = await record_outcome_verdicts(AsyncMock(), _hyp("measuring"))
    assert out["skipped_reason"] == "not_resolved"
    rv.assert_not_awaited()


@pytest.mark.anyio
async def test_active_records_nothing():
    p1, p2, p3, rv, *_ = _patches()
    with p1, p2, p3:
        out = await record_outcome_verdicts(AsyncMock(), _hyp("active"))
    assert out["skipped_reason"] == "not_resolved" and not rv.await_count


# ── AC②: linked story 없으면 skip ─────────────────────────────────────────────

@pytest.mark.anyio
async def test_no_linked_story_skips():
    p1, p2, p3, rv, *_ = _patches()
    with p1, p2, p3:
        out = await record_outcome_verdicts(_session_with_links([]), _hyp("verified"))
    assert out["skipped_reason"] == "no_linked_story"
    rv.assert_not_awaited()


# ── verified → bet pass + execution pass ──────────────────────────────────────

@pytest.mark.anyio
async def test_verified_records_bet_pass_and_execution_pass():
    sid = uuid.uuid4()
    p1, p2, p3, rv, impl_part, bet_part = _patches()
    h = _hyp("verified")
    with p1, p2, p3:
        out = await record_outcome_verdicts(_session_with_links([sid]), h)
    calls = {(c.args[2], c.args[3], c.args[4]) for c in rv.await_args_list}  # (pid, source, result)
    assert (impl_part.id, EXECUTION_SOURCE, "pass") in calls
    assert (bet_part.id, BET_SOURCE, "pass") in calls
    assert out["bet_result"] == "pass" and out["execution_result"] == "pass"


# ── falsified → bet fail + execution None(보류) ───────────────────────────────

@pytest.mark.anyio
async def test_falsified_bet_fail_execution_none():
    sid = uuid.uuid4()
    p1, p2, p3, rv, impl_part, bet_part = _patches()
    with p1, p2, p3:
        out = await record_outcome_verdicts(_session_with_links([sid]), _hyp("falsified"))
    calls = {(c.args[2], c.args[3], c.args[4]) for c in rv.await_args_list}
    assert (impl_part.id, EXECUTION_SOURCE, None) in calls  # falsified→execution 보류.
    assert (bet_part.id, BET_SOURCE, "fail") in calls
    assert out["execution_result"] is None and out["bet_result"] == "fail"


# ── AC③: impl/bet participation 독립 skip ─────────────────────────────────────

@pytest.mark.anyio
async def test_impl_missing_skips_execution_keeps_bet():
    sid = uuid.uuid4()
    p1, p2, p3, rv, _impl, bet_part = _patches(impl=False)  # impl participation 없음.
    with p1, p2, p3:
        out = await record_outcome_verdicts(_session_with_links([sid]), _hyp("verified"))
    sources = {c.args[3] for c in rv.await_args_list}
    assert EXECUTION_SOURCE not in sources and BET_SOURCE in sources  # execution skip·bet 기록.
    assert out["execution"] == [] and out["bet"]


@pytest.mark.anyio
async def test_bet_role_unseeded_skips_bet_keeps_execution():
    sid = uuid.uuid4()
    p1, p2, p3, rv, impl_part, _bet = _patches(bet=False)  # bet role 미시드→ensure None.
    with p1, p2, p3:
        out = await record_outcome_verdicts(_session_with_links([sid]), _hyp("verified"))
    sources = {c.args[3] for c in rv.await_args_list}
    assert BET_SOURCE not in sources and EXECUTION_SOURCE in sources
    assert out["bet"] == [] and out["execution"]


# ── owner + confirmed_by 모두 bet, 중복 제거 ──────────────────────────────────

@pytest.mark.anyio
async def test_owner_and_confirmed_by_both_bet_deduped():
    sid = uuid.uuid4()
    owner, confirmer = uuid.uuid4(), uuid.uuid4()
    p1, p3, rv = (
        patch.object(mod, "resolve_implementation_participation", AsyncMock(return_value=None)),
        patch.object(mod, "record_verdict", AsyncMock()),
        None,
    )
    ensure = AsyncMock(side_effect=lambda *a, **k: SimpleNamespace(id=uuid.uuid4()))
    with p1, patch.object(mod, "ensure_review_participation", ensure), p3:
        await record_outcome_verdicts(_session_with_links([sid]), _hyp("verified", owner=owner, confirmed_by=confirmer))
    # owner·confirmed_by 각각 ensure 호출(distinct member).
    called_members = {c.args[3] for c in ensure.await_args_list}
    assert owner in called_members and confirmer in called_members

    # owner==confirmed_by면 1회만.
    ensure2 = AsyncMock(return_value=SimpleNamespace(id=uuid.uuid4()))
    with patch.object(mod, "resolve_implementation_participation", AsyncMock(return_value=None)), \
         patch.object(mod, "ensure_review_participation", ensure2), \
         patch.object(mod, "record_verdict", AsyncMock()):
        await record_outcome_verdicts(_session_with_links([sid]), _hyp("verified", owner=owner, confirmed_by=owner))
    assert ensure2.await_count == 1  # 중복 제거.


# ── 실DB E2E: verified 가설 → 실 verdict 2건(bet pass + execution pass) ────────

@pytest.mark.skipif(not _REAL_DB_URL, reason="real Postgres 필요(PARITY/ALEMBIC_DATABASE_URL)")
@pytest.mark.anyio
async def test_outcome_verdicts_real_db():
    from sqlalchemy import text as _text
    from sqlalchemy.ext.asyncio import async_sessionmaker, create_async_engine

    from app.core.database import Base
    import app.models  # noqa: F401
    from app.models.hypothesis import Hypothesis, HypothesisStoryLink
    from app.models.participation import Participation, ParticipationRole
    from app.models.pm import Story
    from app.models.verdict import Verdict  # noqa: F401
    from app.services.hypothesis_outcome_verdict import BET_ROLE_KEY

    url = _REAL_DB_URL.replace("postgresql+psycopg2://", "postgresql+asyncpg://").replace(
        "postgresql://", "postgresql+asyncpg://"
    )
    engine = create_async_engine(url)
    from datetime import datetime, timezone
    org, project, story_id = uuid.uuid4(), uuid.uuid4(), uuid.uuid4()
    owner, impl_member, impl_role, bet_role, hyp_id = (uuid.uuid4() for _ in range(5))

    async with engine.begin() as conn:
        await conn.run_sync(Base.metadata.create_all)
    Session = async_sessionmaker(engine, expire_on_commit=False)
    try:
        async with Session() as s:
            await s.execute(_text("SET session_replication_role = replica"))
            s.add_all([
                ParticipationRole(id=impl_role, org_id=org, key="implementation", label="구현", is_default=True),
                ParticipationRole(id=bet_role, org_id=org, key=BET_ROLE_KEY, label="가설책임", is_default=False),
                Story(id=story_id, org_id=org, project_id=project, title="S", status="done", story_points=3),
                Participation(id=uuid.uuid4(), org_id=org, story_id=story_id, member_id=impl_member, role_id=impl_role),
                Hypothesis(id=hyp_id, org_id=org, project_id=project, owner_member_id=owner,
                           statement="H", metric_definition={"metric": "x", "source": "manual", "target": 1, "direction": "up"},
                           measure_after=datetime(2026, 6, 1, tzinfo=timezone.utc), status="verified"),
                HypothesisStoryLink(id=uuid.uuid4(), hypothesis_id=hyp_id, story_id=story_id, link_type="supports"),
            ])
            await s.commit()

        async with Session() as s:
            await s.execute(_text("SET session_replication_role = replica"))
            hyp = (await s.execute(select(Hypothesis).where(Hypothesis.id == hyp_id))).scalar_one()
            out = await record_outcome_verdicts(s, hyp)
            await s.commit()
            assert len(out["execution"]) == 1 and len(out["bet"]) == 1

        async with Session() as s:
            rows = dict((await s.execute(
                _text("SELECT source, result FROM verdict WHERE org_id=:o"), {"o": org}
            )).all())
        # verified → bet pass + execution pass 실기록.
        assert rows[BET_SOURCE] == "pass"
        assert rows[EXECUTION_SOURCE] == "pass"
    finally:
        async with engine.begin() as conn:
            await conn.run_sync(Base.metadata.drop_all)
        await engine.dispose()

