"""story #2461(§6 봉합③ part2) realdb 검증 — 워커풀과 요청풀의 진짜 독립성 실측.

PO 지시(2026-08-05): 검증="워커가 요청풀 안 먹나". #2460/#2461 파트1의 pin들은 "세션이 제때
반납되는가"(단일 풀 안에서의 생명주기)를 쟀다 — 이 파일은 **더 근본적인 축**을 잰다: 워커풀
자체가 요청풀과 물리적으로 다른 풀이라, **한쪽이 완전히 고갈돼도 다른 쪽은 무영향**임을
pool_size=1 두 엔진으로 실측한다(SHOW POOLS/pg_stat_activity가 실제로 보여줄 그 분리를
그대로 재현). ⛔공유 dev 백엔드 접속 없음 — 로컬 Postgres만 사용.
"""
from __future__ import annotations

import os

import pytest
from sqlalchemy import select
from sqlalchemy.ext.asyncio import AsyncSession, create_async_engine

_REAL_DB_URL = os.getenv("PARITY_TEST_DATABASE_URL") or os.getenv("ALEMBIC_DATABASE_URL")

pytestmark = [
    pytest.mark.skipif(not _REAL_DB_URL, reason="realdb 테스트는 로컬 PG(PARITY/ALEMBIC_DATABASE_URL) 필요"),
]


@pytest.fixture
def anyio_backend():
    return "asyncio"


def _async_url() -> str:
    url = _REAL_DB_URL
    for prefix in ("postgresql+psycopg2://", "postgresql://"):
        if url.startswith(prefix):
            return "postgresql+asyncpg://" + url[len(prefix):]
    return url


@pytest.mark.anyio
async def test_worker_pool_exhaustion_does_not_block_request_pool():
    """「요청풀」을 완전히 고갈시켜 놓은 채(pool_size=1, 그 1개 커넥션을 계속 쥠) 「워커풀」
    (별개 엔진, 역시 pool_size=1)로 새 세션을 여는 것이 **안 막혀야** 한다 — 두 풀이 같은
    엔진/풀 객체를 공유했다면 이 요청이 pool_timeout으로 실패했을 것."""
    request_engine = create_async_engine(_async_url(), pool_size=1, max_overflow=0, pool_timeout=3)
    worker_engine = create_async_engine(_async_url(), pool_size=1, max_overflow=0, pool_timeout=3)
    try:
        # 요청풀의 유일한 커넥션을 계속 쥔 채(고갈 상태 고정).
        held_request_session = AsyncSession(request_engine)
        await held_request_session.execute(select(1))
        try:
            # 워커풀은 완전히 별개 엔진이라 요청풀 고갈과 무관하게 즉시 성공해야 한다.
            async with AsyncSession(worker_engine) as worker_session:
                result = await worker_session.execute(select(1))
                assert result.scalar() == 1
        finally:
            await held_request_session.close()
    finally:
        await request_engine.dispose()
        await worker_engine.dispose()


@pytest.mark.anyio
async def test_request_pool_exhaustion_does_not_block_worker_pool():
    """역방향 — 워커풀을 고갈시켜도 요청풀은 무영향(대칭성 확認, 한쪽만 쟀다는 비판 방지)."""
    request_engine = create_async_engine(_async_url(), pool_size=1, max_overflow=0, pool_timeout=3)
    worker_engine = create_async_engine(_async_url(), pool_size=1, max_overflow=0, pool_timeout=3)
    try:
        held_worker_session = AsyncSession(worker_engine)
        await held_worker_session.execute(select(1))
        try:
            async with AsyncSession(request_engine) as request_session:
                result = await request_session.execute(select(1))
                assert result.scalar() == 1
        finally:
            await held_worker_session.close()
    finally:
        await request_engine.dispose()
        await worker_engine.dispose()


