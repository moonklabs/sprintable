"""E-INFRA S2 + ee7794eb: DB 풀 **rollout-safe** right-size — max_connections 고갈 방지.

⚠️ 인스턴스당 실 커넥션 = (pool+overflow) + **pool 밖 raw 연결**. pg_pubsub.listen_loop 가 raw asyncpg
상시 1개(pool 미점유)를 잡는다(까심 적출 — 직전 산식이 이를 누락해 prod 테스트가 false-PASS). l2_worker 는
engine.connect→pool 내(추가 0). → per_instance = (pool+overflow) + RAW.

rollout(old+new 2×) 산식: **2 × maxScale × ((pool+overflow) + RAW) + headroom ≤ max_connections.**
  per_instance = 4(pool 3/1·앱최소) + RAW 1 = 5.
  dev(~25·maxScale 10→PO 1): 2×1×5+5 = 15 ≤ 25(여유 10). prod(100·maxScale 실측필수): 2×10×5+20=120>100
  → maxScale≤8(2×8×5+20=100·여유0) + PgBouncer/tier↑(③ 승격 前). 향후 raw 추가 시 RAW++.
"""
from app.core.config import Settings

ROLLOUT = 2  # 배포 중 old+new 리비전 동시 점유
RAW_PER_INSTANCE = 1  # pg_pubsub.listen_loop raw asyncpg(pool 밖·상시). ⚠️ always-on LISTEN 추가 시 ++.

PROD_MAX_CONNECTIONS = 100
PROD_MAX_SCALE_ASSUMED = 10  # ⚠️ 가정 — ③ prod 승격 前 gcloud 실측 필수
PROD_HEADROOM = 20

DEV_MAX_CONNECTIONS = 25  # sprintable-dev db-f1-micro
DEV_MAX_SCALE = 1  # PO 적용(rev 01240-hkc): dev maxScale 10→1 (2×1×5+5=15≤25·여유 10)
DEV_HEADROOM = 5

APP_MIN_PER_INSTANCE = 4  # 실측: total 3 이면 send_message pool_timeout


def _clear_pool_env(monkeypatch):
    monkeypatch.delenv("DB_POOL_SIZE", raising=False)
    monkeypatch.delenv("DB_MAX_OVERFLOW", raising=False)


def _effective_per_instance(s) -> int:
    """실 커넥션 = pool+overflow + pool 밖 raw(pg_pubsub). 산식은 반드시 raw 포함(false-PASS 방지)."""
    return s.db_pool_size + s.db_max_overflow + RAW_PER_INSTANCE


def test_default_pool_min_viable_for_app(monkeypatch):
    """앱 최소요구(pool+overflow ≥ 4) — total 3 이면 send_message pool_timeout(실측)."""
    _clear_pool_env(monkeypatch)
    s = Settings()
    assert s.db_pool_size + s.db_max_overflow >= APP_MIN_PER_INSTANCE


def test_effective_per_instance_counts_raw_connection(monkeypatch):
    """⚠️ 산식이 pool 밖 raw 연결(pg_pubsub +1)을 포함하는지 — 직전 false-PASS 회귀 게이트."""
    _clear_pool_env(monkeypatch)
    s = Settings()
    assert _effective_per_instance(s) == s.db_pool_size + s.db_max_overflow + RAW_PER_INSTANCE
    assert _effective_per_instance(s) == 5  # pool 4 + raw 1 (현 기본)


def test_dev_rollout_within_limit_at_applied_maxscale(monkeypatch):
    """dev(maxScale 1·PO 적용)가 rollout(raw 포함) 중 한도 내 — 인시던트 직접 회귀 게이트(2×1×5+5=15≤25)."""
    _clear_pool_env(monkeypatch)
    s = Settings()
    eff = _effective_per_instance(s)
    total = ROLLOUT * DEV_MAX_SCALE * eff + DEV_HEADROOM
    assert total <= DEV_MAX_CONNECTIONS, (
        f"dev rollout 고갈: 2×{DEV_MAX_SCALE}×{eff}+{DEV_HEADROOM}={total} > {DEV_MAX_CONNECTIONS}"
    )


def test_prod_assumed_maxscale_exceeds_needs_cap_and_pooler(monkeypatch):
    """⚠️ raw 포함 시 prod 가정 maxScale 10 은 한도 초과 — ③ 승격 前 maxScale≤8 + PgBouncer/tier 필수.

    (이 테스트가 'prod@10 안전' false 가정을 차단·실 연결수 산식을 문서화.)
    """
    _clear_pool_env(monkeypatch)
    s = Settings()
    eff = _effective_per_instance(s)
    at_assumed = ROLLOUT * PROD_MAX_SCALE_ASSUMED * eff + PROD_HEADROOM
    assert at_assumed > PROD_MAX_CONNECTIONS  # 120 > 100 — prod@10 초과(블로커 문서화)
    safe_max_scale = (PROD_MAX_CONNECTIONS - PROD_HEADROOM) // (ROLLOUT * eff)
    assert safe_max_scale == 8  # 안전 상한(여유 0·PgBouncer/tier 권장)


def test_pool_env_configurable(monkeypatch):
    monkeypatch.setenv("DB_POOL_SIZE", "6")
    monkeypatch.setenv("DB_MAX_OVERFLOW", "2")
    s = Settings()
    assert s.db_pool_size == 6
    assert s.db_max_overflow == 2


def test_engine_uses_settings_pool():
    from app.core import database
    from app.core.config import settings
    assert database.engine.pool.size() == settings.db_pool_size
    assert database.engine.pool._max_overflow == settings.db_max_overflow
