from __future__ import annotations

import collections
import logging
import secrets
import sys
import threading

from fastapi import Request
from slowapi import Limiter

from app.core.config import settings

logger = logging.getLogger(__name__)


def _rate_key_client_ip_only(request: Request) -> str:
    """The user's address (folded to a person-sized unit) and nothing else — story 4915 AC6.

    Before: the shared limiter keyed on the SOCKET address, which on the VM is the front end's own container — every user in one count (login 10/min and sign-up 5/min for ALL users together,
    refresh 20/min). And a branch keyed `Authorization: Bearer sk_live_…` by the first 30 characters of the UNVERIFIED header: a key function runs before authentication, so a request that
    brings a new `sk_live_<anything>` each time brought a new count each time (the 4828 trap, which `open_setup_limiter` avoided but this one did not). Every route on this limiter is a person's
    session or no login at all — none needs an API-key branch (an API key's own limit is `dependencies/rate_limit.py`, counted after the key is checked).

    The address is `client_ip` (the front end's word with the shared secret, or the front door's overwritten X-Forwarded-For) folded by `fold_ip` (IPv6 → its /64). One line is logged per request:
    a short hash of the key and the way the address was decided (edge · xff · cf · socket) — never the address. A `socket` that is common means the deployment's settings are wrong."""
    cached = getattr(request.state, "_rate_ip_key", None)
    if cached is not None:
        return cached
    from app.core.client_ip import client_ip_with_source, fold_ip

    ip, via = client_ip_with_source(request)
    key = fold_ip(ip)
    request.state._rate_ip_key = key
    route = request.scope.get("route")
    logger.info("rate_limit.key id=%s via=%s method=%s route=%s", _key_id(key), via, request.method, getattr(route, "path", None) or "?")  # the route template (/legal/{doc_type}), never the raw path a client typed
    return key


_KEY_ID_SALT = secrets.token_hex(16)  # per PROCESS and random: no real secret is reused, and the ids of one run cannot be linked to the ids of another (a restart starts a new set)


def _key_id(key: str) -> str:
    """first 8 hex of a salted hash of the key — enough to count how many different keys there are inside one run, not enough to read an address back"""
    import hashlib

    return hashlib.sha256(f"{_KEY_ID_SALT}|{key}".encode()).hexdigest()[:8]


_TESTING = "pytest" in sys.modules

# story #2444(2026-08-04): 이 인스턴스는 여전히 in-memory(storage_uri 미지정) — login·refresh·
# switch-account 등 8개 auth-critical 라우트가 공유한다. PO 결정(가용성 우선): Redis 로 옮기지
# 않는다 — 옮기면 Redis 블립 순간 로그인 전체가 막힐 위험(공유 인스턴스 blast radius). 인스턴스별
# 카운터가 느슨해지는 것(브루트포스 ×인스턴스수)은 알려진 별개 우려로 이 스토리 스코프 밖(후속).
limiter = Limiter(
    key_func=_rate_key_client_ip_only,
    enabled=not _TESTING,
)

# story #2444: resend-verification 「전용」 격리 Limiter — 어뷰징 방지가 목적(선생님 명시)이라
# 위 공유 limiter와 반대로 fail-closed 를 원한다. Redis 설정 時(prod) storage_uri 로 전역
# «인스턴스 수 무관 3/hour» 강제. 미설정(로컬 dev, Redis 안 띄움) 時 memory:// 폴백 — dev 는
# 단일 인스턴스라 분산 보장이 애초에 불필요, 오늘 동작과 동일.
# wrap_exceptions=True — 원 redis-py 예외(ConnectionError 등)를 limits.errors.StorageError
# 로 통일해, main.py 의 전용 핸들러가 백엔드 종류와 무관하게 503 으로 fail-closed 처리한다.
resend_verification_limiter = Limiter(
    key_func=_rate_key_client_ip_only,
    storage_uri=settings.redis_url or "memory://",
    storage_options={"wrap_exceptions": True},
    enabled=not _TESTING,
)


# story #4424 (PO 13:04Z) — the desktop setup's open routes (no login: setup-codes · exchange · onboarding events), counted per
# user IP. The shared `limiter` keys on the socket address, which on Cloud Run is the front end's — every user in one count.
# In-memory like the shared one (fail-open: a counting problem never blocks a setup); not the resend limiter's Redis
# fail-closed. Moving the shared limiter's 8 auth routes is 4398's second step, not this.
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

# story 4915 AC6 — refresh is counted per PERSON as well as per address. A page load with an expired access token makes several requests at once and each one asks for a refresh (the winner rotates, the rest get a fork — see
# `refresh_token`), so the count that matters for «a loop must stop» is one person's, not a shared address's. The person is the `sub` of a refresh token whose SIGNATURE was checked (an unsigned/forged token
# has no `sub` we count — it is a plain 401 before this), counted in the handler (never in a key function: that runs before the token is checked — the 4828 trap). In-memory, fail-open, like `hit_person_limits`.
# 60/min is ten times the largest burst seen (6 at once) — room for the client retries that follow a 429 too; the address floor on the route is 120/min.
REFRESH_PERSON_LIMIT = "60/minute"


def hit_refresh_person_limit(user_id: str) -> int | None:
    """None = allowed; otherwise the seconds until a retry can pass."""
    return hit_person_limits("auth.refresh", user_id, REFRESH_PERSON_LIMIT)


# story 4915 AC6 — one WARNING line (no blocking yet) when one address fails to sign in as many DIFFERENT accounts: a spray that stays under every per-account lock-out (4839: 5 failures on one account → 5 minutes).
# The address is the rate key (folded, the same unit the limits count); the emails are kept only as short hashes, in memory, for the window. BOUNDED on both axes (codex 01a1d2f6): at most
# `_FAILED_LOGIN_MAX_KEYS` addresses (the least recently seen is dropped first — O(1)) and `_FAILED_LOGIN_MAX_PER_KEY` account hashes per address (the oldest dropped), so memory is a fixed ceiling whatever the traffic;
# an address's entries expire when that address is next seen. The warning is written ONCE per address per window (not on every failure after the tenth).
_FAILED_LOGIN_WINDOW_SECONDS = 600
_FAILED_LOGIN_DISTINCT_WARN = 10
_FAILED_LOGIN_MAX_KEYS = 2000
_FAILED_LOGIN_MAX_PER_KEY = 32
_failed_logins: "collections.OrderedDict[str, dict]" = collections.OrderedDict()


_failed_logins_lock = threading.Lock()   # the handlers run on one event loop (serial), but a thread path must not corrupt the two maps either
_FAILED_LOGIN_EMAIL_MAX_CHARS = 320       # RFC 5321 address limit — the hash is never made of an unbounded string


def note_failed_login(request: Request, email: str, *, now: float | None = None) -> int:
    """Counts a failed sign-in of `email` from this request's address; returns how many DIFFERENT accounts failed from it inside the window (at most `_FAILED_LOGIN_MAX_PER_KEY`). Warns once per window from the 10th on."""
    import hashlib
    import time

    t = time.time() if now is None else now
    key = _rate_key_client_ip_only(request)
    digest = hashlib.sha256(email.strip().lower()[:_FAILED_LOGIN_EMAIL_MAX_CHARS].encode()).hexdigest()[:12]
    with _failed_logins_lock:
        return _note_failed_login_locked(key, digest, t)


def _note_failed_login_locked(key: str, h: str, t: float) -> int:
    entry = _failed_logins.get(key)
    if entry is None:
        entry = _failed_logins[key] = {"seen": {}, "warned_at": None}
        if len(_failed_logins) > _FAILED_LOGIN_MAX_KEYS:
            _failed_logins.popitem(last=False)
    else:
        _failed_logins.move_to_end(key)
    seen = entry["seen"]
    cutoff = t - _FAILED_LOGIN_WINDOW_SECONDS
    for expired in [k for k, ts in seen.items() if ts < cutoff]:
        del seen[expired]
    seen.pop(h, None)
    seen[h] = t  # most recent last
    while len(seen) > _FAILED_LOGIN_MAX_PER_KEY:
        seen.pop(next(iter(seen)))
    distinct = len(seen)
    if distinct >= _FAILED_LOGIN_DISTINCT_WARN and (entry["warned_at"] is None or entry["warned_at"] < cutoff):
        entry["warned_at"] = t
        logger.warning("auth.login possible_spray key=%s distinct_accounts_failed=%d window_s=%d", _key_id(key), distinct, _FAILED_LOGIN_WINDOW_SECONDS)
    return distinct


def reset_failed_logins() -> None:
    """Tests only."""
    _failed_logins.clear()



# story 4714 (AC2 · mail me the Mac link) — a person-keyed limit that FAILS CLOSED, for the one route that sends mail to the
# outside. Same reason as `resend_verification_limiter` (abuse of a mail sender must not slip through when counting breaks):
# Redis when the deployment has one (a count shared by every instance), memory otherwise (single-instance dev), and a storage
# problem raises `limits.errors.StorageError` — `main.py` answers it 503. The key is the signed-in person (counted in the
# handler with the id `get_current_user` verified — never a header read before authentication, the 4828 trap), not an IP: a
# phone network's address is shared by many people.
from limits.storage import storage_from_string as _storage_from_string  # noqa: E402

_strict_person_limit_storage = _storage_from_string(settings.redis_url or "memory://", wrap_exceptions=True)
_strict_person_limiter = _MovingWindow(_strict_person_limit_storage)


def hit_person_limits_strict(scope: str, user_id: str, *specs: str) -> int | None:
    """Counts one request of `user_id` in `scope` against every limit in `specs`, TIGHTEST FIRST ("1/minute", "3/hour"). None =
    allowed; otherwise the seconds until a retry can pass (for `Retry-After`).

    Each window is `hit()` — one atomic step that counts and answers (Redis: one script; memory: one lock) — never a `test()` then
    a `hit()`: two requests that arrive together would both pass the test before either was counted (codex 01a15033). A refusal
    stops at the first window that is full, so the looser windows after it are not used up by a request that never got through;
    the looser window counts only requests the tighter ones let by. A storage problem is NOT swallowed: it raises `StorageError`,
    so the caller refuses instead of sending."""
    import time

    hit_items = []
    for spec in specs:
        item = _parse_limit(spec)
        hit_items.append(item)
        if not _strict_person_limiter.hit(item, scope, user_id):
            # the answer is the LAST of the resets of every window this request touched: the tighter windows it already counted in stay
            # recorded, so a retry earlier than the longest of them would only be refused again (codex 01a1506a)
            reset_at = max(_strict_person_limiter.get_window_stats(i, scope, user_id)[0] for i in hit_items)
            return max(1, int(reset_at - time.time()) + 1)
    return None


def reset_strict_person_limits() -> None:
    """Tests only: forget every count."""
    _strict_person_limit_storage.reset()
