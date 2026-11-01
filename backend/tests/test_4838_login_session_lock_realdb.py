"""story 4838 — a password sign-in must not store a session that a password change has already ended (real PostgreSQL).

A sign-in reads the person, checks the password, and only later stores the session (several awaits between). A password change that lands in between ends «every session» — but only the
rows it can see at that moment. Before the fix the sign-in took no part in the person's session lock (`_lock_person_sessions`, which the refresh / switch issuers and every all-device
revoke already use), so a sign-in made with the OLD password could still store a refresh token (30 days) after the change.

Two orders are pinned, each with a pause inside the request (no sleeping and hoping):
  - the sign-in has READ the person (old hash in hand) → the change runs to the end → the sign-in goes on: it must read the hash again under the lock and refuse (401, no row).
  - the sign-in HOLDS the lock and has not stored the session yet → the change arrives: it must queue on the lock behind the sign-in, and end the stored session when it gets its turn.
Then an un-paused crossing, repeated, and the lock ORDER (a lock-out that has expired makes the sign-in write the person's row — the lock must come before that write).
"""
from __future__ import annotations

import asyncio
import os

import pytest

from tests.test_4782_revoke_vs_issue_race_realdb import _live_except, _wait_until_a_lock_is_waited_for
from tests.test_4782_switch_after_revoke_realdb import _PASSWORD, _close, _dispose_global_engine_after_test, _no_rate_limit, _world, anyio_backend  # noqa: F401

_REAL_DB_URL = os.getenv("PARITY_TEST_DATABASE_URL") or os.getenv("ALEMBIC_DATABASE_URL")

pytestmark = [
    pytest.mark.skipif(not _REAL_DB_URL, reason="통합 테스트는 실 PG(PARITY/ALEMBIC_DATABASE_URL) 필요"),
    pytest.mark.anyio,
]

_NEW_PASSWORD = "new-pw-4838-Xx1"
_WAIT = 60


def _change(w, session_tokens: dict, current: str = _PASSWORD, new: str = _NEW_PASSWORD):
    return w.client.patch(
        "/api/v2/auth/change-password", json={"current_password": current, "new_password": new},
        headers={"Authorization": f"Bearer {session_tokens['access_token']}"},
    )


def _sign_in(w, password: str = _PASSWORD):
    return w.client.post("/api/v2/auth/token", json={"email": w.email, "password": password})


async def test_a_sign_in_that_read_the_old_hash_before_a_password_change_is_refused_after_it(monkeypatch):
    import app.routers.auth as auth_router

    engine, w = await _world()
    try:
        existing = await w.login()
        original = auth_router._get_user_by_email
        reached, release = asyncio.Event(), asyncio.Event()

        async def paused_after_read(session, email):
            user = await original(session, email)
            if user is not None and user.id == w.user_id and not reached.is_set():
                reached.set()  # the person is read (old hash in hand); the password is not checked yet
                await release.wait()
            return user

        monkeypatch.setattr(auth_router, "_get_user_by_email", paused_after_read)
        sign_in = asyncio.create_task(_sign_in(w))
        await asyncio.wait_for(reached.wait(), 15)
        changed = await asyncio.wait_for(_change(w, existing), _WAIT)
        assert changed.status_code == 200, changed.text
        rows_before = await w.token_rows()
        release.set()
        answer = await asyncio.wait_for(sign_in, _WAIT)

        assert answer.status_code == 401, f"a sign-in with the replaced password was answered {answer.status_code}: {answer.text}"
        assert await w.token_rows() == rows_before, "a refused sign-in must store no session row"
        assert await _live_except(w, None) == 0, "a session made with the replaced password is alive after the change"
        # the new password is the one that works
        assert (await _sign_in(w, _NEW_PASSWORD)).status_code == 200
    finally:
        await _close(engine, w)


async def test_a_password_change_queues_behind_a_sign_in_that_holds_the_lock_and_ends_its_session(monkeypatch):
    import app.routers.auth as auth_router

    engine, w = await _world()
    try:
        existing = await w.login()
        original = auth_router._store_refresh_token
        reached, release = asyncio.Event(), asyncio.Event()

        async def paused_store(session, user, *args, **kwargs):
            if user.id == w.user_id and not reached.is_set():
                reached.set()  # the password is checked, the session is not stored yet
                await release.wait()
            return await original(session, user, *args, **kwargs)

        monkeypatch.setattr(auth_router, "_store_refresh_token", paused_store)
        sign_in = asyncio.create_task(_sign_in(w))
        await asyncio.wait_for(reached.wait(), 15)
        change = asyncio.create_task(_change(w, existing))
        assert await _wait_until_a_lock_is_waited_for(w), "the password change did not queue on the person's session lock behind the sign-in"
        release.set()
        signed_in, changed = await asyncio.wait_for(asyncio.gather(sign_in, change), _WAIT)

        assert changed.status_code == 200, changed.text
        assert signed_in.status_code == 200, f"the sign-in under test did not complete: {signed_in.status_code} {signed_in.text}"
        assert await _live_except(w, None) == 0, "the session the sign-in stored before the change is alive after it"
    finally:
        await _close(engine, w)


async def test_sign_ins_and_a_password_change_crossing_for_real_leave_nothing_alive_and_no_deadlock():
    """no pauses: one change and several sign-ins with the old password launched together, repeated. Every answer is a clean 200 / 401 (429 once the failed ones lock the account — a deadlock would surface as a 500), and whichever came first,
    no session made with the old password is alive at the end."""
    engine, w = await _world()
    try:
        for round_n in range(6):
            existing = await w.login()
            results = await asyncio.wait_for(asyncio.gather(
                _change(w, existing, _PASSWORD, _NEW_PASSWORD), *[_sign_in(w) for _ in range(4)],
            ), _WAIT)
            changed, sign_ins = results[0], results[1:]
            assert changed.status_code == 200, f"round {round_n}: {changed.status_code} {changed.text}"
            assert all(r.status_code in (200, 401, 429) for r in sign_ins), f"round {round_n}: {[r.status_code for r in sign_ins]}"
            assert await _live_except(w, None) == 0, f"round {round_n}: a session made with the replaced password is alive"
            # the next round starts clean: put the old password back
            from sqlalchemy import update

            from app.core.security import hash_password
            from app.models.user import User

            async with w.Session() as s:
                await s.execute(update(User).where(User.id == w.user_id).values(hashed_password=hash_password(_PASSWORD), login_fail_count=0, login_locked_until=None))
                await s.commit()
    finally:
        await _close(engine, w)


async def test_the_lock_comes_before_the_sign_in_writes_the_persons_row(monkeypatch):
    """lock ORDER, held still: a password change holds the person's session lock (EXCLUSIVE) and has not written the person's row yet. A sign-in arrives for an account whose lock-out has
    EXPIRED — it resets the counters, which writes the person's row. It must queue on the session lock BEFORE that write: if it wrote the row first and then waited for the lock, the change's
    next statement (the row) would wait for the sign-in while the sign-in waits for the change — PostgreSQL breaks that deadlock by killing one of them."""
    from datetime import datetime, timedelta, timezone

    from sqlalchemy import update

    import app.routers.auth as auth_router
    from app.models.user import User

    engine, w = await _world()
    try:
        existing = await w.login()
        async with w.Session() as s:
            await s.execute(update(User).where(User.id == w.user_id).values(login_fail_count=5, login_locked_until=datetime.now(timezone.utc) - timedelta(minutes=1)))
            await s.commit()
        real_lock = auth_router._lock_person_sessions
        reached, release = asyncio.Event(), asyncio.Event()

        async def holding_lock(session, user_id, *, exclusive):
            await real_lock(session, user_id, exclusive=exclusive)
            if exclusive and user_id == w.user_id and not reached.is_set():
                reached.set()
                await release.wait()  # holds the lock, has written nothing

        monkeypatch.setattr(auth_router, "_lock_person_sessions", holding_lock)
        change = asyncio.create_task(_change(w, existing))
        await asyncio.wait_for(reached.wait(), 15)
        sign_in = asyncio.create_task(_sign_in(w))
        assert await _wait_until_a_lock_is_waited_for(w), "the sign-in did not queue on the person's session lock behind the change"
        await asyncio.sleep(2.0)  # longer than PostgreSQL's deadlock timeout (1 s)
        release.set()
        changed, signed_in = await asyncio.wait_for(asyncio.gather(change, sign_in), _WAIT)
        assert changed.status_code == 200, f"the change failed (a deadlock?): {changed.status_code} {changed.text}"
        assert signed_in.status_code == 401, f"the sign-in with the replaced password was answered {signed_in.status_code} (a deadlock?): {signed_in.text}"
        assert await _live_except(w, None) == 0
    finally:
        await _close(engine, w)


# ─── the account's own deletion crossing a sign-in · the provider road (`/auth/oauth/callback`) ───────────────────────────────────────────────────────────────────────────────────────

def _delete(w, session_tokens: dict):
    return w.client.post("/api/v2/account/delete", headers={"Authorization": f"Bearer {session_tokens['access_token']}"})


async def test_a_sign_in_that_read_an_open_account_before_its_deletion_is_refused_after_it(monkeypatch):
    import app.routers.auth as auth_router

    engine, w = await _world()
    try:
        existing = await w.login()
        original = auth_router._get_user_by_email
        reached, release = asyncio.Event(), asyncio.Event()

        async def paused_after_read(session, email):
            user = await original(session, email)
            if user is not None and user.id == w.user_id and not reached.is_set():
                reached.set()
                await release.wait()
            return user

        monkeypatch.setattr(auth_router, "_get_user_by_email", paused_after_read)
        sign_in = asyncio.create_task(_sign_in(w))
        await asyncio.wait_for(reached.wait(), 15)
        deleted = await asyncio.wait_for(_delete(w, existing), _WAIT)
        assert deleted.status_code == 200, deleted.text
        rows_before = await w.token_rows()
        release.set()
        answer = await asyncio.wait_for(sign_in, _WAIT)

        assert answer.status_code == 401, f"a sign-in into a deleted account was answered {answer.status_code}: {answer.text}"
        assert await w.token_rows() == rows_before
        assert await _live_except(w, None) == 0
    finally:
        await _close(engine, w)


async def _provider_world(w) -> str:
    from sqlalchemy import update

    from app.models.user import User

    sub = f"g-4838-{w.user_id.hex[:8]}"
    async with w.Session() as s:
        await s.execute(update(User).where(User.id == w.user_id).values(google_id=sub))
        await s.commit()
    return sub


def _provider_callback(w, monkeypatch, sub: str):
    from unittest.mock import AsyncMock

    import app.routers.auth as auth_router
    from app.core.security import create_oauth_state_token

    monkeypatch.setattr(auth_router, "_exchange_oauth_code_for_userinfo", AsyncMock(return_value=(sub, w.email, True)))
    return w.client.post("/api/v2/auth/oauth/callback", json={"provider": "google", "code": "c", "state": create_oauth_state_token("google"), "tos_accepted": True})


async def test_a_provider_sign_in_holds_the_lock_while_it_stores_so_the_accounts_deletion_ends_its_session(monkeypatch):
    import app.routers.auth as auth_router

    engine, w = await _world()
    try:
        existing = await w.login()
        sub = await _provider_world(w)
        original = auth_router._store_refresh_token
        reached, release = asyncio.Event(), asyncio.Event()

        async def paused_store(session, user, *args, **kwargs):
            if user.id == w.user_id and not reached.is_set():
                reached.set()
                await release.wait()
            return await original(session, user, *args, **kwargs)

        monkeypatch.setattr(auth_router, "_store_refresh_token", paused_store)
        callback = asyncio.create_task(_provider_callback(w, monkeypatch, sub))
        await asyncio.wait_for(reached.wait(), 15)
        delete = asyncio.create_task(_delete(w, existing))
        assert await _wait_until_a_lock_is_waited_for(w), "the deletion did not queue on the person's session lock behind the provider sign-in"
        release.set()
        signed_in, deleted = await asyncio.wait_for(asyncio.gather(callback, delete), _WAIT)

        assert deleted.status_code == 200, deleted.text
        assert signed_in.status_code == 200, f"the provider sign-in under test did not complete: {signed_in.status_code} {signed_in.text}"
        assert await _live_except(w, None) == 0, "the session the provider sign-in stored before the deletion is alive after it"
    finally:
        await _close(engine, w)


async def test_a_provider_sign_in_that_matched_an_open_account_before_its_deletion_is_refused_after_it(monkeypatch):
    import app.routers.auth as auth_router

    engine, w = await _world()
    try:
        existing = await w.login()
        sub = await _provider_world(w)
        real_lock = auth_router._lock_person_sessions
        reached, release = asyncio.Event(), asyncio.Event()

        async def paused_before_lock(session, user_id, *, exclusive):
            if not exclusive and user_id == w.user_id and not reached.is_set():
                reached.set()  # the person is matched; the session is not issued, the lock is not taken
                await release.wait()
            return await real_lock(session, user_id, exclusive=exclusive)

        monkeypatch.setattr(auth_router, "_lock_person_sessions", paused_before_lock)
        callback = asyncio.create_task(_provider_callback(w, monkeypatch, sub))
        try:
            await asyncio.wait_for(reached.wait(), 15)
        except asyncio.TimeoutError:
            pytest.fail("the provider sign-in did not take the person's session lock before issuing its session")
        deleted = await asyncio.wait_for(_delete(w, existing), _WAIT)
        assert deleted.status_code == 200, deleted.text
        rows_before = await w.token_rows()
        release.set()
        answer = await asyncio.wait_for(callback, _WAIT)

        assert answer.status_code == 401, f"a provider sign-in into a deleted account was answered {answer.status_code}: {answer.text}"
        assert await w.token_rows() == rows_before
        assert await _live_except(w, None) == 0
    finally:
        await _close(engine, w)
