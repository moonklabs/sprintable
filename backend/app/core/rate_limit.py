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
def _rate_key_by_client_ip(request: Request) -> str:
    """story #4398 1단계 — `_rate_key`와 같되 IP는 `client_ip`(프런트가 정한 사용자 IP · 아니면 앞단이 붙인 접속 주소)로.
    전 사용자 합산으로 묶일 때 가장 무거운 Redis 전역 둘(set-password/request · resend-verification)부터 옮긴다 — 공유 limiter는 2단계."""
    from app.core.client_ip import client_ip

    auth = request.headers.get("Authorization", "")
    if auth.startswith("Bearer sk_live_"):
        return f"api_key:{auth[7:37]}"
    return client_ip(request)


resend_verification_limiter = Limiter(
    key_func=_rate_key_by_client_ip,
    storage_uri=settings.redis_url or "memory://",
    storage_options={"wrap_exceptions": True},
    enabled=not _TESTING,
)


# story #4424 (PO 13:04Z) — the desktop setup's open routes (no login: setup-codes · exchange · onboarding events), counted per
# user IP. The shared `limiter` keys on the socket address, which on Cloud Run is the front end's — every user in one count.
# In-memory like the shared one (fail-open: a counting problem never blocks a setup); not the resend limiter's Redis
# fail-closed. Moving the shared limiter's 8 auth routes is 4398's second step, not this.
def _rate_key_client_ip_only(request: Request) -> str:
    """The user's IP and nothing else (Qadir 4828): these routes take no login, so an `Authorization: Bearer sk_live_…` on
    them is never checked — keying on it would let every request bring its own count."""
    from app.core.client_ip import client_ip

    return client_ip(request)


open_setup_limiter = Limiter(
    key_func=_rate_key_client_ip_only,
    enabled=not _TESTING,
)


# story 4427 (나) · PO 02:28Z / 02:57Z — limits keyed by the **signed-in person**, for routes only a person's session reaches
# (`confirm-new-org` · `recipes/for-new-org`). slowapi's key function runs before authentication, so a user id taken from the
# token there would be unverified (each request could bring a new id and a fresh count — the 4828 trap). These are counted in
# the handler instead, with the `auth.user_id` that `get_current_user` verified. In-memory like `open_setup_limiter` (fail-open:
# a counting problem never blocks a person); each instance counts on its own, the known limit the shared limiter has too.
from limits import parse as _parse_limit  # noqa: E402
from limits.storage import MemoryStorage as _MemoryStorage  # noqa: E402
from limits.strategies import MovingWindowRateLimiter as _MovingWindow  # noqa: E402

_person_limit_storage = _MemoryStorage()
_person_limiter = _MovingWindow(_person_limit_storage)


def hit_person_limits(scope: str, user_id: str, *specs: str) -> int | None:
    """Counts one request of `user_id` in `scope` against every limit in `specs` ("3/hour", "10/day"). None = allowed; otherwise
    the seconds until a retry can pass (for `Retry-After`). All windows are checked before any is counted, so a request refused
    by one window uses up none."""
    import time

    items = [_parse_limit(s) for s in specs]
    for item in items:
        if not _person_limiter.test(item, scope, user_id):
            reset_at, _remaining = _person_limiter.get_window_stats(item, scope, user_id)
            return max(1, int(reset_at - time.time()) + 1)
    for item in items:
        _person_limiter.hit(item, scope, user_id)
    return None


def reset_person_limits() -> None:
    """Tests only: forget every count."""
    _person_limit_storage.reset()
