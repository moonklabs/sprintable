from collections.abc import AsyncGenerator

from sqlalchemy.ext.asyncio import AsyncSession, async_sessionmaker, create_async_engine
from sqlalchemy.orm import DeclarativeBase

from app.core.config import settings

# S20: DB 풀 사이징 — SSE는 대기 구간에서 커넥션 미점유 (개별 세션 패턴)
# pool_size = 동시 쓰기 워커 수 × 2 + 여유분
#   → 에이전트 5명 × API 요청 동시성 2 = 10 (현재 pool_size)
# max_overflow = 트래픽 피크 버퍼 (pool_size × 2)
#   → 30개 총 커넥션 (pool_size 10 + max_overflow 20)
# SSE 연결 100개 기준: 각 heartbeat/backfill마다 ~0.05초 커넥션 점유 → 평균 5개 동시
# 공식: pool_size ≥ (avg_concurrent_writes) + (avg_sse_db_ops_concurrent)
engine = create_async_engine(
    settings.database_url,
    pool_size=10,
    max_overflow=20,
    pool_pre_ping=True,
    echo=settings.debug,
)

async_session_factory = async_sessionmaker(
    engine,
    expire_on_commit=False,
    class_=AsyncSession,
)


class Base(DeclarativeBase):
    pass


async def get_db() -> AsyncGenerator[AsyncSession, None]:
    async with async_session_factory() as session:
        try:
            yield session
            await session.commit()
        except Exception:
            await session.rollback()
            raise
