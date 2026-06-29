"""E-INFRA S2 + ee7794eb: DB 풀 **rollout-safe** right-size — max_connections 고갈 방지.

⚠️ 배포 rollout 時 old+new 리비전 풀 **동시 점유(2×)** — steady 산식만 쓰면 배포 중 초과
(2026-06-29 dev TooManyConnections·#1766 rollout 전요청 500). rollout-aware 산식:
  **2 × maxScale × (pool_size + max_overflow) + headroom ≤ max_connections.**

per-instance 는 두 제약 교집합으로 **정확히 4**(3+1):
  ① 앱 최소요구(실측): pool+overflow ≥ 4 (send_message 요청당 다중세션·total 3 이면 pool_timeout).
  ② prod rollout: 2×10×4+20=100 ≤ 100 (total 5 면 120 > 100). → total ≤ 4.
⚠️ dev maxScale 실측=10(코드주석의 3은 stale): pool 4 단독도 2×10×4+5=85>25 → maxScale 10→2(PO rev
01240-hkc) 동반 필수. pool 축소만으론 worst-case 미해결이라는 결론을 락.
"""
from app.core.config import Settings

ROLLOUT = 2  # 배포 중 old+new 리비전 동시 점유

PROD_MAX_CONNECTIONS = 100
PROD_MAX_SCALE = 10  # ⚠️ 가정 — ③ prod 승격 前 gcloud 실측 필수(dev 가 주석 3↔실측 10 괴리였음)
PROD_HEADROOM = 20

DEV_MAX_CONNECTIONS = 25  # sprintable-dev db-f1-micro
DEV_MAX_SCALE_SAFE = 2  # PO 적용(rev 01240-hkc): dev maxScale 10→2. pool 4 + maxScale 2 = rollout-safe
DEV_HEADROOM = 5

APP_MIN_PER_INSTANCE = 4  # 실측: send_message 등이 요청당 ≥4 커넥션(total 3 이면 pool_timeout)


def _clear_pool_env(monkeypatch):
    monkeypatch.delenv("DB_POOL_SIZE", raising=False)
    monkeypatch.delenv("DB_MAX_OVERFLOW", raising=False)


def test_default_pool_min_viable_for_app(monkeypatch):
    """앱 최소요구(≥4) — total 3 이면 send_message pool_timeout(실측). 너무 작게 줄이면 앱 파손."""
    _clear_pool_env(monkeypatch)
    s = Settings()
    per_instance = s.db_pool_size + s.db_max_overflow
    assert per_instance >= APP_MIN_PER_INSTANCE, (
        f"앱 최소요구 미달: {per_instance} < {APP_MIN_PER_INSTANCE} → pool_timeout 위험"
    )


def test_default_pool_rollout_safe_prod(monkeypatch):
    _clear_pool_env(monkeypatch)
    s = Settings()
    per_instance = s.db_pool_size + s.db_max_overflow
    total = ROLLOUT * PROD_MAX_SCALE * per_instance + PROD_HEADROOM
    assert total <= PROD_MAX_CONNECTIONS, (
        f"prod rollout 풀 고갈: 2×{PROD_MAX_SCALE}×{per_instance}+{PROD_HEADROOM}={total} > {PROD_MAX_CONNECTIONS}"
    )


def test_default_pool_dev_safe_with_reduced_maxscale(monkeypatch):
    """dev 는 maxScale 2(축소·PO infra) 동반 時 rollout-safe — 이번 인시던트 직접 회귀 게이트.

    (실측 maxScale 10 은 2×10×4+5=85>25 라 pool 단독 불가 — config 주석의 maxScale↓ 동반 요구를 락.)
    """
    _clear_pool_env(monkeypatch)
    s = Settings()
    per_instance = s.db_pool_size + s.db_max_overflow
    total = ROLLOUT * DEV_MAX_SCALE_SAFE * per_instance + DEV_HEADROOM
    assert total <= DEV_MAX_CONNECTIONS, (
        f"dev rollout(maxScale {DEV_MAX_SCALE_SAFE}) 고갈: 2×{DEV_MAX_SCALE_SAFE}×{per_instance}+{DEV_HEADROOM}={total} > {DEV_MAX_CONNECTIONS}"
    )


def test_pool_env_configurable(monkeypatch):
    # 환경별 override 메커니즘(상향은 rollout 여유 동반 필수 — config 주석).
    monkeypatch.setenv("DB_POOL_SIZE", "6")
    monkeypatch.setenv("DB_MAX_OVERFLOW", "2")
    s = Settings()
    assert s.db_pool_size == 6
    assert s.db_max_overflow == 2


def test_engine_uses_settings_pool():
    from app.core import database
    from app.core.config import settings
    # 엔진 풀이 settings 값을 반영 (하드코딩 아님)
    assert database.engine.pool.size() == settings.db_pool_size
    assert database.engine.pool._max_overflow == settings.db_max_overflow
