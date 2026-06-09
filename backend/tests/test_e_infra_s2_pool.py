"""E-INFRA S2: DB 풀 right-size — prod max_connections=100 고갈 방지.

산식: (maxScale × (pool_size + max_overflow)) + headroom ≤ max_connections.
prod(db-g1-small): max_connections=100, maxScale=10 → pool+overflow ≤ 8/instance.
"""
from app.core.config import Settings

PROD_MAX_CONNECTIONS = 100
PROD_MAX_SCALE = 10
HEADROOM = 20  # superuser_reserved(3) + migrate-prod 잡 + 수동 admin


def _clear_pool_env(monkeypatch):
    monkeypatch.delenv("DB_POOL_SIZE", raising=False)
    monkeypatch.delenv("DB_MAX_OVERFLOW", raising=False)


def test_default_pool_fits_prod_max_connections(monkeypatch):
    _clear_pool_env(monkeypatch)
    s = Settings()
    per_instance = s.db_pool_size + s.db_max_overflow
    cluster_total = PROD_MAX_SCALE * per_instance + HEADROOM
    assert cluster_total <= PROD_MAX_CONNECTIONS, (
        f"prod 풀 고갈 위험: {PROD_MAX_SCALE}×{per_instance}+{HEADROOM}={cluster_total} > {PROD_MAX_CONNECTIONS}"
    )
    assert per_instance <= 8, f"인스턴스당 {per_instance} > 8 (maxScale 10 기준 초과)"


def test_pool_env_configurable(monkeypatch):
    # dev는 maxScale 3이라 여유 큼 — env로 상향 가능
    monkeypatch.setenv("DB_POOL_SIZE", "10")
    monkeypatch.setenv("DB_MAX_OVERFLOW", "20")
    s = Settings()
    assert s.db_pool_size == 10
    assert s.db_max_overflow == 20


def test_engine_uses_settings_pool():
    from app.core import database
    from app.core.config import settings
    # 엔진 풀이 settings 값을 반영 (하드코딩 아님)
    assert database.engine.pool.size() == settings.db_pool_size
    assert database.engine.pool._max_overflow == settings.db_max_overflow
