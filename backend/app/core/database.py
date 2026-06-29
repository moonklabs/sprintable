from collections.abc import AsyncGenerator

from sqlalchemy.ext.asyncio import AsyncSession, async_sessionmaker, create_async_engine
from sqlalchemy.orm import DeclarativeBase

from app.core.config import settings

# S20/E-INFRA S2 + ee7794eb: DB 풀 **rollout-safe** right-size — SSE는 대기 구간 커넥션 미점유(개별 세션).
# 인스턴스당 최대 커넥션 = pool_size + max_overflow. 클러스터 총합 = maxScale × (pool_size+overflow).
# ⚠️ 배포 rollout 時 old+new 리비전 풀 **동시 점유(2×)** 반영 필수(2026-06-29 dev TooManyConnections):
#   **2 × maxScale × (pool_size+max_overflow) + admin/migration headroom ≤ Cloud SQL max_connections.**
#   per-instance=4(3+1): 앱 최소요구(≥4·send_message 다중세션) ∩ prod rollout(2×10×4+20=100·maxScale 10 가정·③前 실측).
#   ⚠️ dev maxScale 실측=10(주석의 3은 stale): pool 4 단독도 2×10×4+5=85>25 → maxScale 10→2 동반 필수(PO rev 01240-hkc): 21≤25 ✓.
# env DB_POOL_SIZE / DB_MAX_OVERFLOW로 환경별 조정하되 상향은 rollout 여유(tier↑/maxScale↓/PgBouncer) 동반.
def _build_engine_kwargs() -> dict:
    """create_async_engine 인자를 DB_PGBOUNCER flag로 분기.

    헬퍼로 추출한 이유: engine은 import-time 단일 생성이라 테스트에서 flag별 재생성이
    어렵다. 분기 로직만 함수로 떼어내 settings 토글 → 인자 검증을 단위 테스트로 커버한다.

    off(기본·직접 Cloud SQL): pool_size=5/overflow=3 + prepared statement 캐시 on(#1330·
      re-prepare 오버헤드 회피·429 포화 기여 revert). connect_args 비움.
    on(DB_PGBOUNCER=true·PgBouncer transaction-mode 경유): app-side pool 최소(2/1·PgBouncer
      default_pool_size가 실 풀) + statement_cache_size=0(pooled conn 간 prepared statement
      reuse 깨짐 방지·#1314 재적용). host는 DATABASE_URL — 사이드카 배포 時 시크릿이
      localhost:6432(③ cloudbuild 리비전과 atomic).
    """
    pgb = settings.db_pgbouncer
    return {
        "pool_size": settings.db_pgbouncer_pool_size if pgb else settings.db_pool_size,
        "max_overflow": settings.db_pgbouncer_max_overflow if pgb else settings.db_max_overflow,
        "pool_pre_ping": True,
        "echo": settings.debug,
        "connect_args": {"statement_cache_size": 0} if pgb else {},
    }


engine = create_async_engine(settings.database_url, **_build_engine_kwargs())

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
