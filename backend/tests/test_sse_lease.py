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
