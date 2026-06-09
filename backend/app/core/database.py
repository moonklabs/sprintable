from collections.abc import AsyncGenerator

from sqlalchemy.ext.asyncio import AsyncSession, async_sessionmaker, create_async_engine
from sqlalchemy.orm import DeclarativeBase

from app.core.config import settings

# S20/E-INFRA S2: DB 풀 right-size — SSE는 대기 구간에서 커넥션 미점유(개별 세션 패턴).
# 인스턴스당 최대 커넥션 = pool_size + max_overflow. 클러스터 총합 = maxScale × (pool_size+overflow).
# ⚠️ 산식: (maxScale × (pool_size+max_overflow)) + admin/migration headroom ≤ Cloud SQL max_connections.
#   prod(db-g1-small max_connections=100, maxScale=10): 10×(5+3)=80 + ~20 headroom = 100 ✓
#   (이전 10/20=30/instance × 10 = 300 > 100 → 고갈 위험이라 right-size)
# env DB_POOL_SIZE / DB_MAX_OVERFLOW로 환경별 독립 조정(config.py 산식 주석 참조).
engine = create_async_engine(
    settings.database_url,
    pool_size=settings.db_pool_size,
    max_overflow=settings.db_max_overflow,
    pool_pre_ping=True,
    echo=settings.debug,
    # ⚠️ statement_cache_size=0(#1314·2c4dcae7 ②)는 PgBouncer transaction-mode 전제였으나
    # PgBouncer ③④ 미배포 상태(직접 Cloud SQL + SQLAlchemy pool=커넥션 재사용)에서는 prepared
    # statement 캐시 비활성이 매 쿼리 re-prepare 오버헤드 = net-negative(429 포화 기여) → revert로
    # 캐시 재활성. PgBouncer 랜딩(2c4dcae7 ③④) 시 transaction-mode 호환 위해 재적용 필요(랜딩 PR에서).
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
