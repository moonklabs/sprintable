"""story #3418(카디르 실측 2026-09-04 · 페드루 PO 確定) — 백엔드 인스턴스가 최소 3개인데
`rate_limit_backend` 기본값이 `"memory"`라 dedup·레이트리밋이 인스턴스마다 따로 세던 결함.

AC4 — `RedisRateLimiter` 경로 단위 테스트(기존엔 없었다, 이 파일이 그 기준선). `get_rate_
limiter()`의 분기·`InMemoryRateLimiter`의 기존 동작(윈도우 슬라이딩·독립 키)도 같은 파일에서
커버해 「기존 memory 테스트 불변」의 기준선 자체를 세운다."""
from __future__ import annotations

from types import SimpleNamespace

import pytest

from app.services import rate_limiter as rl_module
from app.services.rate_limiter import (
    WINDOW_SECS,
    InMemoryRateLimiter,
    RedisRateLimiter,
    get_rate_limiter,
    warn_if_rate_limit_backend_is_memory,
)


@pytest.fixture
def anyio_backend():
    return "asyncio"


@pytest.fixture(autouse=True)
def _reset_singleton():
    """get_rate_limiter()의 모듈 전역 싱글턴(`_limiter`)이 테스트 간 새 나가지 않게 리셋—
    안 하면 앞선 테스트가 만든 InMemoryRateLimiter/RedisRateLimiter가 뒤 테스트의 settings
    변경과 무관하게 그대로 재사용돼(첫 호출만 실제로 분기) 이 파일의 분기 테스트 자체가
    순서에 취약해진다."""
    rl_module._limiter = None
    yield
    rl_module._limiter = None


# --- get_rate_limiter() 분기 ---------------------------------------------------


def test_get_rate_limiter_defaults_to_in_memory(monkeypatch):
    from app.core.config import settings

    monkeypatch.setattr(settings, "rate_limit_backend", "memory")
    assert isinstance(get_rate_limiter(), InMemoryRateLimiter)


def test_get_rate_limiter_redis_backend_returns_redis_rate_limiter(monkeypatch):
    from app.core.config import settings

    monkeypatch.setattr(settings, "rate_limit_backend", "redis")
    monkeypatch.setattr(settings, "redis_url", "redis://fake-host:6379/0")

    class _StubRedisClient:
        pass

    def _fake_from_url(url, decode_responses=True):
        assert url == "redis://fake-host:6379/0", "settings.redis_url이 그대로 안 전달됨"
        return _StubRedisClient()

    import redis.asyncio as aioredis

    monkeypatch.setattr(aioredis, "from_url", _fake_from_url)
    assert isinstance(get_rate_limiter(), RedisRateLimiter)


def test_get_rate_limiter_is_singleton_within_process(monkeypatch):
    from app.core.config import settings

    monkeypatch.setattr(settings, "rate_limit_backend", "memory")
    a = get_rate_limiter()
    b = get_rate_limiter()
    assert a is b, "모듈 전역 싱글턴이 호출마다 새 인스턴스를 만듦(불필요한 상태 유실)"


# --- InMemoryRateLimiter --------------------------------------------------------


@pytest.mark.anyio
async def test_in_memory_allows_up_to_limit_then_blocks():
    limiter = InMemoryRateLimiter()
    key = "test-key"
    results = [await limiter.check(key, 3) for _ in range(4)]
    assert [r[0] for r in results] == [True, True, True, False]


@pytest.mark.anyio
async def test_in_memory_different_keys_independent():
    limiter = InMemoryRateLimiter()
    for _ in range(3):
        await limiter.check("key-a", 3)
    allowed, _, _ = await limiter.check("key-b", 3)
    assert allowed is True


# --- RedisRateLimiter(fakeredis) ------------------------------------------------


@pytest.fixture
def _fake_redis_limiter(monkeypatch):
    """RedisRateLimiter를 fakeredis 백엔드로 왕복시킨다 — SSE lease(test_sse_lease.py)와
    달리 이 클래스의 명령(zremrangebyscore/zadd/zcard/expire/zrange/zrem)은 순수 ZSET
    명령뿐이라 Lua EVAL이 필요 없다(lupa 불요, 실측 확認)."""
    aioredis_fake = pytest.importorskip("fakeredis.aioredis")
    server = aioredis_fake.FakeServer()
    client = aioredis_fake.FakeRedis(server=server, decode_responses=True)

    import redis.asyncio as aioredis

    monkeypatch.setattr(aioredis, "from_url", lambda url, decode_responses=True: client)
    return RedisRateLimiter("redis://fake/0"), client


@pytest.mark.anyio
async def test_redis_limiter_key_format(_fake_redis_limiter):
    """AC4 — 실제 Redis 키가 `rl:{key}` 형식으로 쌓이는지(운영 조회·TTL 확인이 이 형식에
    의존한다)."""
    limiter, client = _fake_redis_limiter
    await limiter.check("beacon:org1:/p:ua-x", 5)
    assert await client.keys("rl:*") == ["rl:beacon:org1:/p:ua-x"]


@pytest.mark.anyio
async def test_redis_limiter_sets_ttl_window_plus_5(_fake_redis_limiter):
    """AC4 — TTL이 WINDOW_SECS+5로 설정되는지(무기한 축적 방지 — story #2461류 「상한 없는
    누적」 finding과 동일 클래스 재발 방지)."""
    limiter, client = _fake_redis_limiter
    await limiter.check("ttl-key", 5)
    ttl = await client.ttl("rl:ttl-key")
    assert WINDOW_SECS < ttl <= WINDOW_SECS + 5, f"TTL={ttl}, 기대범위=({WINDOW_SECS}, {WINDOW_SECS + 5}]"


@pytest.mark.anyio
async def test_redis_limiter_allows_up_to_limit_then_blocks(_fake_redis_limiter):
    limiter, _ = _fake_redis_limiter
    key = "enforce-key"
    results = [await limiter.check(key, 3) for _ in range(4)]
    assert [r[0] for r in results] == [True, True, True, False]


@pytest.mark.anyio
async def test_redis_limiter_different_keys_independent(_fake_redis_limiter):
    limiter, _ = _fake_redis_limiter
    for _ in range(3):
        await limiter.check("key-a", 3)
    allowed, _, _ = await limiter.check("key-b", 3)
    assert allowed is True


@pytest.mark.anyio
async def test_redis_limiter_removes_own_entry_when_blocked_no_unbounded_growth(_fake_redis_limiter):
    """양성대조 — check()가 초과 판정 시 방금 추가한 자기 entry를 zrem으로 되돌리는지.
    안 그러면 거부된 요청마다 ZSET이 계속 자라 count가 절대 limit 아래로 안 줄어드는
    결함(뮤테이션: 이 zrem 라인을 지우면 5회 호출 뒤 count가 2가 아니라 5가 돼 RED)."""
    limiter, client = _fake_redis_limiter
    key = "no-growth-key"
    for _ in range(5):
        await limiter.check(key, 2)
    assert await client.zcard(f"rl:{key}") == 2


# --- warn_if_rate_limit_backend_is_memory() (AC2) -------------------------------


def _s(**overrides):
    base = {"rate_limit_backend": "memory", "is_really_local": True}
    base.update(overrides)
    return SimpleNamespace(**base)


def test_warn_fires_when_memory_and_not_local(caplog):
    """AC2 — 배포 환경(로컬 아님)인데 memory면 경고 1줄."""
    import logging

    with caplog.at_level(logging.WARNING, logger=rl_module.__name__):
        warn_if_rate_limit_backend_is_memory(_s(rate_limit_backend="memory", is_really_local=False))
    assert any("rate_limit_backend" in r.message for r in caplog.records)


def test_warn_silent_when_redis(caplog):
    import logging

    with caplog.at_level(logging.WARNING, logger=rl_module.__name__):
        warn_if_rate_limit_backend_is_memory(_s(rate_limit_backend="redis", is_really_local=False))
    assert caplog.records == []


def test_warn_silent_when_memory_but_truly_local(caplog):
    """가드가 못 잡는 축(docstring 선언) — 로컬 단일 프로세스는 memory가 그 자체로 무해해
    조용히 넘긴다(매 로컬 기동마다 경고 스팸 방지)."""
    import logging

    with caplog.at_level(logging.WARNING, logger=rl_module.__name__):
        warn_if_rate_limit_backend_is_memory(_s(rate_limit_backend="memory", is_really_local=True))
    assert caplog.records == []


def test_warn_reads_real_settings_by_default(monkeypatch, caplog):
    """s=None 기본 인자가 실제 app.core.config.settings를 읽는지(스텁만 통과하고 실제
    배선은 안 되는 회귀 방지 — check_internal_secret_config 등과 동일 관례).

    `is_really_local`은 읽기전용 프로퍼티(K_SERVICE/PYTEST_CURRENT_TEST/SPRINTABLE_
    LOCAL_DEV 신호 파생, config.py)라 인스턴스 setattr로는 못 덮는다 — 클래스 속성을
    통째로 다른 property로 교체(monkeypatch가 테스트 뒤 원복)."""
    import logging

    from app.core.config import Settings, settings

    monkeypatch.setattr(settings, "rate_limit_backend", "memory")
    monkeypatch.setattr(Settings, "is_really_local", property(lambda self: False))
    with caplog.at_level(logging.WARNING, logger=rl_module.__name__):
        warn_if_rate_limit_backend_is_memory()
    assert any("rate_limit_backend" in r.message for r in caplog.records)


# --- /api/v2/health rate_limit_backend 노출(AC2) ---------------------------------


@pytest.mark.anyio
async def test_health_endpoint_exposes_rate_limit_backend_value(monkeypatch):
    from unittest.mock import AsyncMock

    from httpx import ASGITransport, AsyncClient

    from app.core.config import settings
    from app.main import app
    from tests.conftest import override_db_and_read

    monkeypatch.setattr(settings, "rate_limit_backend", "redis")

    mock_session = AsyncMock()
    mock_session.execute = AsyncMock(return_value=None)

    async def _override():
        yield mock_session

    override_db_and_read(app, _override)
    try:
        async with AsyncClient(transport=ASGITransport(app=app), base_url="http://test") as client:
            response = await client.get("/api/v2/health")
    finally:
        app.dependency_overrides.clear()

    assert response.status_code == 200
    assert response.json()["rate_limit_backend"] == "redis"
