from __future__ import annotations

import sys

from fastapi import Request
from slowapi import Limiter
from slowapi.util import get_remote_address

from app.core.config import settings


def _rate_key(request: Request) -> str:
    """IP 기반 rate key — API Key 요청은 키별 별도 공간으로 분리 (높은 임계값 효과)."""
    auth = request.headers.get("Authorization", "")
    if auth.startswith("Bearer sk_live_"):
        # API Key마다 독립 공간 → 실질적 높은 임계값
        return f"api_key:{auth[7:37]}"
    return get_remote_address(request)


_TESTING = "pytest" in sys.modules

# story #2444(2026-08-04): 이 인스턴스는 여전히 in-memory(storage_uri 미지정) — login·refresh·
# switch-account 등 8개 auth-critical 라우트가 공유한다. PO 결정(가용성 우선): Redis 로 옮기지
# 않는다 — 옮기면 Redis 블립 순간 로그인 전체가 막힐 위험(공유 인스턴스 blast radius). 인스턴스별
# 카운터가 느슨해지는 것(브루트포스 ×인스턴스수)은 알려진 별개 우려로 이 스토리 스코프 밖(후속).
limiter = Limiter(
    key_func=_rate_key,
    enabled=not _TESTING,
)

# story #2444: resend-verification 「전용」 격리 Limiter — 어뷰징 방지가 목적(선생님 명시)이라
# 위 공유 limiter와 반대로 fail-closed 를 원한다. Redis 설정 時(prod) storage_uri 로 전역
# «인스턴스 수 무관 3/hour» 강제. 미설정(로컬 dev, Redis 안 띄움) 時 memory:// 폴백 — dev 는
# 단일 인스턴스라 분산 보장이 애초에 불필요, 오늘 동작과 동일.
# wrap_exceptions=True — 원 redis-py 예외(ConnectionError 등)를 limits.errors.StorageError
# 로 통일해, main.py 의 전용 핸들러가 백엔드 종류와 무관하게 503 으로 fail-closed 처리한다.
resend_verification_limiter = Limiter(
    key_func=_rate_key,
    storage_uri=settings.redis_url or "memory://",
    storage_options={"wrap_exceptions": True},
    enabled=not _TESTING,
)
