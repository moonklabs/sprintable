"""story 4839 — the sign-in's failure counts and its second-step code record are written in one statement (real PostgreSQL).

The invariant: requests in flight together must not overwrite each other's counts or pass a check that another of them is passing. Before, `login` counted from the row it read at the START of the request
(`count + 1` computed in Python) and checked a used second-step code against that same row: requests that overlapped all read the same old values, so the lock-out was walked past and one code made several sessions.
Now the count is added by the database and the answer is decided from the value the same statement returns; the code's step is recorded by a conditional UPDATE (the row lock makes the second request find it recorded).

Every test makes the overlap certain, not likely: all requests wait (inside the request, right after the person is read) until the last one has arrived, then they go on together — the old code reads the same old row in all of them.
"""
from __future__ import annotations

import asyncio
import os
from collections import Counter

import pytest

from tests.test_4782_revoke_vs_issue_race_realdb import _live_except
from tests.test_4782_switch_after_revoke_realdb import _PASSWORD, _close, _dispose_global_engine_after_test, _no_rate_limit, _world, anyio_backend  # noqa: F401

_REAL_DB_URL = os.getenv("PARITY_TEST_DATABASE_URL") or os.getenv("ALEMBIC_DATABASE_URL")

pytestmark = [
    pytest.mark.skipif(not _REAL_DB_URL, reason="통합 테스트는 실 PG(PARITY/ALEMBIC_DATABASE_URL) 필요"),
    pytest.mark.anyio,
]

_WAIT = 60
_WRONG = "wrong-" + "pw-4839"


class _Together:
    """a barrier inside the request: every request that has read the person waits until `n` have, then all go on"""

    def __init__(self, n: int) -> None:
        self.n, self.arrived, self.go = n, 0, asyncio.Event()

    async def wait(self) -> None:
        self.arrived += 1
        if self.arrived >= self.n:
            self.go.set()
        await asyncio.wait_for(self.go.wait(), 30)


def _overlap(monkeypatch, w, n: int) -> None:
    import app.routers.auth as auth_router

    original = auth_router._get_user_by_email
    together = _Together(n)

    async def read_then_wait(session, email):
        user = await original(session, email)
        if user is not None and user.id == w.user_id and not together.go.is_set():
            await together.wait()
        return user

    monkeypatch.setattr(auth_router, "_get_user_by_email", read_then_wait)


def _sign_in(w, password: str = _PASSWORD, code: str | None = None):
    body = {"email": w.email, "password": password}
    if code is not None:
        body["totp_code"] = code
    return w.client.post("/api/v2/auth/token", json=body)


async def _row(w, *columns: str) -> tuple:
    from sqlalchemy import text

    async with w.Session() as s:
        return tuple((await s.execute(text(f"SELECT {', '.join(columns)} FROM users WHERE id = :i"), {"i": w.user_id})).one())


async def _answers(tasks: list) -> Counter:
    results = await asyncio.wait_for(asyncio.gather(*tasks), _WAIT)
    return Counter(r.status_code for r in results), results


async def _enable_totp(w) -> tuple[str, int]:
    import pyotp
    from sqlalchemy import text

    secret = pyotp.random_base32()
    async with w.Session() as s:
        await s.execute(text("UPDATE users SET totp_enabled = true, totp_secret = :s, totp_last_timestep = NULL, totp_fail_count = 0, totp_locked_until = NULL WHERE id = :i"), {"s": secret, "i": w.user_id})
        await s.commit()
    return secret, 0


async def test_twelve_wrong_passwords_in_flight_together_answer_five_401_then_seven_429_and_count_twelve(monkeypatch):
    engine, w = await _world()
    try:
        _overlap(monkeypatch, w, 12)
        counts, _ = await _answers([_sign_in(w, _WRONG) for _ in range(12)])
        assert counts == Counter({401: 5, 429: 7}), counts
        fail_count, locked_until = await _row(w, "login_fail_count", "login_locked_until")
        assert fail_count == 12, f"the stored count is the number of attempts, not what the last writer read: {fail_count}"
        assert locked_until is not None
    finally:
        await _close(engine, w)


async def test_serial_failures_still_lock_on_the_fifth_and_refuse_a_right_password_while_locked():
    engine, w = await _world()
    try:
        for n in range(5):
            assert (await _sign_in(w, _WRONG)).status_code == 401, n
        assert (await _row(w, "login_fail_count"))[0] == 5
        assert (await _sign_in(w)).status_code == 429, "the right password is refused while the lock-out is in force"
        assert (await _sign_in(w, _WRONG)).status_code == 429
    finally:
        await _close(engine, w)


async def test_a_right_password_that_finishes_checking_after_the_lock_went_on_is_refused(monkeypatch):
    """the lock-out went on while this request was checking the password: before the session is made it asks the row again and answers 429, not 200"""
    import app.routers.auth as auth_router

    engine, w = await _world()
    try:
        real_lock = auth_router._lock_person_sessions
        reached, release = asyncio.Event(), asyncio.Event()

        async def paused_before_lock(session, user_id, *, exclusive):
            if not exclusive and user_id == w.user_id and not reached.is_set():
                reached.set()
                await release.wait()
            return await real_lock(session, user_id, exclusive=exclusive)

        monkeypatch.setattr(auth_router, "_lock_person_sessions", paused_before_lock)
        right = asyncio.create_task(_sign_in(w))
        try:
            await asyncio.wait_for(reached.wait(), 15)
            monkeypatch.setattr(auth_router, "_lock_person_sessions", real_lock)  # the failures below take the lock freely
            for _ in range(5):
                assert (await _sign_in(w, _WRONG)).status_code == 401
            rows_before = await w.token_rows()
        finally:
            release.set()
        answer = await asyncio.wait_for(right, _WAIT)
        assert answer.status_code == 429, f"{answer.status_code} {answer.text}"
        assert await w.token_rows() == rows_before, "a refused sign-in stores no session row"
        assert await _live_except(w, None) == 0
    finally:
        await _close(engine, w)


async def test_a_success_clears_the_failures_counted_after_it_read_the_person(monkeypatch):
    import app.routers.auth as auth_router

    engine, w = await _world()
    try:
        original = auth_router._get_user_by_email
        read, release = asyncio.Event(), asyncio.Event()

        async def read_then_pause(session, email):
            user = await original(session, email)
            if user is not None and user.id == w.user_id and not read.is_set():
                read.set()  # the person is read with a count of 0
                await release.wait()
            return user

        monkeypatch.setattr(auth_router, "_get_user_by_email", read_then_pause)
        right = asyncio.create_task(_sign_in(w))
        try:
            await asyncio.wait_for(read.wait(), 15)
            for _ in range(3):
                assert (await _sign_in(w, _WRONG)).status_code == 401
            assert (await _row(w, "login_fail_count"))[0] == 3
        finally:
            release.set()
        answer = await asyncio.wait_for(right, _WAIT)
        assert answer.status_code == 200, answer.text
        assert (await _row(w, "login_fail_count", "login_locked_until")) == (0, None), "the success must clear what was counted while it was reading"
    finally:
        await _close(engine, w)


async def test_the_same_second_step_code_from_eight_requests_in_flight_together_makes_one_session(monkeypatch):
    import pyotp

    engine, w = await _world()
    try:
        secret, _ = await _enable_totp(w)
        code = pyotp.TOTP(secret).now()
        _overlap(monkeypatch, w, 8)
        counts, results = await _answers([_sign_in(w, code=code) for _ in range(8)])
        assert counts == Counter({200: 1, 403: 7}), counts
        assert {r.json()["error"]["code"] for r in results if r.status_code == 403} == {"TOTP_REPLAYED"}
        assert await _live_except(w, None) == 1, "exactly one session came out of one code"
        # the serial refusal is unchanged
        again = await _sign_in(w, code=code)
        assert again.status_code == 403 and again.json()["error"]["code"] == "TOTP_REPLAYED"
    finally:
        await _close(engine, w)


async def test_wrong_second_step_codes_in_flight_together_lock_on_the_fifth_and_answer_429_after(monkeypatch):
    engine, w = await _world()
    try:
        await _enable_totp(w)
        _overlap(monkeypatch, w, 12)
        counts, results = await _answers([_sign_in(w, code="000000") for _ in range(12)])
        assert counts == Counter({403: 5, 429: 7}), counts
        assert {r.json()["error"]["code"] for r in results if r.status_code == 403} == {"INVALID_TOTP"}
        assert {r.json()["error"]["code"] for r in results if r.status_code == 429} == {"TOTP_LOCKED"}
        fail_count, locked_until = await _row(w, "totp_fail_count", "totp_locked_until")
        assert fail_count == 0 and locked_until is not None, "the fifth failure sets the lock and starts the count over; the later ones change nothing"
    finally:
        await _close(engine, w)


async def test_serial_second_step_behaviour_is_unchanged_a_used_code_is_refused_and_a_fresh_one_works():
    import pyotp

    engine, w = await _world()
    try:
        secret, _ = await _enable_totp(w)
        totp = pyotp.TOTP(secret)
        code = totp.now()
        assert (await _sign_in(w, code=code)).status_code == 200
        replay = await _sign_in(w, code=code)
        assert replay.status_code == 403 and replay.json()["error"]["code"] == "TOTP_REPLAYED"
        step_used = (await _row(w, "totp_last_timestep"))[0]
        assert step_used is not None
        # the next step's code (30 s later) is accepted
        later = totp.at(__import__("time").time() + 30)
        assert (await _sign_in(w, code=later)).status_code == 200
        assert (await _row(w, "totp_last_timestep"))[0] > step_used
    finally:
        await _close(engine, w)
