from collections.abc import AsyncGenerator

from sqlalchemy.ext.asyncio import AsyncSession, async_sessionmaker, create_async_engine
from sqlalchemy.orm import DeclarativeBase

from app.core.config import settings

# S20/E-INFRA S2 + ee7794eb: DB 풀 **rollout-safe** right-size — SSE는 대기 구간 커넥션 미점유(개별 세션).
# ⚠️ 인스턴스당 실 커넥션 = (pool_size+max_overflow) + **pool 밖 raw 연결**(pg_pubsub.listen_loop 상시 1·
#   l2_worker 는 pool 내). rollout(old+new 2×) 반영: 2×maxScale×((pool+overflow)+RAW)+headroom ≤ max_connections.
#   per_instance = 4(pool 3/1) + RAW 1 = **5**. (pool 4 는 앱최소·밑으로 불가.)
#   dev(~25·maxScale 10→PO 2): 2×2×5+5=25 = 25/25(한계). prod(100·maxScale 실측필수): 2×10×5+20=120>100 →
#   maxScale≤8(2×8×5+20=100·여유0) + ③ 승격 前 PgBouncer/tier↑ 필수. 향후 raw 추가 시 RAW++ (config.py 산식).
# env DB_POOL_SIZE / DB_MAX_OVERFLOW로 조정하되 상향은 rollout 여유(tier↑/maxScale↓/PgBouncer) 동반.
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
