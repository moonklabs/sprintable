from __future__ import annotations

import asyncio
import hashlib
import logging
import time
from abc import ABC, abstractmethod
from collections import defaultdict, deque

logger = logging.getLogger(__name__)

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


def warn_if_rate_limit_backend_is_memory(s=None) -> None:
    """story #3418 AC2 — 카디르 실측(dev, 2026-09-04): 백엔드 인스턴스가 최소 3개인데
    `rate_limit_backend` 기본값이 `"memory"`라 `get_rate_limiter()`가 만드는
    `InMemoryRateLimiter`가 프로세스 로컬 상태다 — beacon dedup(1분 내 재요청 억제)을
    포함해 이 서비스를 쓰는 모든 레이트리밋이 인스턴스마다 따로 세게 된다(한도가 사실상
    「인스턴스 수 배」로 느슨해짐).

    ⚠️이 가드가 못 잡는 것(docstring 선언, 카디르 QA 관례) — 앱 프로세스는 자기가 몇 개의
    인스턴스로 떠 있는지 모른다. 그래서 "정말 여러 인스턴스인데 memory"를 직접 검증하지
    못하고, "memory인데 로컬이 아니다"(=Cloud Run 등 배포 환경, 통상 min-instances 여러
    개로 뜬다)까지만 판정한다 — 로컬 단일 프로세스 개발(`is_really_local`)은 그 자체로
    무해해 조용히 넘긴다."""
    if s is None:
        from app.core.config import settings as s

    if s.rate_limit_backend != "redis" and not s.is_really_local:
        logger.warning(
            "[startup] rate_limit_backend=%s(기본값) — 인스턴스가 여러 개면 레이트리밋·"
            "beacon dedup이 인스턴스별로 갈라진다(story #3418, dev 실측 1→2). "
            "RATE_LIMIT_BACKEND=redis 배선 권장.",
            s.rate_limit_backend,
        )
