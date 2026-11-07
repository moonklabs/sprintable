"""story 4849 — a customer who pastes a wrong or revoked API key must be told so.

Measured on 2026-11-07 (the self-hosted server of the 4836 walk and the hosted dev MCP address alike): an unknown key got `initialize` 200, `tools/list` 200 and, on every call, the false
«this key can reach several projects … set a default project» (accessible_project_ids: []), because the HTTP door swallowed the failed key check as «non-fatal».

What these tests hold:
  · the key check tells two failures apart — 401 / 403 = the server does not know the key (InvalidApiKey), 5xx / timeout / no connection = the server could not be asked (ServerUnreachable:
    the key may be fine, so the line must NOT say «make a new key»); any other answer is left as it was;
  · HTTP: the door answers the FIRST request with 401 (invalid) or 503 (unreachable) and a one-line human message, and the app behind it is never reached (data 0, writes 0);
  · stdio: a wrong key does not end the process (a dead process shows the person only «Connection closed»): every call is answered with the same line and the backend is not called;
  · a key whose projects were never looked up is no longer told «several projects»;
  · the key (not even its first characters) is in no answer, no exception text and no log record.
"""
from __future__ import annotations

import json
import logging
import sys
from unittest.mock import AsyncMock, MagicMock, patch

import httpx
import pytest

from sprintable_mcp import api_client as ac
from sprintable_mcp.api_client import (
    INVALID_KEY_LINE,
    UNREACHABLE_LINE,
    InvalidApiKey,
    ServerUnreachable,
    SprintableApiError,
    SprintableClient,
)

KEY = "sk_live_" + "ab12cd34" * 8   # well-formed, made up here; never a real key


@pytest.fixture
def anyio_backend():
    return "asyncio"


_MODULE_STATE = ("_auth_ctx_cache", "_auth_checked_at", "_inflight_checks", "_recheck_after_401")


@pytest.fixture(autouse=True)
def _clear_cache():
    """module-wide state shared with every other test of the process: a blank state for this test, and the copy put back afterwards (nothing is cleared for the next test)"""
    import copy

    saved_module = {name: copy.copy(getattr(ac, name)) for name in _MODULE_STATE}
    saved_invalidated = set(ac._invalidated_checks)
    saved_client = copy.copy(ac.client.__dict__)
    for name in _MODULE_STATE:
        getattr(ac, name).clear()
    ac._invalidated_checks.clear()
    yield
    for name, saved in saved_module.items():
        getattr(ac, name).clear()
        getattr(ac, name).update(saved)
    ac._invalidated_checks.clear()
    ac._invalidated_checks.update(saved_invalidated)
    ac.client.__dict__.clear()
    ac.client.__dict__.update(saved_client)


def _client() -> SprintableClient:
    c = SprintableClient()
    c.configure("https://be.example.test", "envkey")
    return c


# ───────────────────────────── the two lines ─────────────────────────────

def test_the_two_lines_say_different_things_and_carry_no_key():
    # both halves of the line (English, then Korean) carry the pointer — held apart, so one half cannot hide the other's loss
    english, korean = INVALID_KEY_LINE.split(" / ", 1)
    assert "Get a new key in Sprintable: Agents → Recruit." in english
    assert "Agents → Recruit에서 새 키를 받으세요" in korean
    assert "revoked" in INVALID_KEY_LINE and "지워졌" in INVALID_KEY_LINE
    # the unreachable line must never send a person off to make a new key
    assert "new key" not in UNREACHABLE_LINE and "Recruit" not in UNREACHABLE_LINE and "새 키" not in UNREACHABLE_LINE
    assert "not at fault" in UNREACHABLE_LINE and "키 탓이 아니" in UNREACHABLE_LINE
    for line in (INVALID_KEY_LINE, UNREACHABLE_LINE):
        assert "sk_" not in line and "Bearer" not in line
        assert "\n" not in line   # one line


def test_the_errors_carry_their_codes_and_lines():
    a, b = InvalidApiKey(403), ServerUnreachable(502)
    assert (a.status, a.code, a.message) == (403, "INVALID_API_KEY", INVALID_KEY_LINE)
    assert (b.status, b.code, b.message) == (502, "SERVER_UNREACHABLE", UNREACHABLE_LINE)
    assert isinstance(a, SprintableApiError) and isinstance(b, SprintableApiError)   # the tools' existing try/except keeps catching them


# ───────────────────────────── the key check ─────────────────────────────

@pytest.mark.anyio
@pytest.mark.parametrize("status", [401, 403])
async def test_401_and_403_are_a_key_the_server_does_not_know(status):
    c = _client()
    with patch.object(c, "get", new=AsyncMock(side_effect=SprintableApiError(status, "denied", {"detail": "x"}))):
        with pytest.raises(InvalidApiKey):
            await c.ensure_auth_context(KEY)
        with pytest.raises(InvalidApiKey):
            await c.resolve_auth_context()
    assert KEY not in ac._auth_ctx_cache   # a failed check caches nothing


@pytest.mark.anyio
@pytest.mark.parametrize("status", [500, 502, 503, 504])
async def test_5xx_is_the_server_not_the_key(status):
    c = _client()
    with patch.object(c, "get", new=AsyncMock(side_effect=SprintableApiError(status, "boom"))):
        with pytest.raises(ServerUnreachable):
            await c.ensure_auth_context(KEY)


@pytest.mark.anyio
@pytest.mark.parametrize("exc", [httpx.ConnectError("no route"), httpx.ReadTimeout("slow"), httpx.ConnectTimeout("slow")])
async def test_timeout_and_no_connection_are_the_server_not_the_key(exc):
    c = _client()
    with patch.object(c, "get", new=AsyncMock(side_effect=exc)):
        with pytest.raises(ServerUnreachable):
            await c.ensure_auth_context(KEY)


@pytest.mark.anyio
@pytest.mark.parametrize("status", [404, 422])
async def test_any_other_answer_is_left_as_it_was(status):
    c = _client()
    with patch.object(c, "get", new=AsyncMock(side_effect=SprintableApiError(status, "other"))):
        with pytest.raises(SprintableApiError) as ei:
            await c.ensure_auth_context(KEY)
    assert not isinstance(ei.value, (InvalidApiKey, ServerUnreachable)) and ei.value.status == status


@pytest.mark.anyio
async def test_a_good_key_resolves_as_before():
    c = _client()
    me = {"member_id": "m1", "org_id": "o1", "resolved_default_project_id": "p1", "is_project_ambiguous": False, "accessible_project_ids": ["p1"]}
    with patch.object(c, "get", new=AsyncMock(return_value=me)):
        ctx = await c.ensure_auth_context(KEY)
    assert ctx["project_id"] == "p1" and ctx["member_id"] == "m1"


# ───────────────────────────── HTTP: the door ─────────────────────────────

class _Door:
    """drives the ASGI middleware with one POST /mcp and records what it sent and whether the app behind it was reached"""

    def __init__(self, auth: bytes | None = b"Bearer " + KEY.encode()):
        self.sent: list[dict] = []
        self.reached = False
        headers = [(b"content-type", b"application/json")] + ([(b"authorization", auth)] if auth else [])
        self.scope = {"type": "http", "path": "/mcp", "method": "POST", "headers": headers}

    async def _app(self, scope, receive, send):
        self.reached = True
        await send({"type": "http.response.start", "status": 200, "headers": []})
        await send({"type": "http.response.body", "body": b"{}"})

    async def run(self):
        from sprintable_mcp.http_auth import bearer_auth_asgi

        async def receive():
            return {"type": "http.request", "body": b"{}", "more_body": False}

        async def send(msg):
            self.sent.append(msg)

        await bearer_auth_asgi(self._app)(self.scope, receive, send)
        start = next(m for m in self.sent if m["type"] == "http.response.start")
        body = b"".join(m.get("body", b"") for m in self.sent if m["type"] == "http.response.body")
        return start["status"], {k.decode(): v.decode() for k, v in start["headers"]}, body


@pytest.mark.anyio
async def test_a_key_the_server_does_not_know_gets_401_and_the_line_on_the_first_request(caplog):
    door = _Door()
    with patch.object(ac.client, "ensure_auth_context", new=AsyncMock(side_effect=InvalidApiKey(401))), caplog.at_level(logging.DEBUG):
        status, headers, body = await door.run()
    assert status == 401 and door.reached is False   # the app (tools, backend calls) is never reached: data 0, writes 0
    payload = json.loads(body.decode("utf-8"))
    assert payload["error"]["code"] == "invalid_api_key" and payload["error"]["message"] == INVALID_KEY_LINE
    assert headers["www-authenticate"].startswith("Bearer") and "invalid_token" in headers["www-authenticate"]
    # AC3 — the key is nowhere: not in the answer, not in a log record (not even its first characters)
    blob = body.decode("utf-8") + json.dumps(headers) + "\n".join(r.getMessage() + repr(r.args) for r in caplog.records)
    assert KEY not in blob and KEY[:12] not in blob and "ab12cd34" not in blob


@pytest.mark.anyio
async def test_a_server_that_could_not_be_asked_gets_503_and_a_line_that_does_not_blame_the_key(caplog):
    door = _Door()
    with patch.object(ac.client, "ensure_auth_context", new=AsyncMock(side_effect=ServerUnreachable(504))), caplog.at_level(logging.DEBUG):
        status, headers, body = await door.run()
    assert status == 503 and door.reached is False and headers.get("retry-after")
    payload = json.loads(body.decode("utf-8"))
    assert payload["error"]["code"] == "server_unreachable" and payload["error"]["message"] == UNREACHABLE_LINE
    assert "Recruit" not in payload["error"]["message"] and "new key" not in payload["error"]["message"]
    assert KEY not in body.decode("utf-8") + "\n".join(r.getMessage() for r in caplog.records)


@pytest.mark.anyio
async def test_a_good_key_goes_through_as_before():
    door = _Door()
    with patch.object(ac.client, "ensure_auth_context", new=AsyncMock(return_value={"project_id": "p1"})):
        status, _, _ = await door.run()
    assert status == 200 and door.reached is True


@pytest.mark.anyio
@pytest.mark.parametrize("status_of_the_check", [400, 404, 422, 429])
async def test_any_other_answer_of_the_check_passes_without_a_verdict_as_before(status_of_the_check):
    """only 401 / 403 (the key is not known) and 5xx / timeout / no connection (the server cannot be asked) change the door's answer; the backend re-reads the key on every call anyway"""
    door = _Door()
    with patch.object(ac.client, "ensure_auth_context", new=AsyncMock(side_effect=SprintableApiError(status_of_the_check, "odd"))):
        status, _, _ = await door.run()
    assert status == 200 and door.reached is True


@pytest.mark.anyio
async def test_no_key_still_gets_the_old_401():
    door = _Door(auth=None)
    status, _, body = await door.run()
    assert status == 401 and door.reached is False and b"Bearer <api_key> required" in body


# ───────────────────────────── the real per-key cache behind the door ─────────────────────────────

@pytest.mark.anyio
async def test_the_door_with_the_real_client_refuses_an_unknown_key_and_lets_a_good_one_through():
    """no mocked ensure_auth_context: the real client, the real cache, only the backend's answer is faked"""
    good = {"member_id": "m1", "org_id": "o1", "resolved_default_project_id": "p1", "is_project_ambiguous": False, "accessible_project_ids": ["p1"]}
    answers = {"bad": SprintableApiError(401, "no"), "ill": SprintableApiError(502, "bad gateway"), "good": good}

    async def fake_get(path, **kw):
        a = answers[ac._api_key_override.get().split("-")[0]]   # the key of THIS request decides (per-request bearer, as in production)
        if isinstance(a, Exception):
            raise a
        return a

    with patch.object(ac.client, "get", new=AsyncMock(side_effect=fake_get)):
        for key, want in (("bad-" + KEY, 401), ("ill-" + KEY, 503), ("good-" + KEY, 200)):
            door = _Door(auth=b"Bearer " + key.encode())
            status, _, _ = await door.run()
            assert status == want, key[:4]
            assert door.reached is (want == 200)
    assert list(ac._auth_ctx_cache) == ["good-" + KEY]   # only the good key is cached; a failed check caches nothing


sent_with: list[str] = []   # the Authorization header of every request the fake transport saw


def _fake_http(routes: dict[str, int]):
    """an httpx.AsyncClient stand-in: the status per path (the body echoes what was sent, to prove it is never carried); records the paths asked"""
    asked: list[str] = []
    sent_with.clear()

    class _Resp:
        def __init__(self, status):
            self.status_code = status
            self.is_success = status < 400
            self.content = b'{"data": {"member_id": "m1", "org_id": "o1"}}' if status < 400 else b'{"detail":"ECHO of what was sent: gone"}'
            self.headers = {}
            self.text = self.content.decode()
        def json(self):
            import json as _j
            return _j.loads(self.content)

    class _Http:
        def __init__(self, *a, **k): pass
        async def __aenter__(self): return self
        async def __aexit__(self, *a): return False
        async def request(self, method, url, **k):
            path = url.split("://", 1)[1].split("/", 1)[1]
            path = "/" + path.split("?", 1)[0]
            asked.append(path)
            sent_with.append(k["headers"]["Authorization"])
            return _Resp(routes[path])

    return _Http, asked


@pytest.mark.anyio
async def test_a_key_revoked_after_it_was_cached_gets_the_line_on_its_next_call_and_is_checked_again():
    c = _client()
    ac._auth_ctx_cache["gone"] = {"project_id": "p1"}
    http, asked = _fake_http({"/api/v2/stories": 401, "/api/v2/auth/me": 401})   # the call is refused AND the server no longer knows the key
    tok = ac.set_api_key_override("gone")
    try:
        with patch.object(ac.httpx, "AsyncClient", new=http):
            with pytest.raises(InvalidApiKey) as ei:
                await c.get("/api/v2/stories")
    finally:
        ac.reset_api_key_override(tok)
    assert "gone" not in str(ei.value) and "ECHO" not in str(ei.value)   # the backend's own text is not carried
    assert "gone" not in ac._auth_ctx_cache                                  # the next connection is checked again
    assert asked == ["/api/v2/stories", "/api/v2/auth/me"]
    assert sent_with == ["Bearer gone", "Bearer gone"]   # the re-check asks about THIS request's key, not the process's own (env) key


@pytest.mark.anyio
async def test_a_401_that_is_not_about_the_key_stands_as_it_was_and_the_key_stays_cached():
    """a connector's upstream token answers 401 too: the server still knows the key, so no «new key» line and no cache drop"""
    c = _client()
    ac._auth_ctx_cache["fine"] = {"project_id": "p1"}
    http, asked = _fake_http({"/api/v2/channel-posts": 401, "/api/v2/auth/me": 200})
    tok = ac.set_api_key_override("fine")
    try:
        with patch.object(ac.httpx, "AsyncClient", new=http):
            with pytest.raises(SprintableApiError) as ei:
                await c.get("/api/v2/channel-posts")
    finally:
        ac.reset_api_key_override(tok)
    assert not isinstance(ei.value, InvalidApiKey) and ei.value.status == 401
    assert "fine" in ac._auth_ctx_cache and asked == ["/api/v2/channel-posts", "/api/v2/auth/me"]


@pytest.mark.anyio
async def test_the_recheck_of_a_401_is_asked_once_per_key_per_window():
    """a busy key whose calls answer 401 for a reason that is not the key (a connector's upstream token) costs ONE /auth/me per window, not one per 401"""
    c = _client()
    http, asked = _fake_http({"/api/v2/channel-posts": 401, "/api/v2/auth/me": 200})
    tok = ac.set_api_key_override("busy")
    try:
        with patch.object(ac.httpx, "AsyncClient", new=http):
            for _ in range(4):
                with pytest.raises(SprintableApiError) as ei:
                    await c.request("GET", "/api/v2/channel-posts")
                assert not isinstance(ei.value, InvalidApiKey) and ei.value.status == 401
            assert asked.count("/api/v2/auth/me") == 1
            at, revoked = ac._recheck_after_401["busy"]
            ac._recheck_after_401["busy"] = (at - ac.AUTH_RECHECK_SECONDS - 1, revoked)   # the window has passed
            with pytest.raises(SprintableApiError):
                await c.request("GET", "/api/v2/channel-posts")
            assert asked.count("/api/v2/auth/me") == 2
    finally:
        ac.reset_api_key_override(tok)


@pytest.mark.anyio
@pytest.mark.parametrize("end_of_the_recheck", [
    SprintableApiError(500, "boom"), SprintableApiError(503, "down"), SprintableApiError(429, "slow down"), SprintableApiError(404, "odd"),
    httpx.ConnectError("lost"), ValueError("unreadable answer"),
])
async def test_a_recheck_that_ends_without_a_verdict_does_not_hold_the_next_401_off_for_a_window(end_of_the_recheck):
    """the mark «asked just now, the key is fine» is made before the question; whenever the question ends in anything but a verdict (a 401 / 403) or a good answer — a server error, a
    throttle, a transport error, an unreadable answer — the mark is taken back, so a revoked key is asked about again at its next 401"""
    c = _client()
    http, asked = _fake_http({"/api/v2/stories": 401})
    tok = ac.set_api_key_override("flaky")
    try:
        with patch.object(ac.httpx, "AsyncClient", new=http), patch.object(c, "get", new=AsyncMock(side_effect=end_of_the_recheck)) as g:
            for _ in range(3):
                with pytest.raises(SprintableApiError) as ei:
                    await c.request("GET", "/api/v2/stories")
                assert not isinstance(ei.value, InvalidApiKey)   # cannot tell: the original 401 stands
            assert g.await_count == 3                            # asked every time, not once per window
            assert "flaky" not in ac._recheck_after_401
    finally:
        ac.reset_api_key_override(tok)


@pytest.mark.anyio
async def test_a_key_found_revoked_keeps_the_same_answer_for_the_window_without_asking_again():
    c = _client()
    http, asked = _fake_http({"/api/v2/stories": 401, "/api/v2/auth/me": 401})
    tok = ac.set_api_key_override("gone2")
    try:
        with patch.object(ac.httpx, "AsyncClient", new=http):
            for _ in range(3):
                with pytest.raises(InvalidApiKey):
                    await c.request("GET", "/api/v2/stories")
            assert asked.count("/api/v2/auth/me") == 1
    finally:
        ac.reset_api_key_override(tok)


@pytest.mark.anyio
async def test_the_recheck_memo_is_hard_bounded_even_when_every_entry_is_fresh():
    c = _client()
    http, _ = _fake_http({"/api/v2/channel-posts": 401, "/api/v2/auth/me": 200})
    with patch.object(ac.httpx, "AsyncClient", new=http):
        for i in range(ac._RECHECK_MEMO_MAX + 40):          # all within one window: nothing is stale
            tok = ac.set_api_key_override(f"k{i}")
            try:
                with pytest.raises(SprintableApiError):
                    await c.request("GET", "/api/v2/channel-posts")
            finally:
                ac.reset_api_key_override(tok)
    assert len(ac._recheck_after_401) == ac._RECHECK_MEMO_MAX
    assert "k0" not in ac._recheck_after_401 and f"k{ac._RECHECK_MEMO_MAX + 39}" in ac._recheck_after_401   # the oldest went, the newest stays


@pytest.mark.anyio
async def test_the_recheck_memo_stays_bounded_with_hundreds_of_rechecks_in_flight_at_once():
    """the in-flight race: a re-check that was started, evicted meanwhile, and writes its verdict afterwards must not push the memo over its bound"""
    import asyncio

    c = _client()
    gate = asyncio.Event()

    class _Resp:
        def __init__(self, status):
            self.status_code, self.is_success, self.headers = status, status < 400, {}
            self.content = b'{"data": {"member_id": "m"}}' if status < 400 else b'{"detail": "x"}'
            self.text = self.content.decode()
        def json(self):
            import json as _j
            return _j.loads(self.content)

    class _Http:
        def __init__(self, *a, **k): pass
        async def __aenter__(self): return self
        async def __aexit__(self, *a): return False
        async def request(self, method, url, **k):
            if url.endswith("/api/v2/auth/me"):
                await gate.wait()          # every re-check is still waiting for the server
                return _Resp(401)          # …and the server does not know the key
            return _Resp(401)

    async def one(i: int):
        tok = ac.set_api_key_override(f"race-{i}")
        try:
            with pytest.raises(SprintableApiError):
                await c.request("GET", "/api/v2/stories")
        finally:
            ac.reset_api_key_override(tok)

    n = ac._RECHECK_MEMO_MAX + 60
    with patch.object(ac.httpx, "AsyncClient", new=_Http):
        tasks = [asyncio.create_task(one(i)) for i in range(n)]
        for _ in range(50):
            await asyncio.sleep(0)         # all of them reach the gate
        assert len(ac._recheck_after_401) <= ac._RECHECK_MEMO_MAX
        gate.set()
        await asyncio.gather(*tasks)
    assert len(ac._recheck_after_401) <= ac._RECHECK_MEMO_MAX


@pytest.mark.anyio
@pytest.mark.parametrize("backend_status", [400, 404, 422, 429])
async def test_real_answers_of_the_check_other_than_401_403_5xx_are_no_verdict(backend_status):
    """through the real client: /auth/me answering 400 / 404 / 422 / 429 leaves the door open (the backend re-reads the key on every call anyway)"""
    door = _Door()
    with patch.object(ac.client, "get", new=AsyncMock(side_effect=SprintableApiError(backend_status, "odd"))):
        status, _, _ = await door.run()
    assert status == 200 and door.reached is True


@pytest.mark.anyio
async def test_expired_memo_entries_go_on_the_next_insert_whatever_the_size():
    c = _client()
    http, _ = _fake_http({"/api/v2/channel-posts": 401, "/api/v2/auth/me": 200})
    with patch.object(ac.httpx, "AsyncClient", new=http):
        for k in ("old1", "old2", "old3"):
            tok = ac.set_api_key_override(k)
            try:
                with pytest.raises(SprintableApiError):
                    await c.request("GET", "/api/v2/channel-posts")
            finally:
                ac.reset_api_key_override(tok)
        for k, (at, rv) in list(ac._recheck_after_401.items()):
            ac._recheck_after_401[k] = (at - ac.AUTH_RECHECK_SECONDS - 1, rv)   # their window has passed (the memo is far below its limit)
        tok = ac.set_api_key_override("new")
        try:
            with pytest.raises(SprintableApiError):
                await c.request("GET", "/api/v2/channel-posts")
        finally:
            ac.reset_api_key_override(tok)
    assert list(ac._recheck_after_401) == ["new"]


@pytest.mark.anyio
async def test_a_key_check_that_was_in_flight_when_the_key_was_found_revoked_does_not_put_it_back():
    import asyncio

    c = _client()
    started, release = asyncio.Event(), asyncio.Event()
    good = {"member_id": "m1", "org_id": "o1", "resolved_default_project_id": "p1", "is_project_ambiguous": False, "accessible_project_ids": ["p1"]}

    async def slow_get(path, **kw):
        started.set()
        await release.wait()
        return good

    with patch.object(c, "get", new=AsyncMock(side_effect=slow_get)):
        a = asyncio.create_task(c.ensure_auth_context("racer"))
        await started.wait()
        ac._forget_key("racer")      # meanwhile another request found the key revoked
        release.set()
        await a
    assert "racer" not in ac._auth_ctx_cache   # the late success is not cached: the next connection asks again


@pytest.mark.anyio
async def test_a_slow_good_check_does_not_cache_a_key_that_a_concurrent_check_found_revoked():
    """the real sequence: check A (slow) will succeed, check B of the same key meanwhile gets 401 — no helper is called by hand"""
    import asyncio

    c = _client()
    started, release = asyncio.Event(), asyncio.Event()
    good = {"member_id": "m1", "org_id": "o1", "resolved_default_project_id": "p1", "is_project_ambiguous": False, "accessible_project_ids": ["p1"]}
    calls = {"n": 0}

    async def get(path, **kw):
        calls["n"] += 1
        if calls["n"] == 1:           # A: slow, answers «good»
            started.set()
            await release.wait()
            return good
        raise SprintableApiError(401, "no")   # B: the key has been revoked by now

    with patch.object(c, "get", new=AsyncMock(side_effect=get)):
        a = asyncio.create_task(c.ensure_auth_context("racer"))
        await started.wait()
        with pytest.raises(InvalidApiKey):
            await c.ensure_auth_context("racer")
        release.set()
        await a
    assert "racer" not in ac._auth_ctx_cache


@pytest.mark.anyio
async def test_an_unreadable_answer_of_the_recheck_leaves_the_original_401_as_it_was():
    c = _client()
    ac._auth_ctx_cache["fine"] = {"project_id": "p1"}
    http, _ = _fake_http({"/api/v2/channel-posts": 401})
    tok = ac.set_api_key_override("fine")
    try:
        with patch.object(ac.httpx, "AsyncClient", new=http), patch.object(c, "get", new=AsyncMock(side_effect=ValueError("malformed json"))):
            with pytest.raises(SprintableApiError) as ei:
                await c.request("GET", "/api/v2/channel-posts")
    finally:
        ac.reset_api_key_override(tok)
    assert not isinstance(ei.value, InvalidApiKey) and ei.value.status == 401 and "fine" in ac._auth_ctx_cache


@pytest.mark.anyio
async def test_a_key_revoked_between_the_two_startup_calls_is_the_same_refusal():
    from sprintable_mcp import __main__ as m

    with patch.object(m.client, "resolve_auth_context", new=AsyncMock(return_value={})), \
            patch.object(m.client, "get", new=AsyncMock(side_effect=InvalidApiKey(401))):   # what request() raises once the re-check says the key is gone
        with pytest.raises(InvalidApiKey):
            await m._setup()


@pytest.mark.anyio
async def test_a_manifest_401_that_is_not_about_the_key_degrades_as_before():
    from sprintable_mcp import __main__ as m

    with patch.object(m.client, "resolve_auth_context", new=AsyncMock(return_value={})), \
            patch.object(m.client, "get", new=AsyncMock(side_effect=SprintableApiError(401, "upstream"))):   # request() looked and the server still knows the key
        assert await m._setup() is None


@pytest.mark.anyio
async def test_a_manifest_failure_that_is_not_the_key_degrades_and_prints_no_error_text(capsys):
    from sprintable_mcp import __main__ as m

    for exc in (SprintableApiError(500, "echo " + KEY), RuntimeError("echo " + KEY), SprintableApiError(403, "scope " + KEY)):
        with patch.object(m.client, "resolve_auth_context", new=AsyncMock(return_value={})), patch.object(m.client, "get", new=AsyncMock(side_effect=exc)):
            assert await m._setup() is None
    err = capsys.readouterr().err
    assert "manifest" in err and KEY not in err and "echo" not in err and "scope" not in err


@pytest.mark.anyio
async def test_an_unclassified_failure_of_the_check_is_logged_by_status_only(caplog):
    class _Odd(SprintableApiError):
        pass

    door = _Door()
    odd = _Odd(422, "the proxy says: bad bearer " + KEY)
    with patch.object(ac.client, "ensure_auth_context", new=AsyncMock(side_effect=odd)), caplog.at_level(logging.DEBUG):
        status, _, _ = await door.run()
    assert status == 200   # still non-fatal, as before
    assert KEY not in "\n".join(r.getMessage() + repr(r.args) for r in caplog.records)


@pytest.mark.anyio
async def test_a_key_that_passed_once_and_was_revoked_is_refused_by_the_door_after_the_recheck_window():
    """through the real door and the real cache: pass → revoked → still inside the window (served, backend not asked) → after the window (401 + the line)"""
    good = {"member_id": "m1", "org_id": "o1", "resolved_default_project_id": "p1", "is_project_ambiguous": False, "accessible_project_ids": ["p1"]}
    answers = [good]   # what the backend says to the next /auth/me; empty = the key is revoked

    async def fake_get(path, **kw):
        if answers:
            return answers[0]
        raise SprintableApiError(401, "gone")

    with patch.object(ac.client, "get", new=AsyncMock(side_effect=fake_get)) as g:
        status, _, _ = await _Door().run()
        assert status == 200 and g.await_count == 1
        answers.clear()                                      # the key is revoked now
        status, _, _ = await _Door().run()
        assert status == 200 and g.await_count == 1          # inside the window: served from the cache, the backend is not asked (unchanged behaviour)
        ac._auth_checked_at[KEY] = ac._auth_checked_at[KEY] - ac.AUTH_RECHECK_SECONDS - 1   # the window has passed
        door = _Door()
        status, _, body = await door.run()
    assert status == 401 and door.reached is False and json.loads(body.decode("utf-8"))["error"]["message"] == INVALID_KEY_LINE
    assert KEY not in ac._auth_ctx_cache and KEY not in ac._auth_checked_at   # the next connection is checked again


@pytest.mark.anyio
async def test_a_server_that_is_ill_does_not_turn_away_a_key_that_already_passed_but_does_refuse_a_new_one():
    good = {"member_id": "m1", "org_id": "o1", "resolved_default_project_id": "p1", "is_project_ambiguous": False, "accessible_project_ids": ["p1"]}
    state = {"ill": False}

    async def fake_get(path, **kw):
        if state["ill"]:
            raise SprintableApiError(503, "down")
        return good

    with patch.object(ac.client, "get", new=AsyncMock(side_effect=fake_get)):
        assert (await _Door().run())[0] == 200
        state["ill"] = True
        ac._auth_checked_at[KEY] -= ac.AUTH_RECHECK_SECONDS + 1
        assert (await _Door().run())[0] == 200               # passed before, server ill now: served from the cache
        ac._auth_ctx_cache.clear(); ac._auth_checked_at.clear()
        door = _Door()
        status, _, _ = await door.run()
    assert status == 503 and door.reached is False           # never seen before and the server cannot be asked: the unreachable line


@pytest.mark.anyio
async def test_a_recheck_that_read_the_old_default_cannot_put_it_back_after_set_default_project():
    import asyncio

    c = _client()
    old = {"member_id": "m1", "org_id": "o1", "resolved_default_project_id": "p-old", "is_project_ambiguous": True, "accessible_project_ids": ["p-old", "p-new"]}
    ac._auth_ctx_cache["k"] = {"project_id": "p-old", "is_project_ambiguous": True}
    ac._auth_checked_at["k"] = ac.time.monotonic() - ac.AUTH_RECHECK_SECONDS - 1   # expired: the next request re-asks
    started, release = asyncio.Event(), asyncio.Event()

    async def slow_get(path, **kw):
        started.set()
        await release.wait()
        return old    # read BEFORE the default was set

    with patch.object(c, "get", new=AsyncMock(side_effect=slow_get)):
        a = asyncio.create_task(c.ensure_auth_context("k"))
        await started.wait()
        ac.set_cached_default_project("k", "p-new")     # the tool: the default was just set
        release.set()
        await a
    assert ac._auth_ctx_cache["k"]["project_id"] == "p-new" and ac._auth_ctx_cache["k"]["is_project_ambiguous"] is False


@pytest.mark.anyio
async def test_the_set_default_project_tool_goes_through_the_helper_and_touches_only_its_own_key():
    from sprintable_mcp.tools import projects as pr

    ac._auth_ctx_cache["mine"] = {"project_id": "", "is_project_ambiguous": True}
    ac._auth_ctx_cache["other"] = {"project_id": "x", "is_project_ambiguous": True}
    tok = ac.set_api_key_override("mine")
    try:
        with patch.object(pr.client, "patch", new=AsyncMock(return_value={"resolved_default_project_id": "p9"})), \
                patch.object(pr, "set_cached_default_project", wraps=ac.set_cached_default_project) as spy:
            await pr.set_default_project(pr.SetDefaultProjectInput(project_id="p9"))
        spy.assert_called_once_with("mine", "p9")   # through the helper, which also marks checks still in flight
    finally:
        ac.reset_api_key_override(tok)
        pr.client._project_id = ""
        pr.client._project_id_ambiguous = False
    assert ac._auth_ctx_cache["mine"]["project_id"] == "p9" and ac._auth_ctx_cache["other"] == {"project_id": "x", "is_project_ambiguous": True}


@pytest.mark.anyio
async def test_an_ill_server_is_asked_again_in_seconds_not_on_every_request():
    good = {"member_id": "m1", "org_id": "o1", "resolved_default_project_id": "p1", "is_project_ambiguous": False, "accessible_project_ids": ["p1"]}
    state = {"ill": False}

    async def fake_get(path, **kw):
        if state["ill"]:
            raise SprintableApiError(503, "down")
        return good

    with patch.object(ac.client, "get", new=AsyncMock(side_effect=fake_get)) as g:
        await _Door().run()
        state["ill"] = True
        ac._auth_checked_at[KEY] -= ac.AUTH_RECHECK_SECONDS + 1
        before = g.await_count
        for _ in range(5):
            assert (await _Door().run())[0] == 200
        assert g.await_count == before + 1          # one attempt, then the next ones are served from the cache
        ac._auth_checked_at[KEY] -= 10               # a few seconds later it is asked again
        await _Door().run()
        assert g.await_count == before + 2


# ───────────────────────────── stdio: answer the first request with the line ─────────────────────────────

def _serve(lines: list[str]):
    import io
    from sprintable_mcp.__main__ import serve_key_refusal

    out = io.StringIO()
    serve_key_refusal(INVALID_KEY_LINE, stdin=io.StringIO("".join(l + "\n" for l in lines)), stdout=out)
    return [json.loads(l) for l in out.getvalue().splitlines()]


def test_the_refusal_server_answers_every_request_with_a_json_rpc_error_and_nothing_else():
    got = _serve([
        json.dumps({"jsonrpc": "2.0", "id": 0, "method": "initialize", "params": {}}),
        json.dumps({"jsonrpc": "2.0", "method": "notifications/initialized"}),        # a notification: no answer
        "not json at all",
        "",
        json.dumps({"jsonrpc": "2.0", "id": "x", "method": "tools/list"}),
    ])
    assert [g["id"] for g in got] == [0, "x"]
    for g in got:
        assert g["jsonrpc"] == "2.0" and g["error"]["code"] == -32001 and g["error"]["message"] == INVALID_KEY_LINE and "result" not in g


def _run_main(setup_exc):
    """runs __main__.main() for stdio with the startup check failing as `setup_exc`; returns (exit code or None, stderr text, refusal messages served)"""
    from sprintable_mcp import __main__ as m

    served: list[str] = []
    with patch.object(m, "_setup", new=AsyncMock(side_effect=setup_exc)), patch.object(m, "serve_key_refusal", new=lambda msg, **k: served.append(msg)), \
            patch.object(m.settings, "sprintable_api_url", "https://be.example.test"), patch.object(m.settings, "agent_api_key", KEY), \
            patch.object(m.settings, "mcp_transport", "stdio"), patch.object(m.client, "configure"), \
            patch("sys.stderr") as err:
        code = None
        try:
            m.main()
        except SystemExit as e:
            code = e.code
    printed = "".join(c.args[0] for c in err.write.call_args_list if c.args)
    return code, printed, served


def test_stdio_startup_with_a_wrong_key_serves_the_refusal_and_does_not_end_with_an_error():
    code, printed, served = _run_main(InvalidApiKey(401))
    assert code is None and served == [INVALID_KEY_LINE]
    assert INVALID_KEY_LINE in printed and KEY not in printed and "ab12cd34" not in printed


def test_stdio_startup_when_the_server_cannot_be_asked_serves_its_own_line_that_does_not_blame_the_key():
    code, printed, served = _run_main(ServerUnreachable(503))
    assert code is None and served == [UNREACHABLE_LINE]
    assert "new key" not in served[0] and KEY not in printed


def test_stdio_startup_with_any_other_failure_ends_and_prints_the_status_only():
    odd = SprintableApiError(422, "the proxy echoes: " + KEY)
    code, printed, served = _run_main(odd)
    assert code == 1 and served == []
    assert "422" in printed and KEY not in printed and "echoes" not in printed


def test_the_real_stdio_process_answers_initialize_with_the_line_and_never_shows_the_key():
    """a real `python -m sprintable_mcp` against a stand-in backend that does not know the key: the first reply on stdout is the JSON-RPC error"""
    import subprocess
    import threading
    from http.server import BaseHTTPRequestHandler, HTTPServer
    from pathlib import Path

    seen: list[str] = []

    class H(BaseHTTPRequestHandler):
        def log_message(self, *a): pass
        def do_GET(self):
            seen.append(self.path)
            body = b'{"detail":"nope"}'
            self.send_response(401); self.send_header("content-type", "application/json"); self.send_header("content-length", str(len(body))); self.end_headers(); self.wfile.write(body)

    srv = HTTPServer(("127.0.0.1", 0), H)
    th = threading.Thread(target=srv.serve_forever, daemon=True); th.start()
    try:
        env = {**__import__("os").environ, "SPRINTABLE_API_URL": f"http://127.0.0.1:{srv.server_address[1]}", "AGENT_API_KEY": KEY, "MCP_TRANSPORT": "stdio"}
        init = json.dumps({"jsonrpc": "2.0", "id": 1, "method": "initialize", "params": {"protocolVersion": "2025-03-26", "capabilities": {}, "clientInfo": {"name": "t", "version": "1"}}})
        r = subprocess.run([sys.executable, "-m", "sprintable_mcp"], input=init + "\n", capture_output=True, text=True, timeout=60, env=env, cwd=Path(__file__).resolve().parents[1])
    finally:
        srv.shutdown()
    first = json.loads(r.stdout.splitlines()[0])
    assert first["id"] == 1 and first["error"]["message"] == INVALID_KEY_LINE and "result" not in first
    assert KEY not in r.stdout + r.stderr and "ab12cd34" not in r.stdout + r.stderr
    assert seen == ["/api/v2/auth/me"]   # the one key check, and nothing else was asked of the backend (data 0)


@pytest.mark.anyio
async def test_the_scope_loader_says_so_when_the_server_no_longer_knows_the_key_and_caches_nothing():
    from sprintable_mcp import server as s

    s._scope_cache._store.clear()
    with patch.object(s.client, "get", new=AsyncMock(side_effect=InvalidApiKey(401))):
        with pytest.raises(InvalidApiKey):
            await s._load_scope_for("k-gone")
    assert s._scope_cache.get("k-gone") is s._SCOPE_MISS   # no «fail-open» entry was made for it
    with patch.object(s.client, "get", new=AsyncMock(side_effect=SprintableApiError(500, "x"))):
        assert await s._load_scope_for("k-ill") is s._SCOPE_FAILOPEN   # anything else keeps failing open, as before
    s._scope_cache._store.clear()


@pytest.mark.anyio
async def test_a_tool_call_after_the_key_was_revoked_gets_the_line_and_the_tool_is_not_run():
    from sprintable_mcp import server as s

    ran = []

    async def fn(x):
        ran.append(1)
        return []

    class _In(s.BaseModel):
        pass

    w = s._flat("t_tool", "d", _In, fn)
    with patch.object(s, "_load_scope_for", new=AsyncMock(side_effect=InvalidApiKey(401))):
        result = await w()
    assert ran == [] and result[0].text.startswith("Error: INVALID_API_KEY:") and INVALID_KEY_LINE in result[0].text


def test_an_unclassified_startup_exception_prints_its_type_only():
    code, printed, served = _run_main(RuntimeError("adapter says: " + KEY))
    assert code == 1 and served == [] and "RuntimeError" in printed and KEY not in printed and "adapter says" not in printed


@pytest.mark.anyio
async def test_nothing_is_held_after_checks_end_however_many_keys_were_refused():
    c = _client()
    with patch.object(c, "get", new=AsyncMock(side_effect=SprintableApiError(401, "no"))):
        for i in range(50):
            with pytest.raises(InvalidApiKey):
                await c.ensure_auth_context(f"bad-{i}-{KEY}")
    assert ac._inflight_checks == {} and ac._invalidated_checks == set() and ac._auth_ctx_cache == {}


# ───────────────────────────── a key whose projects were never looked up ─────────────────────────────

def test_a_key_that_was_never_looked_up_is_not_told_it_can_reach_several_projects():
    c = _client()          # nothing resolved: no project, no context, no accessible list, not ambiguous
    with pytest.raises(SprintableApiError) as ei:
        c.require_project_id()
    assert ei.value.code == "KEY_NOT_CHECKED" and "여러 프로젝트" not in str(ei.value)


@pytest.mark.anyio
async def test_a_checked_key_with_no_project_at_all_keeps_the_old_answer_and_is_not_called_unchecked():
    c = _client()
    me = {"member_id": "m1", "org_id": "o1", "resolved_default_project_id": None, "is_project_ambiguous": False, "accessible_project_ids": []}
    with patch.object(c, "get", new=AsyncMock(return_value=me)):
        await c.resolve_auth_context()
    with pytest.raises(SprintableApiError) as ei:
        c.require_project_id()
    assert ei.value.code != "KEY_NOT_CHECKED"   # the stdio key WAS checked; correct-key behaviour is what it was before


def test_a_really_ambiguous_key_keeps_its_guide():
    c = _client()
    c._project_id_ambiguous = True
    c._accessible_project_ids = ["pa", "pb"]
    with pytest.raises(SprintableApiError) as ei:
        c.require_project_id()
    assert "set_default_project" in str(ei.value) and ei.value.body["accessible_project_ids"] == ["pa", "pb"]
