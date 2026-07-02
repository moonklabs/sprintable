"""E-LOOP-LEDGER P1-S3g: score_hypotheses 배치 SAVEPOINT 격리 실 Postgres 검증(story 7ca1c953).

핵심: internal_ops 브랜치(_linked_story_completion_pct)가 실 Postgres 에러(UndefinedTable)로
트랜잭션을 server-level aborted 시켜도, SAVEPOINT 격리 덕에 같은 batch의 다른 hypothesis(GA4
브랜치, DB 무관) 진행이 실제로 persist되는지 비-tautological로 검증한다(P1-S7 까심 QA CRITICAL과
동일 클래스 landmine — mock RuntimeError는 이 시나리오를 재현 못 함).
"""
from __future__ import annotations

import os
import uuid
from datetime import datetime, timedelta, timezone
from unittest.mock import patch

import pytest

_REAL_DB_URL = os.getenv("PARITY_TEST_DATABASE_URL") or os.getenv("ALEMBIC_DATABASE_URL")


@pytest.fixture
def anyio_backend():
    return "asyncio"


async def _real_db_error_completion_pct(session, hypothesis_id):
    from sqlalchemy import text as _text
    await session.execute(_text("SELECT * FROM this_table_definitely_does_not_exist_xyz"))
    return 0.0  # 위에서 반드시 예외 — 도달 안 함.


@pytest.mark.skipif(not _REAL_DB_URL, reason="real Postgres 필요(PARITY/ALEMBIC_DATABASE_URL)")
@pytest.mark.anyio
async def test_real_db_error_in_one_hypothesis_does_not_lose_batch_mates_progress_real_db():
    """🔴P1-S7과 동일 클래스 landmine 회귀 — h_bad(internal_ops)의 실 DB abort가 h_good(ga4)의
    verified 전이 persist를 절대 막지 않아야 한다(SAVEPOINT 없었다면 session.commit()이 조용히
    ROLLBACK되어 h_good 진행까지 함께 유실됐을 시나리오)."""
    from sqlalchemy import text as _text
    from sqlalchemy.ext.asyncio import async_sessionmaker, create_async_engine
    from app.core.database import Base
    import app.models  # noqa: F401
    from app.models.hypothesis import Hypothesis
    from app.services.hypothesis_scorer import score_hypotheses

    url = _REAL_DB_URL.replace("postgresql+psycopg2://", "postgresql+asyncpg://").replace(
        "postgresql://", "postgresql+asyncpg://"
    )
    engine = create_async_engine(url)
    org, project, owner = uuid.uuid4(), uuid.uuid4(), uuid.uuid4()
    due = datetime.now(timezone.utc) - timedelta(hours=1)
    h_good, h_bad = uuid.uuid4(), uuid.uuid4()

    async with engine.begin() as conn:
        await conn.run_sync(Base.metadata.create_all)
    Session = async_sessionmaker(engine, expire_on_commit=False)

    def _hyp(hid, source):
        return Hypothesis(
            id=hid, org_id=org, project_id=project, owner_member_id=owner,
            statement="가설", metric_definition={"metric": "x", "source": source, "target": 10, "direction": "up"},
            measure_after=due, status="active",
        )

    try:
        async with Session() as s:
            await s.execute(_text("SET session_replication_role = replica"))
            s.add_all([_hyp(h_good, "ga4"), _hyp(h_bad, "internal_ops")])
            await s.commit()

        async with Session() as s:
            with patch(
                "app.services.hypothesis_scorer.score_ga4_outcome",
                return_value={"outcome_status": "hit", "outcome_result": {"actual": 1}},
            ):
                with patch(
                    "app.services.hypothesis_scorer._linked_story_completion_pct",
                    new=_real_db_error_completion_pct,
                ):
                    summary = await score_hypotheses(s)
            await s.commit()  # ⭐SAVEPOINT 없었다면 이 commit이 조용히 ROLLBACK됐을 지점.

        assert str(h_bad) in [f["id"] for f in summary["failed"]]
        assert str(h_good) in summary["verified"]

        async with Session() as s:
            statuses = dict((await s.execute(
                _text("SELECT id::text, status FROM hypotheses WHERE org_id=:o"), {"o": org}
            )).all())
        # ⭐핵심 단정: h_bad의 DB abort에도 h_good의 verified 전이가 실제 DB에 persist돼야 한다.
        assert statuses[str(h_good)] == "verified"
        assert statuses[str(h_bad)] == "measuring"  # active→measuring까지는 성공(scoring만 실패).
    finally:
        async with engine.begin() as conn:
            await conn.run_sync(Base.metadata.drop_all)
        await engine.dispose()
