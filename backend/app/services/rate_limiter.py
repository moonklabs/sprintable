from __future__ import annotations

import asyncio
import hashlib
import time
from abc import ABC, abstractmethod
from collections import defaultdict, deque

TIER_LIMITS: dict[str, int] = {
    "free": 60,
    "team": 300,
    "pro": 1000,
    "jwt": 100,
}

WINDOW_SECS = 60


class RateLimiter(ABC):
    @abstractmethod
    async def check(self, key: str, limit: int) -> tuple[bool, int, int]:
        """Returns (allowed, remaining, retry_after_secs)."""


class InMemoryRateLimiter(RateLimiter):
    def __init__(self) -> None:
        self._windows: dict[str, deque[float]] = defaultdict(deque)
        self._lock = asyncio.Lock()

    async def check(self, key: str, limit: int) -> tuple[bool, int, int]:
        async with self._lock:
            now = time.monotonic()
            dq = self._windows[key]
            cutoff = now - WINDOW_SECS
            while dq and dq[0] <= cutoff:
                dq.popleft()
            if len(dq) >= limit:
                retry_after = max(1, int(dq[0] - cutoff) + 1)
                return False, 0, retry_after
            dq.append(now)
            return True, limit - len(dq), 0


class RedisRateLimiter(RateLimiter):
    def __init__(self, redis_url: str) -> None:
        import redis.asyncio as aioredis  # type: ignore[import]

        self._redis = aioredis.from_url(redis_url, decode_responses=True)

    async def check(self, key: str, limit: int) -> tuple[bool, int, int]:
        import time as _time

        now = _time.time()
        cutoff = now - WINDOW_SECS
        pipe = self._redis.pipeline()
        rkey = f"rl:{key}"
        pipe.zremrangebyscore(rkey, "-inf", cutoff)
        pipe.zadd(rkey, {str(now): now})
        pipe.zcard(rkey)
        pipe.expire(rkey, WINDOW_SECS + 5)
        results = await pipe.execute()
        count = results[2]
        if count > limit:
            oldest = await self._redis.zrange(rkey, 0, 0, withscores=True)
            retry_after = max(1, int(oldest[0][1] - cutoff) + 1) if oldest else 1
            await self._redis.zrem(rkey, str(now))
            return False, 0, retry_after
        return True, limit - count, 0


_limiter: RateLimiter | None = None


def get_rate_limiter() -> RateLimiter:
    global _limiter
    if _limiter is None:
        from app.core.config import settings

        if settings.rate_limit_backend == "redis":
            _limiter = RedisRateLimiter(settings.redis_url)
        else:
            _limiter = InMemoryRateLimiter()
    return _limiter


def hash_api_key(plaintext: str) -> str:
    return hashlib.sha256(plaintext.encode()).hexdigest()
