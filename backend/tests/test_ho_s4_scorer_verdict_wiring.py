"""HO-S4: scorer→outcome verdict 배선 호출 테스트.

score_hypotheses가 verified/falsified 해소 직후 record_outcome_verdicts를 호출하고 결과를 cron
response(verdicts_recorded/skipped)에 노출하는지. manual/pending은 verdict 0(AC④). 끝단 실DB.
"""
from __future__ import annotations

import os
import uuid
from datetime import datetime, timezone
from types import SimpleNamespace
from unittest.mock import AsyncMock, MagicMock, patch

import pytest

from app.services import hypothesis_scorer as sc

_REAL_DB_URL = os.getenv("PARITY_TEST_DATABASE_URL") or os.getenv("ALEMBIC_DATABASE_URL")

# story 8236bbc3: create_all/drop_all로 자체 스키마 직접 관리 — 공유 alembic-migrated DB
# 오염 방지 위해 격리 DB 전용(conftest.py 가드가 마커 누락을 자동 검출).
pytestmark = pytest.mark.destructive_schema


@pytest.fixture
def anyio_backend():
    return "asyncio"


def _hyp(status="active", source="ga4"):
    return SimpleNamespace(
        id=uuid.uuid4(), status=status, outcome_result=None,
        metric_definition={"metric": "m", "source": source, "target": 100, "direction": "up"},
    )


def _mock_session():
    """P1-S3g: session.begin_nested()가 진짜 async context manager처럼 동작해야(SAVEPOINT 구조
    재현) — plain AsyncMock()은 __aenter__/__aexit__을 자동 지원하지 않는다."""
    session = AsyncMock()
    cm = MagicMock()
    cm.__aenter__ = AsyncMock(return_value=None)
    cm.__aexit__ = AsyncMock(return_value=False)
    session.begin_nested = MagicMock(return_value=cm)
    return session


# ── AC①②④: 해소 시 배선 호출·response 노출·manual 미호출 ─────────────────────

@pytest.mark.anyio
async def test_resolved_calls_wiring_manual_does_not():
    verified_hyp = _hyp("active", "ga4")     # ga4 hit → verified → 배선 호출.
    manual_hyp = _hyp("measuring", "manual")  # manual → pending → 배선 미호출(AC④).

    session = _mock_session()
    res = MagicMock()
    res.scalars.return_value.all.return_value = [verified_hyp, manual_hyp]
    session.execute = AsyncMock(return_value=res)

    spy = AsyncMock(return_value={"skipped_reason": None, "bet": ["b1"], "execution": ["e1"]})
    with patch.object(sc, "score_ga4_outcome", return_value={"outcome_status": "hit", "outcome_result": {"x": 1}}), \
         patch("app.services.hypothesis_outcome_verdict.record_outcome_verdicts", new=spy), \
         patch(
             "app.services.loop_outcome_attribution.attribute_loop_outcome",
             new=AsyncMock(return_value={"skipped_reason": "no_measuring_loop", "attributed": []}),
         ):
        summary = await sc.score_hypotheses(session)

    # AC①: verified 가설에만 배선 호출(manual 미호출·AC④).
    assert spy.await_count == 1
    assert spy.await_args.args[1] is verified_hyp
    # AC②: cron response에 verdicts_recorded/skipped.
    assert summary["verdicts_recorded"] == [{"hypothesis_id": str(verified_hyp.id), "bet": ["b1"], "execution": ["e1"]}]
    assert summary["verdicts_skipped"] == []
    assert str(verified_hyp.id) in summary["verified"]


@pytest.mark.anyio
async def test_skipped_wiring_goes_to_verdicts_skipped():
    h = _hyp("active", "ga4")
    session = _mock_session()
    res = MagicMock()
    res.scalars.return_value.all.return_value = [h]
    session.execute = AsyncMock(return_value=res)
    spy = AsyncMock(return_value={"skipped_reason": "no_linked_story", "bet": [], "execution": []})
    with patch.object(sc, "score_ga4_outcome", return_value={"outcome_status": "miss", "outcome_result": {}}), \
         patch("app.services.hypothesis_outcome_verdict.record_outcome_verdicts", new=spy), \
         patch(
             "app.services.loop_outcome_attribution.attribute_loop_outcome",
             new=AsyncMock(return_value={"skipped_reason": "no_measuring_loop", "attributed": []}),
         ):
        summary = await sc.score_hypotheses(session)
    assert str(h.id) in summary["falsified"]
    assert summary["verdicts_skipped"] == [{"hypothesis_id": str(h.id), "reason": "no_linked_story"}]
    assert summary["verdicts_recorded"] == []


# ── 끝단 실DB: scorer 해소 → 실 outcome verdict 기록 ──────────────────────────

@pytest.mark.skipif(not _REAL_DB_URL, reason="real Postgres 필요(PARITY/ALEMBIC_DATABASE_URL)")
@pytest.mark.anyio
async def test_scorer_to_verdict_chain_real_db():
    from sqlalchemy import text as _text
    from sqlalchemy.ext.asyncio import async_sessionmaker, create_async_engine

    from app.core.database import Base
    import app.models  # noqa: F401
    from app.models.hypothesis import Hypothesis, HypothesisStoryLink
    from app.models.participation import Participation, ParticipationRole
    from app.models.pm import Story
    from app.models.verdict import Verdict  # noqa: F401
    from app.services.hypothesis_outcome_verdict import BET_ROLE_KEY, BET_SOURCE, EXECUTION_SOURCE
    from app.services.hypothesis_scorer import score_hypotheses

    url = _REAL_DB_URL.replace("postgresql+psycopg2://", "postgresql+asyncpg://").replace(
        "postgresql://", "postgresql+asyncpg://"
    )
    engine = create_async_engine(url)
    org, project, story_id = uuid.uuid4(), uuid.uuid4(), uuid.uuid4()
    owner, impl_member, impl_role, bet_role, hyp_id = (uuid.uuid4() for _ in range(5))
    past = datetime(2026, 6, 1, tzinfo=timezone.utc)

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
                # internal_ops·completion_pct·target=50·up + done 링크 1개(100%) → hit → verified.
                Hypothesis(id=hyp_id, org_id=org, project_id=project, owner_member_id=owner,
                           statement="H", measure_after=past, status="active",
                           metric_definition={"metric": "completion_pct", "source": "internal_ops",
                                              "target": 50, "direction": "up"}),
                HypothesisStoryLink(id=uuid.uuid4(), hypothesis_id=hyp_id, story_id=story_id, link_type="supports"),
            ])
            await s.commit()

        async with Session() as s:
            await s.execute(_text("SET session_replication_role = replica"))
            summary = await score_hypotheses(s)
            await s.commit()

        # scorer가 verified로 해소하고 배선이 verdict를 기록했다.
        assert str(hyp_id) in summary["verified"]
        assert summary["verdicts_recorded"], summary
        async with Session() as s:
            status = (await s.execute(_text("SELECT status FROM hypotheses WHERE id=:id"), {"id": hyp_id})).scalar()
            rows = dict((await s.execute(_text("SELECT source, result FROM verdict WHERE org_id=:o"), {"o": org})).all())
        assert status == "verified"
        assert rows[EXECUTION_SOURCE] == "pass" and rows[BET_SOURCE] == "pass"  # 끝단 닫힘.
    finally:
        async with engine.begin() as conn:
            await conn.run_sync(Base.metadata.drop_all)
        await engine.dispose()
