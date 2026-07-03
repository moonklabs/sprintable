"""HO-S1: score-hypotheses cron 스모크(서비스 레벨).

운영 cron은 Cloud Scheduler→backend POST /api/v2/internal/cron/score-hypotheses(PO lane). 여기선
score_hypotheses 서비스를 실 Postgres로 스모크 — due active 가설이 채점 패스 후 measuring(또는
verified/falsified)으로 전이함을 검증(AC④). DB 스키마 변경 0(AC⑤).
"""
from __future__ import annotations

import os
import uuid
from datetime import datetime, timedelta, timezone

import pytest

_REAL_DB_URL = os.getenv("PARITY_TEST_DATABASE_URL") or os.getenv("ALEMBIC_DATABASE_URL")

# story 8236bbc3: create_all/drop_all로 자체 스키마 직접 관리 — 공유 alembic-migrated DB
# 오염 방지 위해 격리 DB 전용(conftest.py 가드가 마커 누락을 자동 검출).
pytestmark = pytest.mark.destructive_schema


@pytest.fixture
def anyio_backend():
    return "asyncio"


@pytest.mark.skipif(not _REAL_DB_URL, reason="real Postgres 필요(PARITY/ALEMBIC_DATABASE_URL)")
@pytest.mark.anyio
async def test_score_hypotheses_transitions_due_active_real_db():
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
    future = datetime.now(timezone.utc) + timedelta(days=7)
    h_due = uuid.uuid4()       # due active(manual) → measuring 전이 기대.
    h_future = uuid.uuid4()    # measure_after 미도래 → 무전이(active 유지).

    async with engine.begin() as conn:
        await conn.run_sync(Base.metadata.create_all)
    Session = async_sessionmaker(engine, expire_on_commit=False)

    def _hyp(hid, status, measure_after):
        return Hypothesis(
            id=hid, org_id=org, project_id=project, owner_member_id=owner,
            statement="가설", metric_definition={"metric": "x", "source": "manual", "target": 10, "direction": "up"},
            measure_after=measure_after, status=status,
        )

    try:
        async with Session() as s:
            await s.execute(_text("SET session_replication_role = replica"))
            s.add_all([_hyp(h_due, "active", due), _hyp(h_future, "active", future)])
            await s.commit()

        async with Session() as s:
            summary = await score_hypotheses(s)
            await s.commit()

        # due active(manual) → measuring 전이(채점은 measuring 유지=pending), 미도래는 무전이.
        assert str(h_due) in summary["to_measuring"], summary
        assert str(h_due) in summary["pending"]  # manual → 자동 채점 안 함·measuring 유지.
        assert str(h_future) not in summary["to_measuring"]  # 미도래 active 무전이.

        async with Session() as s:
            statuses = dict((await s.execute(
                _text("SELECT id::text, status FROM hypotheses WHERE org_id=:o"), {"o": org}
            )).all())
        # AC④: due active 가설이 cron 후 measuring 전이·미도래는 active 유지.
        assert statuses[str(h_due)] == "measuring"
        assert statuses[str(h_future)] == "active"
    finally:
        async with engine.begin() as conn:
            await conn.run_sync(Base.metadata.drop_all)
        await engine.dispose()
