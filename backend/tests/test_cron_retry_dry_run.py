"""cron retry-agent-runs ?dry_run=true preview 테스트.

dry_run은 retry-eligible count만 반환하고 아무것도 mutate하지 않는다(스케줄 가동 전 surge 규모
점검용 read-only 안전 프리미티브). dry_run 필터 == 실제 처리 필터(동형)임을 실DB로 입증.
"""
from __future__ import annotations

import os
import uuid
from datetime import datetime, timedelta, timezone

import pytest

_REAL_DB_URL = os.getenv("PARITY_TEST_DATABASE_URL") or os.getenv("ALEMBIC_DATABASE_URL")

pytestmark = pytest.mark.skipif(
    not _REAL_DB_URL, reason="real Postgres 필요(PARITY/ALEMBIC_DATABASE_URL)"
)


@pytest.fixture
def anyio_backend():
    return "asyncio"


@pytest.mark.anyio
async def test_dry_run_counts_without_mutating_and_matches_real_filter():
    from sqlalchemy import text as _text
    from sqlalchemy.ext.asyncio import async_sessionmaker, create_async_engine

    from app.core.database import Base
    import app.models  # noqa: F401
    from app.models.agent_run import AgentRun
    from app.routers import cron as cron_mod

    url = _REAL_DB_URL.replace("postgresql+psycopg2://", "postgresql+asyncpg://").replace(
        "postgresql://", "postgresql+asyncpg://"
    )
    engine = create_async_engine(url)
    org, project, agent = uuid.uuid4(), uuid.uuid4(), uuid.uuid4()
    # 핸들러는 실 wall clock(datetime.now())로 eligible를 판정한다. 시드 시각도 실 now 기준으로
    # 잡아야(까심 CP④ time-bomb 회피) future run이 wall clock 경과로 eligible 전환되지 않는다.
    now = datetime.now(timezone.utc)
    past = now - timedelta(hours=1)
    future = now + timedelta(days=1)

    def _run(status, nra, rc, mx):
        return AgentRun(id=uuid.uuid4(), org_id=org, project_id=project, agent_id=agent,
                        status=status, next_retry_at=nra, retry_count=rc, max_retries=mx)

    async with engine.begin() as c:
        await c.run_sync(Base.metadata.create_all)
    Session = async_sessionmaker(engine, expire_on_commit=False)
    try:
        async with Session() as s:
            await s.execute(_text("SET session_replication_role = replica"))
            s.add_all([
                _run("failed", past, 0, 3),       # ✅ eligible
                _run("failed", past, 1, 3),       # ✅ eligible
                _run("failed", future, 0, 3),     # ✗ 아직 retry 시각 전
                _run("failed", past, 3, 3),        # ✗ retry 소진(rc>=max)
                _run("failed", None, 0, 3),        # ✗ next_retry_at 없음
                _run("queued", past, 0, 3),        # ✗ failed 아님
            ])
            await s.commit()

        # dry_run: eligible count만 반환·mutate 0.
        class _Req:
            headers: dict = {}
        async with Session() as s:
            await s.execute(_text("SET session_replication_role = replica"))
            # CRON_SECRET 미설정 환경이면 verify_cron 통과(로컬). 설정 시 헤더 필요하나 테스트는 미설정 가정.
            resp = await cron_mod.retry_agent_runs(_Req(), dry_run=True, session=s)
        import json
        body = json.loads(resp.body)
        assert body["data"]["dry_run"] is True
        assert body["data"]["eligible_count"] == 2  # 정확히 eligible 2건.

        # mutate 0 검증: 모든 failed run이 그대로 failed(queued로 안 바뀜).
        async with Session() as s:
            failed_cnt = (await s.execute(
                _text("SELECT count(*) FROM agent_runs WHERE status='failed'")
            )).scalar()
            queued_cnt = (await s.execute(
                _text("SELECT count(*) FROM agent_runs WHERE status='queued'")
            )).scalar()
        assert failed_cnt == 5 and queued_cnt == 1  # dry_run 전과 동일(아무 전이 없음).

        # 동형 검증: 실제 실행 시 eligible_count(2)만큼 retried 처리.
        async with Session() as s:
            await s.execute(_text("SET session_replication_role = replica"))
            resp2 = await cron_mod.retry_agent_runs(_Req(), dry_run=False, session=s)
        body2 = json.loads(resp2.body)
        assert len(body2["data"]["retried"]) == 2  # preview 수 == 실제 처리 수(동형).
    finally:
        async with engine.begin() as c:
            await c.run_sync(Base.metadata.drop_all)
        await engine.dispose()
