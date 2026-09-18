"""#2121: sse_lease (SSE 연결 ZSET lease) 단위 테스트.

flag off/Redis 다운 = None(호출부 in-process 폴백=fail-open) · fakeredis+Lua 왕복(acquire 한계·TTL 자가회수).
"""
from __future__ import annotations

import time
from unittest.mock import patch

import pytest

from app.services import sse_lease


@pytest.fixture
def _flag_off():
    with patch.object(sse_lease.settings, "sse_lease_redis_enabled", False):
        yield


@pytest.fixture
def _flag_on_fakeredis():
    aioredis = pytest.importorskip("fakeredis.aioredis")
    pytest.importorskip("lupa")  # fakeredis Lua eval 에 필요
    server = aioredis.FakeServer()
    client = aioredis.FakeRedis(server=server, decode_responses=True)
    with patch.object(sse_lease.settings, "sse_lease_redis_enabled", True), \
         patch.object(sse_lease.settings, "redis_url", "redis://fake"), \
         patch("app.services.redis_shared.get_client", return_value=client):
        yield client


# ── flag off / Redis 다운 = None (fail-open·호출부 in-process 폴백) ──────────────
async def test_flag_off_acquire_returns_none(_flag_off):
    assert await sse_lease.acquire("g", 3, "c1") is None  # None → 호출부 폴백(거부 안 함)


async def test_flag_off_count_returns_none(_flag_off):
    assert await sse_lease.count("g") is None


async def test_redis_down_failopen():
    """flag on이나 Redis 클라 None(다운) → acquire/count None·refresh/release no-op. fail-open."""
    with patch.object(sse_lease.settings, "sse_lease_redis_enabled", True), \
         patch.object(sse_lease.settings, "redis_url", "redis://x"), \
         patch("app.services.redis_shared.get_client", return_value=None):
        assert await sse_lease.acquire("g", 3, "c1") is None
        assert await sse_lease.count("g") is None
        await sse_lease.refresh("g", "c1")   # no-op·예외 0
        await sse_lease.release("g", "c1")


# ── fakeredis + Lua 왕복 ───────────────────────────────────────────────────────
async def test_acquire_under_limit_true_and_count(_flag_on_fakeredis):
    assert await sse_lease.acquire("g", 2, "c1") is True
    assert await sse_lease.acquire("g", 2, "c2") is True
    assert await sse_lease.count("g") == 2


async def test_acquire_at_limit_false(_flag_on_fakeredis):
    assert await sse_lease.acquire("g", 2, "c1") is True
    assert await sse_lease.acquire("g", 2, "c2") is True
    assert await sse_lease.acquire("g", 2, "c3") is False  # 한계 초과 = 429/503
    assert await sse_lease.count("g") == 2                  # 초과분은 미획득(ZADD 안 됨)


async def test_release_frees_slot(_flag_on_fakeredis):
    assert await sse_lease.acquire("g", 1, "c1") is True
    assert await sse_lease.acquire("g", 1, "c2") is False   # 꽉 참
    await sse_lease.release("g", "c1")
    assert await sse_lease.acquire("g", 1, "c2") is True     # 명시 반납 후 획득


async def test_ttl_evict_frees_slot(_flag_on_fakeredis):
    """⭐TTL 자가회수: 만료(과거 score) lease는 count/acquire서 자동 evict → 좀비 슬롯 회수(#2128 완화)."""
    key = sse_lease._key("g")
    await _flag_on_fakeredis.zadd(key, {"zombie": time.time() - 1})  # 이미 만료(score ≤ now)
    assert await sse_lease.count("g") == 0                   # evict 됨(명시 release 없이 TTL만으로)
    assert await sse_lease.acquire("g", 1, "c1") is True      # 좀비 자리 회수돼 신규 획득


async def test_refresh_keeps_lease(_flag_on_fakeredis):
    assert await sse_lease.acquire("g", 5, "c1") is True
    await sse_lease.refresh("g", "c1")                        # score 재갱신
    assert await sse_lease.count("g") == 1


async def test_perkey_scopes_independent(_flag_on_fakeredis):
    """per-key 스코프는 agent별 독립 ZSET — 한 agent 한계가 다른 agent에 영향 0."""
    assert await sse_lease.acquire("perkey:A", 1, "c1") is True
    assert await sse_lease.acquire("perkey:A", 1, "c2") is False  # A 꽉 참
    assert await sse_lease.acquire("perkey:B", 1, "c3") is True   # B는 무관·획득


# ── 가드(silent-skip 문 닫기·#2120 교훈) ───────────────────────────────────────
def test_fakeredis_and_lupa_available():
    """dep(fakeredis·lupa)가 빠지면 위 fakeredis 테스트가 조용히 skip되는 문을 닫는다 — plain import로 FAIL."""
    import fakeredis  # noqa: F401
    import lupa  # noqa: F401


# ── story #2582: earliest_expiry — 정확한 Retry-After용 ────────────────────────
async def test_earliest_expiry_none_when_empty(_flag_on_fakeredis):
    assert await sse_lease.earliest_expiry("g") is None  # lease 하나도 없음


async def test_earliest_expiry_none_when_flag_off(_flag_off):
    assert await sse_lease.earliest_expiry("g") is None


async def test_earliest_expiry_returns_soonest_score(_flag_on_fakeredis):
    await sse_lease.acquire("g", 3, "c1")
    await sse_lease.acquire("g", 3, "c2")
    key = sse_lease._key("g")
    # story #3401 — 기대값을 zadd 시점에 한 번만 캡처한다. 예전엔 assert 쪽에서 time.time()을
    # 다시 불러 "지금 기준 +10"과 비교했는데, earliest_expiry()는 그 사이 실제 Redis
    # 라운드트립(비동기 await)을 거친다 — 느린 러너에서 이 간격이 늘어나면 두 time.time()
    # 호출값이 갈라져(±2s 여유를 실측으로 넘긴 사례: 2.47s) 순전히 타이밍만으로 실패했다
    # (develop run 33786510969). earliest_expiry()는 저장된 score를 그대로 반환하므로(재계산
    # 없음), 같은 값과 정확히 비교하면 이 시계열 자체가 사라진다.
    c1_expiry = time.time() + 10
    await _flag_on_fakeredis.zadd(key, {"c1": c1_expiry, "c2": time.time() + 80})
    earliest = await sse_lease.earliest_expiry("g")
    assert earliest == c1_expiry  # c1(가장 이른 것)의 score — 저장한 값과 정확히 같아야 한다


async def test_earliest_expiry_skips_already_expired(_flag_on_fakeredis):
    """이미 만료(score<=now)된 건 evict된 뒤 계산 — 산 것 중 가장 이른 것만 본다."""
    key = sse_lease._key("g")
    # story #3401 — 위 test_earliest_expiry_returns_soonest_score와 동일한 이유로 기대값을
    # zadd 시점에 캡처해 정확 비교(assert 쪽 time.time() 재호출 제거 — 느린 러너에서 실측
    # 2.47s 갈라짐으로 flaky, develop run 33786510969).
    alive_expiry = time.time() + 50
    await _flag_on_fakeredis.zadd(key, {"zombie": time.time() - 5, "alive": alive_expiry})
    earliest = await sse_lease.earliest_expiry("g")
    assert earliest == alive_expiry


async def test_earliest_expiry_none_when_live_full(_flag_on_fakeredis):
    """PO 리뷰(2026-08-12) — 가장 이른 lease조차 막 갱신돼(remaining이 [TTL-heartbeat, TTL]
    구간) 아직 beat를 놓친 게 아니면(=live-full, 한도를 채운 살아있는 세션들), 만료 기반
    예측이 성립하지 않는다 — None으로 호출부가 flat default로 폴백하게 한다."""
    key = sse_lease._key("g")
    # TTL=90, heartbeat=30 (테스트 기본 env) — 셋 다 막 갱신돼 [60,90] 구간 안.
    await _flag_on_fakeredis.zadd(key, {
        "live-0": time.time() + 85, "live-1": time.time() + 88, "live-2": time.time() + 90,
    })
    assert await sse_lease.earliest_expiry("g") is None


async def test_earliest_expiry_computed_exactly_at_orphan_threshold(_flag_on_fakeredis):
    """remaining == TTL-heartbeat(정확히 beat 1회분 경과) — orphan 쪽 경계, 여전히 computed."""
    key = sse_lease._key("g")
    threshold = sse_lease._TTL_SEC - sse_lease._HEARTBEAT_SEC
    await _flag_on_fakeredis.zadd(key, {"edge": time.time() + threshold})
    earliest = await sse_lease.earliest_expiry("g")
    assert earliest is not None
