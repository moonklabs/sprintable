"""E-LOOP-LEDGER S8(story ee7ef231): GA4 source loop 경로 검증.

순수 검증 스토리 — 코드 변경 없음. score_ga4_outcome/fetch_ga4_metric의 모든 실패 경로가
{"outcome_status":"pending"}만 반환(never raise)하므로 _OUTCOME_TO_STATUS에 매치 안 돼
new_status=None이 되고, attribute_loop_outcome은 `if new_status is not None:` 블록 안에서만
호출된다 — 즉 GA4 unauth/미연동은 구조적으로 loop 귀속에 도달 못 한다(false-hit 0가 이미
코드 설계상 보장됨). 이 파일은 그 사실을 실 DB round-trip으로 증명한다(S19의 manual 경로
증명과 대칭 — GA4 소스도 동일 배선을 탄다).

DB env(ALEMBIC_DATABASE_URL) 없으면 skip.
"""
from __future__ import annotations

import os
import uuid
from datetime import datetime, timezone
from unittest.mock import patch

import pytest
from sqlalchemy import select, text
from sqlalchemy.ext.asyncio import async_sessionmaker, create_async_engine

_RAW = os.environ.get("ALEMBIC_DATABASE_URL") or os.environ.get("PARITY_TEST_DATABASE_URL") or ""
_ASYNC = _RAW.replace("postgresql+psycopg2://", "postgresql+asyncpg://").replace(
    "postgresql://", "postgresql+asyncpg://"
)

pytestmark = pytest.mark.skipif(not _RAW, reason="real-DB URL 미설정 — skip")

ORG = uuid.UUID("23000000-0000-0000-0000-000000000001")
PROJ = uuid.UUID("23000000-0000-0000-0000-000000000002")


@pytest.fixture
def anyio_backend():
    return "asyncio"


async def _engine():
    eng = create_async_engine(_ASYNC)
    return eng, async_sessionmaker(eng, expire_on_commit=False)


async def _seed_org_project(s):
    for sql in [
        f"DELETE FROM projects WHERE org_id='{ORG}'",
        f"DELETE FROM organizations WHERE id='{ORG}'",
        f"INSERT INTO organizations (id,name,slug,plan) VALUES ('{ORG}','C23','c23org','free')",
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


async def _seed_ga4_hypothesis(s):
    from app.models.hypothesis import Hypothesis
    hyp = Hypothesis(
        id=uuid.uuid4(), org_id=ORG, project_id=PROJ, owner_member_id=uuid.uuid4(),
        statement="s",
        metric_definition={
            "metric": "activeUsers", "source": "ga4", "target": 100, "direction": "up",
            "property_id": "999999", "ga4_metric": "activeUsers", "date_range_days": 7,
        },
        measure_after=datetime(2020, 1, 1, tzinfo=timezone.utc), status="active",
    )
    s.add(hyp)
    await s.commit()
    await s.refresh(hyp)
    return hyp


async def _seed_loop(s, hypothesis_id) -> uuid.UUID:
    from app.repositories.loop import LoopRunRepository
    repo = LoopRunRepository(s, ORG)
    loop = await repo.create(
        project_id=PROJ, title="L", goal_tags=[], status="measuring",
        hypothesis_id=hypothesis_id, created_by_member_id=uuid.uuid4(),
    )
    await s.commit()
    return loop.id


async def _fetch_loop(s, loop_id):
    from app.models.loop import LoopRun
    return (await s.execute(select(LoopRun).where(LoopRun.id == loop_id))).scalar_one()


async def _fetch_hyp(s, hyp_id):
    from app.models.hypothesis import Hypothesis
    return (await s.execute(select(Hypothesis).where(Hypothesis.id == hyp_id))).scalar_one()


# ── ① GA4 hit → verified → loop closed(S19 manual 경로와 대칭) ────────────────

@pytest.mark.anyio
async def test_ga4_hit_verifies_hypothesis_and_closes_linked_loop():
    from app.services import hypothesis_scorer as sc

    eng, Session = await _engine()
    try:
        async with Session() as s:
            await _seed_org_project(s)
            await _cleanup(s)
            hyp = await _seed_ga4_hypothesis(s)
            loop_id = await _seed_loop(s, hyp.id)

            with patch.object(
                sc, "score_ga4_outcome",
                return_value={"outcome_status": "hit", "outcome_result": {"activeUsers": 150}},
            ):
                summary = await sc.score_hypotheses(s)
            await s.commit()

            assert str(hyp.id) in summary["verified"]

            fetched_hyp = await _fetch_hyp(s, hyp.id)
            assert fetched_hyp.status == "verified"

            loop = await _fetch_loop(s, loop_id)
            assert loop.status == "closed"
            assert loop.outcome_snapshot["hypothesis_status"] == "verified"
            assert loop.outcome_snapshot["outcome_result"] == {"activeUsers": 150}
    finally:
        await eng.dispose()


# ── ②⭐ 핵심 격리: GA4 unauth/미연동 → false-hit 0 ──────────────────────────────

@pytest.mark.anyio
async def test_ga4_unauth_leaves_hypothesis_and_loop_pending_no_false_hit():
    """fetch_ga4_metric이 None을 반환(인증정보 없음/ADC 실패/API 오류 전부 이 경로로 수렴)
    하면 hypothesis는 measuring 유지·연결 loop도 measuring 그대로(잘못 closed 안 됨) —
    GA4 없다고 loop이 거짓으로 완결되지 않는다는 것을 실 DB round-trip으로 증명."""
    from app.services import hypothesis_scorer as sc
    from app.services.ga4_client import fetch_ga4_metric as real_fetch

    eng, Session = await _engine()
    try:
        async with Session() as s:
            await _seed_org_project(s)
            await _cleanup(s)
            hyp = await _seed_ga4_hypothesis(s)
            loop_id = await _seed_loop(s, hyp.id)

            # unauth 재현: ga4_client.fetch_ga4_metric이 None 반환(진짜 함수 그대로 사용하되
            # GOOGLE_APPLICATION_CREDENTIALS 미설정+ADC 실패를 mock — outcome_scorer가 그 결과를
            # 그대로 pending으로 접는지까지 실증. score_ga4_outcome은 mock하지 않는다(중간 단
            # 우회 없이 진짜 로직 경로 그대로).
            with patch("app.services.ga4_client._has_adc", return_value=False), \
                 patch.dict(os.environ, {}, clear=False):
                os.environ.pop("GOOGLE_APPLICATION_CREDENTIALS", None)
                summary = await sc.score_hypotheses(s)
            await s.commit()

            assert str(hyp.id) not in summary["verified"]
            assert str(hyp.id) not in summary["falsified"]
            assert str(hyp.id) in summary["pending"]

            fetched_hyp = await _fetch_hyp(s, hyp.id)
            assert fetched_hyp.status == "measuring"  # active→measuring은 됐지만 그 이상 아님.
            assert fetched_hyp.outcome_result is None

            loop = await _fetch_loop(s, loop_id)
            assert loop.status == "measuring"
            assert loop.outcome_attributed_at is None
            assert loop.outcome_snapshot is None
    finally:
        await eng.dispose()


# ── ③ GA4 miss → falsified → loop closed(hit과 대칭) ──────────────────────────

@pytest.mark.anyio
async def test_ga4_miss_falsifies_hypothesis_and_closes_linked_loop():
    from app.services import hypothesis_scorer as sc

    eng, Session = await _engine()
    try:
        async with Session() as s:
            await _seed_org_project(s)
            await _cleanup(s)
            hyp = await _seed_ga4_hypothesis(s)
            loop_id = await _seed_loop(s, hyp.id)

            with patch.object(
                sc, "score_ga4_outcome",
                return_value={"outcome_status": "miss", "outcome_result": {"activeUsers": 10}},
            ):
                summary = await sc.score_hypotheses(s)
            await s.commit()

            assert str(hyp.id) in summary["falsified"]

            loop = await _fetch_loop(s, loop_id)
            assert loop.status == "closed"
            assert loop.outcome_snapshot["hypothesis_status"] == "falsified"
    finally:
        await eng.dispose()
