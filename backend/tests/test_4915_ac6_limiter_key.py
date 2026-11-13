"""story 4915 AC6 — the request limits count a PERSON-sized address (and refresh also a person), not the one socket address every user shared.

Measured on the VM (dev, 11-13): every access-log address was the front end's container (172.18.0.5), so the shared `limiter` (login 10/min · sign-up 5/min · refresh 20/min …) was ONE count for all users; and its key function
keyed `Authorization: Bearer sk_live_…` by the first 30 characters of an UNVERIFIED header — a request that brought a new `sk_live_<anything>` each time brought a new count each time (the 4828 trap).
Security lens (Qadir, 11-13): IP-only keys on the person-authenticated routes · IPv6 folded to its /64 · refresh counted per verified `sub` (60/min) with the address floor at 120/min.
"""
from __future__ import annotations

import uuid

import httpx
import pytest
from fastapi import FastAPI, Request
from slowapi import Limiter
from slowapi.errors import RateLimitExceeded
from starlette.responses import JSONResponse

from app.core.client_ip import CLIENT_IP_HEADER, EDGE_KEY_HEADER, client_ip_with_source, fold_ip

_SECRET = "edge-secret-4915"


def _request(headers: dict[str, str], peer: str = "172.18.0.5") -> Request:
    return Request({
        "type": "http", "method": "POST", "path": "/auth/refresh", "query_string": b"",
        "headers": [(k.lower().encode(), v.encode()) for k, v in headers.items()],
        "client": (peer, 5555),
    })


@pytest.fixture
def anyio_backend():
    return "asyncio"


@pytest.fixture
def with_secret(monkeypatch):
    from app.core.config import settings

    monkeypatch.setattr(settings, "edge_client_ip_secret", _SECRET)


@pytest.fixture
def on_vm_behind_caddy(monkeypatch):
    from app.core.config import settings

    monkeypatch.delenv("K_SERVICE", raising=False)
    monkeypatch.setattr(settings, "trust_forwarded_for", True)


def _shared_key(req: Request) -> str:
    from app.core.rate_limit import limiter

    return limiter._key_func(req)


# ── fold_ip: a person-sized address ──

def test_two_addresses_of_the_same_ipv6_slash_64_are_one_key():
    assert fold_ip("2001:db8:1:2::1") == fold_ip("2001:db8:1:2:aaaa:bbbb:cccc:dddd") == "2001:db8:1:2::/64"


def test_different_ipv6_slash_64_are_different_keys():
    assert fold_ip("2001:db8:1:2::1") != fold_ip("2001:db8:1:3::1")


def test_an_ipv4_mapped_ipv6_address_is_the_same_key_as_its_ipv4():
    assert fold_ip("::ffff:203.0.113.7") == fold_ip("203.0.113.7") == "203.0.113.7"


def test_what_is_not_an_address_is_left_alone():
    assert fold_ip("unknown") == "unknown"


# ── the shared limiter's key ──

def test_the_shared_limiter_and_the_other_ip_limiters_use_the_same_ip_only_key():
    from app.core.rate_limit import _rate_key_client_ip_only, limiter, open_setup_limiter, resend_verification_limiter

    assert limiter._key_func is _rate_key_client_ip_only
    assert open_setup_limiter._key_func is _rate_key_client_ip_only
    assert resend_verification_limiter._key_func is _rate_key_client_ip_only


def test_two_users_behind_one_front_end_socket_are_two_keys(with_secret, monkeypatch):
    monkeypatch.delenv("K_SERVICE", raising=False)
    a = _request({CLIENT_IP_HEADER: "203.0.113.1", EDGE_KEY_HEADER: _SECRET})
    b = _request({CLIENT_IP_HEADER: "203.0.113.2", EDGE_KEY_HEADER: _SECRET})
    assert _shared_key(a) == "203.0.113.1" and _shared_key(b) == "203.0.113.2"


def test_a_wrong_edge_key_is_ignored_and_the_socket_address_is_counted(with_secret, monkeypatch):
    monkeypatch.delenv("K_SERVICE", raising=False)
    req = _request({CLIENT_IP_HEADER: "203.0.113.1", EDGE_KEY_HEADER: "guess"})
    assert _shared_key(req) == "172.18.0.5"


def test_a_forged_left_part_of_x_forwarded_for_never_counts(on_vm_behind_caddy):
    req = _request({"X-Forwarded-For": "1.2.3.4, 203.0.113.9"})
    assert _shared_key(req) == "203.0.113.9"


def test_an_unverified_sk_live_header_does_not_change_the_key(on_vm_behind_caddy):
    """the key function runs before any authentication: a header it cannot check must not pick the count"""
    plain = _shared_key(_request({"X-Forwarded-For": "203.0.113.9"}))
    spoof_a = _shared_key(_request({"X-Forwarded-For": "203.0.113.9", "Authorization": "Bearer sk_live_" + "a" * 22}))
    spoof_b = _shared_key(_request({"X-Forwarded-For": "203.0.113.9", "Authorization": "Bearer sk_live_" + "b" * 22}))
    assert plain == spoof_a == spoof_b == "203.0.113.9"


def test_the_way_the_address_was_decided_is_reported(with_secret, on_vm_behind_caddy):
    assert client_ip_with_source(_request({CLIENT_IP_HEADER: "203.0.113.1", EDGE_KEY_HEADER: _SECRET}))[1] == "edge"
    assert client_ip_with_source(_request({"X-Forwarded-For": "203.0.113.9"})) == ("203.0.113.9", "xff")
    assert client_ip_with_source(_request({}))[1] == "socket"


def test_the_log_names_the_route_template_never_the_raw_path(on_vm_behind_caddy, caplog):
    """a path with an open shape (/legal/{doc_type}) would otherwise print whatever a client types into the log"""
    import logging

    caplog.set_level(logging.INFO, logger="app.core.rate_limit")

    class _Route:
        path = "/api/v2/legal/{doc_type}"

    req = Request({
        "type": "http", "method": "GET", "path": "/api/v2/legal/EVIL%0Aforged-line", "query_string": b"", "route": _Route(),
        "headers": [(b"x-forwarded-for", b"203.0.113.9")], "client": ("172.18.0.5", 5555),
    })
    _shared_key(req)
    [line] = [r.getMessage() for r in caplog.records if r.getMessage().startswith("rate_limit.key")]
    assert "route=/api/v2/legal/{doc_type}" in line and "EVIL" not in line


def test_a_second_edge_key_header_line_never_makes_a_wrong_first_one_right(with_secret, monkeypatch):
    monkeypatch.delenv("K_SERVICE", raising=False)
    req = Request({
        "type": "http", "method": "POST", "path": "/", "query_string": b"",
        "headers": [(CLIENT_IP_HEADER.encode(), b"203.0.113.1"), (EDGE_KEY_HEADER.encode(), b"guess"), (EDGE_KEY_HEADER.encode(), _SECRET.encode())],
        "client": ("172.18.0.5", 5555),
    })
    assert _shared_key(req) == "172.18.0.5"   # the first line is the one read; a right key behind a wrong one does not rescue it


def test_the_key_is_logged_once_per_request_without_the_address(on_vm_behind_caddy, caplog):
    import logging

    caplog.set_level(logging.INFO, logger="app.core.rate_limit")
    req = _request({"X-Forwarded-For": "203.0.113.9"})
    _shared_key(req); _shared_key(req); _shared_key(req)   # slowapi asks once per limit on the route
    lines = [r.getMessage() for r in caplog.records if r.getMessage().startswith("rate_limit.key")]
    assert len(lines) == 1 and "via=xff" in lines[0] and "203.0.113.9" not in lines[0]


# ── through a real limiter (the limit really stops, the key really splits) ──

def _limited_app(per_minute: int) -> FastAPI:
    from app.core.rate_limit import limiter as shared

    limiter = Limiter(key_func=shared._key_func, storage_uri="memory://", enabled=True)   # the REAL shared key function
    app = FastAPI()
    app.state.limiter = limiter

    @app.exception_handler(RateLimitExceeded)
    async def _429(request, exc):  # noqa: ANN001
        return JSONResponse(status_code=429, content={})

    @app.post("/limited")
    @limiter.limit(f"{per_minute}/minute")
    async def limited(request: Request):
        return {"ok": True}

    return app


async def _statuses(app: FastAPI, header_sets: list[dict[str, str]]) -> list[int]:
    async with httpx.AsyncClient(transport=httpx.ASGITransport(app=app), base_url="http://t") as c:
        return [(await c.post("/limited", headers=h)).status_code for h in header_sets]


@pytest.mark.anyio
async def test_twelve_requests_from_one_address_with_a_new_sk_live_each_time_are_stopped(on_vm_behind_caddy):
    """the bypass this story closes: a new `Authorization: Bearer sk_live_<random>` per request used to be a new count per request"""
    app = _limited_app(10)
    headers = [{"X-Forwarded-For": "203.0.113.9", "Authorization": f"Bearer sk_live_{uuid.uuid4().hex[:22]}"} for _ in range(12)]
    assert await _statuses(app, headers) == [200] * 10 + [429] * 2


@pytest.mark.anyio
async def test_two_users_through_the_same_front_end_do_not_use_each_others_count(with_secret, monkeypatch):
    monkeypatch.delenv("K_SERVICE", raising=False)
    app = _limited_app(2)
    users = [{CLIENT_IP_HEADER: f"203.0.113.{n}", EDGE_KEY_HEADER: _SECRET} for n in (1, 2, 3)]
    assert await _statuses(app, users * 2) == [200] * 6


@pytest.mark.anyio
async def test_requests_from_many_addresses_of_one_ipv6_slash_64_are_one_count(on_vm_behind_caddy):
    app = _limited_app(3)
    headers = [{"X-Forwarded-For": f"2001:db8:1:2::{n:x}"} for n in range(1, 6)]
    assert await _statuses(app, headers) == [200, 200, 200, 429, 429]


# ── refresh: counted per verified person, only for a token that is still alive ──

def _refresh_token(user_id: str) -> str:
    from app.core.security import create_refresh_token

    return create_refresh_token(user_id)[0]


class _Result:
    def __init__(self, alive: bool) -> None:
        self._alive = alive

    def first(self):
        return (uuid.uuid4(),) if self._alive else None


class _LiveOrDeadSession:
    """answers the one read the person count makes («is this token still alive?») and nothing else — any other use of the session fails the test"""

    def __init__(self, alive: bool) -> None:
        self.alive = alive
        self.reads = 0

    async def execute(self, stmt):  # noqa: ANN001
        self.reads += 1
        return _Result(self.alive)

    def __getattr__(self, name):
        raise AssertionError(f"the database was touched ({name}) beyond the one liveness read")


async def _post_refresh(token: str, session, ip: str = "203.0.113.50"):
    from app.dependencies.database import get_db, get_read_db
    from app.main import app
    from tests.conftest import override_db_and_read

    async def _provider():
        yield session

    override_db_and_read(app, _provider)
    try:
        async with httpx.AsyncClient(transport=httpx.ASGITransport(app=app), base_url="http://t") as c:
            return await c.post("/api/v2/auth/refresh", json={"refresh_token": token}, headers={"X-Forwarded-For": ip})
    finally:
        app.dependency_overrides.pop(get_db, None)
        app.dependency_overrides.pop(get_read_db, None)


@pytest.fixture(autouse=True)
def _fresh_counts(monkeypatch):
    from app.core import rate_limit
    from app.core.rate_limit import reset_failed_logins, reset_person_limits

    monkeypatch.setattr(rate_limit.limiter, "enabled", True)   # these tests ARE about the limits: pytest switches the shared limiter off by default
    rate_limit.limiter.reset()
    reset_person_limits(); reset_failed_logins()
    yield
    reset_person_limits(); reset_failed_logins()
    rate_limit.limiter.reset()


@pytest.mark.anyio
async def test_sixty_refreshes_pass_the_sixty_first_is_answered_429_with_retry_after_and_another_person_is_not():
    from app.routers.auth import _refresh_person_limit_answer

    heavy, other = uuid.uuid4(), uuid.uuid4()
    alive = _LiveOrDeadSession(True)
    answers = [await _refresh_person_limit_answer(alive, heavy, "h") for _ in range(60)]
    assert answers == [None] * 60                       # the 60 successful calls are really counted (an unconditional 429 or a missing increment fails here)
    limited = await _refresh_person_limit_answer(alive, heavy, "h")
    assert limited is not None and limited.status_code == 429 and int(limited.headers["Retry-After"]) >= 1
    assert b'"RATE_LIMITED"' in limited.body
    assert await _refresh_person_limit_answer(alive, other, "h") is None   # the other person's count is their own


@pytest.mark.anyio
async def test_a_dead_token_is_not_counted_so_holding_an_old_copy_cannot_burn_the_persons_count():
    """codex 01a1d2f6: a validly SIGNED token that is long revoked/expired used to burn the victim's count before any database use"""
    from app.routers.auth import _refresh_person_limit_answer

    victim = uuid.uuid4()
    dead = _LiveOrDeadSession(False)
    assert [await _refresh_person_limit_answer(dead, victim, "old") for _ in range(200)] == [None] * 200
    alive = _LiveOrDeadSession(True)
    assert [await _refresh_person_limit_answer(alive, victim, "live") for _ in range(60)] == [None] * 60   # the victim's own 60 are all still there


@pytest.mark.anyio
async def test_a_token_that_names_no_person_is_not_counted():
    from app.routers.auth import _refresh_person_limit_answer

    assert await _refresh_person_limit_answer(_LiveOrDeadSession(True), None, "h") is None


@pytest.mark.anyio
async def test_the_refresh_route_answers_429_for_a_person_past_the_limit_without_touching_anything_else():
    from app.core.rate_limit import hit_refresh_person_limit

    person = str(uuid.uuid4())
    for _ in range(60):
        assert hit_refresh_person_limit(person) is None
    session = _LiveOrDeadSession(True)
    resp = await _post_refresh(_refresh_token(person), session)
    assert resp.status_code == 429 and resp.json()["error"]["code"] == "RATE_LIMITED" and int(resp.headers["Retry-After"]) >= 1
    assert session.reads == 1       # one liveness read, then the answer — no lock, no rotation, no cookie decision


@pytest.mark.anyio
async def test_a_token_with_a_bad_signature_makes_no_person_count_and_reads_nothing():
    """forged tokens naming a person cannot burn that person's count (they are a plain 401 before the database)"""
    from app.core.rate_limit import hit_refresh_person_limit

    victim = str(uuid.uuid4())
    forged = _refresh_token(victim)[:-4] + "AAAA"
    session = _LiveOrDeadSession(True)
    for _ in range(70):
        resp = await _post_refresh(forged, session)
        assert resp.status_code == 401
    assert session.reads == 0
    assert all(hit_refresh_person_limit(victim) is None for _ in range(60))


def test_the_refresh_route_counts_after_the_signature_and_type_checks_and_before_any_lock_or_write():
    import inspect

    from app.routers import auth

    src = inspect.getsource(auth.refresh_token)
    assert src.index("decode_jwt(body.refresh_token)") < src.index('payload.get("type") != "refresh"') < src.index("_refresh_person_limit_answer") < src.index("_lock_person_sessions") < src.index("update(RefreshToken)")
    helper = inspect.getsource(auth._refresh_person_limit_answer)
    assert helper.index("session.execute") < helper.index("hit_refresh_person_limit")   # alive first, then counted


def test_the_refresh_address_floor_is_120_a_minute():
    from app.core.rate_limit import limiter

    [lim] = [item for name, items in limiter._route_limits.items() if name.endswith(".refresh_token") for item in items]
    assert (lim.limit.amount, lim.limit.GRANULARITY.name) == (120, "minute")


def test_a_request_with_no_peer_at_all_counts_in_one_shared_bucket_by_design(monkeypatch):
    """the fail-closed fallback: when no address can be decided every such request shares one count (conservative against bypass; the log line shows via=socket so it is seen)"""
    monkeypatch.delenv("K_SERVICE", raising=False)
    req = Request({"type": "http", "method": "POST", "path": "/auth/token", "query_string": b"", "headers": []})
    assert _shared_key(req) == "unknown"


# ── sign-in spray warning ──

def test_ten_different_accounts_failing_from_one_address_in_ten_minutes_warns(on_vm_behind_caddy, caplog):
    import logging

    from app.core.rate_limit import note_failed_login

    caplog.set_level(logging.WARNING, logger="app.core.rate_limit")
    req = _request({"X-Forwarded-For": "203.0.113.9"})
    counts = [note_failed_login(req, f"user{n}@example.test", now=1000.0 + n) for n in range(10)]
    assert counts == list(range(1, 11))
    warned = [r for r in caplog.records if "possible_spray" in r.getMessage()]
    assert len(warned) == 1 and "203.0.113.9" not in warned[0].getMessage() and "user" not in warned[0].getMessage()


def test_the_same_account_failing_again_and_again_is_not_a_spray(on_vm_behind_caddy, caplog):
    import logging

    from app.core.rate_limit import note_failed_login

    caplog.set_level(logging.WARNING, logger="app.core.rate_limit")
    req = _request({"X-Forwarded-For": "203.0.113.9"})
    for n in range(30):
        note_failed_login(req, "same@example.test", now=1000.0 + n)
    assert not [r for r in caplog.records if "possible_spray" in r.getMessage()]


def test_failures_older_than_the_window_are_forgotten(on_vm_behind_caddy):
    from app.core.rate_limit import note_failed_login

    req = _request({"X-Forwarded-For": "203.0.113.9"})
    for n in range(9):
        note_failed_login(req, f"user{n}@example.test", now=1000.0)
    assert note_failed_login(req, "late@example.test", now=1000.0 + 601) == 1


def test_the_oauth_handoff_counts_a_folded_address_but_its_audit_keeps_the_real_one(on_vm_behind_caddy):
    from app.routers.auth_firebase_internal import _client_ip, _handoff_rate_key

    v4 = _request({"X-Forwarded-For": "203.0.113.9"})
    v6 = _request({"X-Forwarded-For": "2001:db8:1:2::7"})
    assert _client_ip(v4) == "203.0.113.9" and _client_ip(v6) == "2001:db8:1:2::7"     # the audit line: the exact address
    assert _handoff_rate_key(v4, "issue") == "oauth_handoff_custom_scheme_issue:203.0.113.9"
    assert _handoff_rate_key(v6, "issue") == "oauth_handoff_custom_scheme_issue:2001:db8:1:2::/64"   # the count: the person-sized unit


def test_the_key_function_runs_for_a_request_that_is_only_a_client_and_headers():
    """the direct-call tests (test_1931 · test_cbd578d4) build a request with nothing but `client` and a plain-dict `headers`: no state · scope · method · getlist"""
    from app.core.rate_limit import _rate_key_client_ip_only

    class _Client:
        host = "198.51.100.4"

    class _Bare:
        client = _Client()
        headers: dict[str, str] = {}

    assert _rate_key_client_ip_only(_Bare()) == "198.51.100.4"
    assert _rate_key_client_ip_only(_Bare()) == "198.51.100.4"   # no state to cache on: computed again, same answer


def test_a_plain_dict_headers_request_behind_a_trusted_front_reads_the_forwarded_address(on_vm_behind_caddy):
    from app.core.rate_limit import _rate_key_client_ip_only

    class _Bare:
        client = type("_C", (), {"host": "172.18.0.5"})()
        headers = {"x-forwarded-for": "1.2.3.4, 203.0.113.9"}

    assert _rate_key_client_ip_only(_Bare()) == "203.0.113.9"


def test_the_warning_is_written_once_per_window_not_on_every_failure_after_the_tenth(on_vm_behind_caddy, caplog):
    import logging

    from app.core.rate_limit import note_failed_login

    caplog.set_level(logging.WARNING, logger="app.core.rate_limit")
    req = _request({"X-Forwarded-For": "203.0.113.9"})
    for n in range(25):
        note_failed_login(req, f"user{n}@example.test", now=1000.0 + n)
    assert len([r for r in caplog.records if "possible_spray" in r.getMessage()]) == 1
    note_failed_login(req, "another@example.test", now=1000.0 + 700)    # a new window: one more warning is allowed (the ten earlier entries expired, so it needs ten again)
    for n in range(12):
        note_failed_login(req, f"later{n}@example.test", now=1000.0 + 701 + n)
    assert len([r for r in caplog.records if "possible_spray" in r.getMessage()]) == 2


def test_one_address_keeps_at_most_thirty_two_account_hashes(on_vm_behind_caddy):
    from app.core.rate_limit import _FAILED_LOGIN_MAX_PER_KEY, _failed_logins, note_failed_login

    req = _request({"X-Forwarded-For": "203.0.113.9"})
    counts = [note_failed_login(req, f"user{n}@example.test", now=1000.0) for n in range(500)]
    assert max(counts) == _FAILED_LOGIN_MAX_PER_KEY == 32
    assert len(_failed_logins["203.0.113.9"]["seen"]) == 32


def test_the_number_of_remembered_addresses_has_a_ceiling_and_the_least_recent_goes_first(on_vm_behind_caddy):
    from app.core.rate_limit import _FAILED_LOGIN_MAX_KEYS, _failed_logins, note_failed_login

    for n in range(_FAILED_LOGIN_MAX_KEYS + 100):
        note_failed_login(_request({"X-Forwarded-For": f"10.{n // 65536 % 256}.{n // 256 % 256}.{n % 256}"}), "a@example.test", now=1000.0)
    assert len(_failed_logins) == _FAILED_LOGIN_MAX_KEYS
    assert "10.0.0.0" not in _failed_logins and "10.0.0.99" not in _failed_logins and "10.0.7.255" in _failed_logins


def test_the_log_id_salt_is_random_per_process_and_not_the_jwt_secret():
    import inspect

    from app.core import rate_limit

    assert "jwt_secret" not in inspect.getsource(rate_limit._key_id)
    assert len(rate_limit._KEY_ID_SALT) == 32


def test_the_spray_tracker_survives_many_threads_and_keeps_its_ceilings(on_vm_behind_caddy):
    import threading

    from app.core.rate_limit import _FAILED_LOGIN_MAX_PER_KEY, _failed_logins, note_failed_login

    req = _request({"X-Forwarded-For": "203.0.113.9"})
    errors: list[BaseException] = []

    def work(w: int) -> None:
        try:
            for n in range(200):
                note_failed_login(req, f"user{w}-{n}@example.test", now=1000.0 + n * 0.01)
        except BaseException as e:  # noqa: BLE001
            errors.append(e)

    threads = [threading.Thread(target=work, args=(w,)) for w in range(8)]
    [th.start() for th in threads]; [th.join() for th in threads]
    assert not errors and len(_failed_logins["203.0.113.9"]["seen"]) <= _FAILED_LOGIN_MAX_PER_KEY


def test_an_enormous_email_is_cut_before_it_is_hashed_and_counts_like_its_prefix(on_vm_behind_caddy):
    from app.core.rate_limit import _FAILED_LOGIN_EMAIL_MAX_CHARS, note_failed_login

    req = _request({"X-Forwarded-For": "203.0.113.9"})
    base = "a" * _FAILED_LOGIN_EMAIL_MAX_CHARS
    assert note_failed_login(req, base, now=1000.0) == 1
    assert note_failed_login(req, base + "b" * 100_000, now=1001.0) == 1   # the same first 320 characters: the same account hash


def test_the_person_count_follows_the_limiters_switch(monkeypatch):
    """a test (or a deployment) that switches the shared limiter off switches the person count off with it; on, it counts"""
    from app.core import rate_limit

    person = str(uuid.uuid4())
    monkeypatch.setattr(rate_limit.limiter, "enabled", False)
    assert all(rate_limit.hit_refresh_person_limit(person) is None for _ in range(200))
    monkeypatch.setattr(rate_limit.limiter, "enabled", True)
    assert [rate_limit.hit_refresh_person_limit(person) for _ in range(60)] == [None] * 60
    assert rate_limit.hit_refresh_person_limit(person) is not None
