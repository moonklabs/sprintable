import os
from collections.abc import AsyncGenerator

from sqlalchemy.ext.asyncio import AsyncSession, async_sessionmaker, create_async_engine
from sqlalchemy.orm import DeclarativeBase

from app.core.config import settings


def db_application_name(suffix: str = "") -> str:
    """SID f2fe1c5e/#2040 AC2: `K_SERVICE:K_REVISION[:suffix]` — pg_stat_activity를 서비스·
    리비전·연결종류(pooled session vs pg_pubsub raw LISTEN)별로 분해하기 위한 태그.

    Cloud Run이 K_SERVICE/K_REVISION을 자동 주입한다(설정 불필요) — 로컬/테스트는 fallback.
    Postgres application_name은 NAMEDATALEN=64(63자 초과 시 silent truncate)라 63자로 자른다.
    ⚠️ 오르테가군 적발: 꼬리부터 자르면 판별자(`:listen`)가 긴 리비전에 먹혀 pooled와 raw
    LISTEN이 구분 불가해진다(AC2의 목적 자체가 무효화) — suffix를 먼저 확보하고 `K_SERVICE:
    K_REVISION` 쪽만 줄인다.
    """
    service = os.environ.get("K_SERVICE", "local")
    revision = os.environ.get("K_REVISION", "dev")
    base = f"{service}:{revision}"
    if not suffix:
        return base[:63]
    tail = f":{suffix}"
    return base[: 63 - len(tail)] + tail

# S20/E-INFRA S2 + ee7794eb: DB 풀 **rollout-safe** right-size — SSE는 대기 구간 커넥션 미점유(개별 세션).
# ⚠️ 인스턴스당 실 커넥션 = (pool_size+max_overflow) + **pool 밖 raw 연결**(pg_pubsub.listen_loop 상시 1·
#   l2_worker 는 pool 내). rollout(old+new 2×) 반영: 2×maxScale×((pool+overflow)+RAW)+headroom ≤ max_connections.
#   per_instance = 4(pool 3/1) + RAW 1 = **5**. (pool 4 는 앱최소·밑으로 불가.)
#   dev(~25·maxScale 10→PO 1): 2×1×5+5=15 ≤ 25(여유 10). prod(100·maxScale 실측필수): 2×10×5+20=120>100 →
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
    connect_args: dict = {"statement_cache_size": 0} if pgb else {}
    connect_args["server_settings"] = {"application_name": db_application_name()}
    return {
        "pool_size": settings.db_pgbouncer_pool_size if pgb else settings.db_pool_size,
        "max_overflow": settings.db_pgbouncer_max_overflow if pgb else settings.db_max_overflow,
        "pool_pre_ping": True,
        "echo": settings.debug,
        "connect_args": connect_args,
    }


engine = create_async_engine(settings.database_url, **_build_engine_kwargs())

async_session_factory = async_sessionmaker(
    engine,
    expire_on_commit=False,
    class_=AsyncSession,
)

# Phase3(§6 read replica): 읽기 전용 엔진/세션. DATABASE_URL_READ 설정 時 read replica(PgBouncer
# dbname=sprintable_read)로 라우팅, 미설정 時 primary engine 재사용(폴백 — 별도 커넥션 안 늘림·«무해»).
# ⚠️ get_read_db 는 lag-tolerant 읽기에만 (아래 docstring).
read_engine = (
    create_async_engine(settings.database_url_read, **_build_engine_kwargs())
    if settings.database_url_read
    else engine
)
read_session_factory = async_sessionmaker(
    read_engine,
    expire_on_commit=False,
    class_=AsyncSession,
)

# story #2461(§6 봉합③ part2, PO 승인 2026-08-05): 요청 경로(engine/async_session_factory)와
# 완전 분리된 전용 「워커풀」 — L2TriggerWorker의 advisory-lock 영구연결(finding #6) +
# embedding_backlog/workflow_sla_processor/workflow_handoff_watchdog/event_broker outbox의
# claim/finalize 세션(finding #5)이 여기로 옮겨간다. `pg_pubsub.listen_loop()`가 이미 쓰는
# "요청 풀 밖 전용 연결" 원칙과 같은 결 — 단 listen_loop은 raw 커넥션 1개, 이건 여러 워커가
# 나눠 쓰는 작은 풀(pool_size+max_overflow, 기본 2+1=3)이라는 차이만 있다.
# ⛔이 풀도 db_application_name()에 별도 suffix("worker")를 달아 pg_stat_activity에서
# 요청 세션(suffix 없음)·raw LISTEN(":listen")과 분리 집계되게 한다(SID f2fe1c5e/#2040 AC2
# 관례 재사용 — 이 풀의 실제 커넥션 점유를 "요청과 무관"함을 관측으로 증명하는 축).
worker_engine = create_async_engine(
    settings.database_url,
    pool_size=settings.worker_db_pool_size,
    max_overflow=settings.worker_db_max_overflow,
    pool_pre_ping=True,
    echo=settings.debug,
    connect_args={
        **({"statement_cache_size": 0} if settings.db_pgbouncer else {}),
        "server_settings": {"application_name": db_application_name("worker")},
    },
)
worker_session_factory = async_sessionmaker(
    worker_engine,
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


async def get_worker_db() -> AsyncGenerator[AsyncSession, None]:
    """story #2461(§6 봉합③ part2) — 배치워커 cron 엔드포인트(embed-backlog·workflow-sla·
    workflow-handoff-watchdog) 전용. 요청 primary 풀이 아니라 `worker_engine`에서 세션을
    뜬다 — FOR UPDATE SKIP LOCKED 락을 쥔 채 외부 서비스(Vertex AI 등)를 기다리는 구간이
    요청풀이 아닌 이 전용 풀에서만 소모되게 한다(embedding_backlog.py의 잔여 pool-hold를
    이 풀로 옮겨 해소 — PO 판단 2026-08-05, lease 마이그 불요·SKIP LOCKED dedup 보존)."""
    async with worker_session_factory() as session:
        try:
            yield session
            await session.commit()
        except Exception:
            await session.rollback()
            raise


async def get_read_db() -> AsyncGenerator[AsyncSession, None]:
    """Phase3(§6): 읽기 전용 세션 — read replica(DATABASE_URL_READ 설정 時) 또는 primary(폴백).

    ⚠️ «read-your-writes lag 허용» 읽기(목록·대시보드·타인 데이터·집계)에만 쓴다 — 방금 쓴 걸
    즉시 조회하는 경로(POST 直後 GET 등)는 get_db(primary)를 유지해야 replica lag 로 «내 write 가
    안 보이는» 버그를 막는다. 라우터별 라우팅은 careful 판정(#2450).

    커밋하지 않는다(읽기 전용) — 예외 時 rollback, 정상 時 세션 정리만.
    """
    async with read_session_factory() as session:
        try:
            yield session
        except Exception:
            await session.rollback()
            raise
