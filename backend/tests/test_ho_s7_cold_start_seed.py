"""HO-S7: cold-start human seed 기록 + calibration.

cold-start(outcome 표본 부족)에서 사람의 keep/kill 결정을 seed로 기록(trust 본점수 미포함·AC②),
outcome 해소 후 calibration 계산(AC③). verdict source 재사용·마이그 0(AC⑤).
"""
from __future__ import annotations

import os
import uuid
from types import SimpleNamespace
from unittest.mock import AsyncMock, patch

import pytest

from app.services.cold_start_seed import SEED_SOURCE, _is_cold_start, record_cold_start_seed

_REAL_DB_URL = os.getenv("PARITY_TEST_DATABASE_URL") or os.getenv("ALEMBIC_DATABASE_URL")


@pytest.fixture
def anyio_backend():
    return "asyncio"


def _gate(*, gate_type="merge", work_item_type="story", facts=None):
    return SimpleNamespace(
        gate_type=gate_type, work_item_type=work_item_type,
        work_item_id=uuid.uuid4(), neutral_facts=facts,
    )


# ── _is_cold_start 판정 ─────────────────────────────────────────────────────────

def test_is_cold_start_true_when_sample_below_min():
    assert _is_cold_start(_gate(facts={"outcome_resolved": 1, "min_outcome_sample": 3})) is True


def test_is_cold_start_false_when_sufficient():
    assert _is_cold_start(_gate(facts={"outcome_resolved": 5, "min_outcome_sample": 3})) is False


def test_is_cold_start_false_when_facts_missing():
    assert _is_cold_start(_gate(facts=None)) is False
    assert _is_cold_start(_gate(facts={"outcome_resolved": 0})) is False  # min 없음 → 판단 불가.


# ── record_cold_start_seed 게이팅 ────────────────────────────────────────────────

async def _record(gate, new_status, resolver_id):
    part = SimpleNamespace(id=uuid.uuid4(), member_id=uuid.uuid4())
    rec = AsyncMock()
    with patch("app.services.verdict_capture.resolve_implementation_participation",
               AsyncMock(return_value=part)), \
         patch("app.services.verdict_recorder.record_verdict", rec):
        out = await record_cold_start_seed(AsyncMock(), uuid.uuid4(), gate, new_status, resolver_id)
    return out, rec, gate


@pytest.mark.anyio
async def test_seed_recorded_on_cold_start_approve():
    gate = _gate(facts={"outcome_resolved": 0, "min_outcome_sample": 3})
    out, rec, gate = await _record(gate, "approved", uuid.uuid4())
    assert out is True
    # keep 예측 → result=pass·source=human_seed(AC①·⑤).
    assert rec.await_args.args[3] == SEED_SOURCE and rec.await_args.args[4] == "pass"
    # AC④: FE "임시 예측" 데이터 계약.
    assert gate.neutral_facts["cold_start_seed"] is True
    assert gate.neutral_facts["seed_prediction"] == "keep"


@pytest.mark.anyio
async def test_seed_recorded_on_cold_start_reject_is_kill():
    gate = _gate(facts={"outcome_resolved": 2, "min_outcome_sample": 3})
    out, rec, gate = await _record(gate, "rejected", uuid.uuid4())
    assert out is True and rec.await_args.args[4] == "fail"
    assert gate.neutral_facts["seed_prediction"] == "kill"


@pytest.mark.anyio
async def test_no_seed_when_sufficient_sample():
    gate = _gate(facts={"outcome_resolved": 9, "min_outcome_sample": 3})
    out, rec, _ = await _record(gate, "approved", uuid.uuid4())
    assert out is False and rec.await_count == 0  # 표본 충분 → seed 아님.


@pytest.mark.anyio
async def test_no_seed_for_non_merge_or_no_resolver():
    out, rec, _ = await _record(_gate(gate_type="qa", facts={"outcome_resolved": 0, "min_outcome_sample": 3}),
                                "approved", uuid.uuid4())
    assert out is False and rec.await_count == 0
    out2, rec2, _ = await _record(_gate(facts={"outcome_resolved": 0, "min_outcome_sample": 3}),
                                  "approved", None)  # resolver 없음(시스템).
    assert out2 is False and rec2.await_count == 0


# ── 끝단 실DB: seed 기록 → trust 제외(AC②) → calibration(AC③) ──────────────────

@pytest.mark.skipif(not _REAL_DB_URL, reason="real Postgres 필요(PARITY/ALEMBIC_DATABASE_URL)")
@pytest.mark.anyio
async def test_seed_excluded_from_trust_and_calibrated_real_db():
    from datetime import datetime, timezone

    from sqlalchemy import text as _text
    from sqlalchemy.ext.asyncio import async_sessionmaker, create_async_engine

    from app.core.database import Base
    import app.models  # noqa: F401
    from app.models.gate import Gate
    from app.models.hypothesis import Hypothesis, HypothesisStoryLink
    from app.models.participation import Participation, ParticipationRole
    from app.models.pm import Story
    from app.models.verdict import Verdict  # noqa: F401
    from app.services.cold_start_seed import compute_seed_calibration, record_cold_start_seed
    from app.services.trust_score import compute_member_trust_scores

    url = _REAL_DB_URL.replace("postgresql+psycopg2://", "postgresql+asyncpg://").replace(
        "postgresql://", "postgresql+asyncpg://"
    )
    engine = create_async_engine(url)
    org, project, role_id, member = (uuid.uuid4() for _ in range(4))
    story_id, hyp_id, gate_id = uuid.uuid4(), uuid.uuid4(), uuid.uuid4()

    async with engine.begin() as conn:
        await conn.run_sync(Base.metadata.create_all)
    Session = async_sessionmaker(engine, expire_on_commit=False)
    try:
        async with Session() as s:
            await s.execute(_text("SET session_replication_role = replica"))
            s.add_all([
                ParticipationRole(id=role_id, org_id=org, key="implementation", label="구현", is_default=True),
                Story(id=story_id, org_id=org, project_id=project, title="S", status="in_review", story_points=3),
                Participation(id=uuid.uuid4(), org_id=org, story_id=story_id, member_id=member, role_id=role_id),
                # active 가설(미해소) — 링크로 seed↔outcome 연결.
                Hypothesis(id=hyp_id, org_id=org, project_id=project, owner_member_id=member,
                           statement="H", measure_after=datetime(2026, 6, 1, tzinfo=timezone.utc),
                           status="active",
                           metric_definition={"metric": "completion_pct", "source": "internal_ops",
                                              "target": 50, "direction": "up"}),
                HypothesisStoryLink(id=uuid.uuid4(), hypothesis_id=hyp_id, story_id=story_id, link_type="supports"),
                Gate(id=gate_id, org_id=org, work_item_id=story_id, work_item_type="story",
                     gate_type="merge", status="pending",
                     neutral_facts={"outcome_resolved": 0, "min_outcome_sample": 3}),
            ])
            await s.commit()

        # 1) cold-start approve → seed 기록(keep).
        async with Session() as s:
            await s.execute(_text("SET session_replication_role = replica"))
            gate = await s.get(Gate, gate_id)
            ok = await record_cold_start_seed(s, org, gate, "approved", member)
            await s.commit()
            assert ok is True

        # 2) AC②: seed는 outcome trust 본점수에 미포함(human_seed source 제외).
        async with Session() as s:
            trust = await compute_member_trust_scores(s, org, member, role_key="implementation")
            assert trust["resolved"] == 0, "seed가 trust outcome 표본에 새면 안 됨"
            assert trust["source_breakdown"].get(SEED_SOURCE) == 1  # 관측은 됨.

        # 3) AC③: 가설 해소(verified) 후 calibration — keep 예측 ↔ verified 일치 → calibrated 1/1.
        async with Session() as s:
            await s.execute(_text("UPDATE hypotheses SET status='verified' WHERE id=:id"), {"id": hyp_id})
            await s.commit()
        async with Session() as s:
            cal = await compute_seed_calibration(s, org, member)
            assert cal == {"total_seeds": 1, "resolved": 1, "calibrated": 1, "calibration_rate": 1.0}
    finally:
        async with engine.begin() as conn:
            await conn.run_sync(Base.metadata.drop_all)
        await engine.dispose()
