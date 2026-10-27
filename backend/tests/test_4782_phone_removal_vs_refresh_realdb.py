"""story 4782 (second PR) — removing a lost phone while its login session is refreshing must not leave the refresh's new token alive (real PostgreSQL).

`remove_phone` ends the phone's login session by following the rotation chain (`replaced_by`) from the token the phone registered with to its live end. A refresh of that session in flight (it has ended
the token and not yet stored the next one — one transaction) was missed: the removal read the chain before the new token existed, found nothing live and answered `not_found`, and the new token lived
on (the thief's phone). Now the removal takes the person's session lock first, so it reads the chain after the refresh has committed (the link `replaced_by` is committed with the new token).
Reuses the world of the story 4629 tests.
"""
from __future__ import annotations

import asyncio

import pytest

from tests.test_4629_remove_phone_ends_its_session_realdb import (  # noqa: F401 — fixtures (autouse ones apply here too) and helpers
    OWNER,
    PHONES,
    _client,
    _dispose_global_engine_after_test,
    _login,
    _no_rate_limit,
    _person,
    _refresh,
    _register,
    _sql,
    anyio_backend,
    world,
)

pytestmark = pytest.mark.anyio


async def test_a_refresh_of_the_phones_session_in_flight_does_not_outlive_the_removal(world, monkeypatch):
    import app.routers.auth as auth_router

    async with _client() as c:
        phone_rt = await _login(OWNER)
        phone = await _register(c, rt=phone_rt)
        original = auth_router._store_refresh_token
        reached, release = asyncio.Event(), asyncio.Event()

        async def paused(session, user, *args, **kwargs):
            if user.id != OWNER:
                return await original(session, user, *args, **kwargs)
            reached.set()
            await release.wait()
            return await original(session, user, *args, **kwargs)

        monkeypatch.setattr(auth_router, "_store_refresh_token", paused)
        refresh = asyncio.create_task(_refresh(c, phone_rt))
        await asyncio.wait_for(reached.wait(), 15)  # the phone's token is ended; its successor is not stored yet
        removal = asyncio.create_task(c.delete(f"{PHONES}/{phone}", headers=_person(OWNER)))
        waited = False
        for _ in range(60):  # the removal queues behind the refresh on the person's session lock: wait until an advisory lock is waited for (3 s at most — without the lock nothing ever waits on it)
            if (await _sql(fetch="SELECT count(*) FROM pg_locks WHERE locktype = 'advisory' AND NOT granted"))[0][0]:
                waited = True
                break
            await asyncio.sleep(0.05)
        assert waited, "the phone removal did not queue on the person's session lock behind the refresh"
        release.set()
        refreshed, removed = await asyncio.wait_for(asyncio.gather(refresh, removal), 60)

        assert refreshed.status_code == 200, refreshed.text
        assert removed.status_code == 200 and removed.json() == {"removed": True, "session": "ended"}, f"the removal did not find the phone's new token: {removed.text}"
        new_rt = refreshed.json()["data"]["refresh_token"]
        assert (await _refresh(c, new_rt)).status_code == 401, "the token the phone's refresh handed out is alive after the phone was removed"
        live = (await _sql(fetch=f"SELECT count(*) FROM refresh_tokens WHERE user_id = '{OWNER}' AND revoked_at IS NULL AND expires_at > now()"))[0][0]
        assert live == 0


async def test_a_removal_arriving_while_a_revoke_holds_the_lock_and_writes_the_key_row_does_not_deadlock(world, monkeypatch):
    """lock ORDER of the removal: the person's session lock BEFORE the key row. A revoke that holds the lock and then writes the person's phone keys (the mailbox-proof reclaim of an unproved account
    revokes them) meets a removal of one of those keys. If the removal had taken the key row first and the lock second, the revoke would wait for the row and the removal for the lock — PostgreSQL
    breaks that by killing one side (a 500). Held still: the revoke is paused right after the lock was granted; the removal queues behind it; then both go on."""
    import app.routers.auth as auth_router
    from app.core.security import create_email_verification_token

    async with _client() as c:
        phone_rt = await _login(OWNER)
        phone = await _register(c, rt=phone_rt)
        await _sql(f"UPDATE users SET email_verified = false, hashed_password = '' WHERE id = '{OWNER}'")  # an account nobody had proved: the mailbox proof reclaims it
        real_lock = auth_router._lock_person_sessions
        reached, release = asyncio.Event(), asyncio.Event()

        async def holding_lock(session, user_id, *, exclusive):
            await real_lock(session, user_id, exclusive=exclusive)
            if exclusive and user_id == OWNER and not reached.is_set():
                reached.set()
                await release.wait()

        monkeypatch.setattr(auth_router, "_lock_person_sessions", holding_lock)
        reclaim = asyncio.create_task(c.get(f"/api/v2/auth/verify-email?token={create_email_verification_token(str(OWNER))}"))
        await asyncio.wait_for(reached.wait(), 15)  # the revoke holds the lock; it has not written the key rows yet
        removal = asyncio.create_task(c.delete(f"{PHONES}/{phone}", headers=_person(OWNER)))
        waited = False
        for _ in range(60):
            if (await _sql(fetch="SELECT count(*) FROM pg_locks WHERE locktype = 'advisory' AND NOT granted"))[0][0]:
                waited = True
                break
            await asyncio.sleep(0.05)
        assert waited, "the phone removal did not queue on the person's session lock behind the revoke"
        await asyncio.sleep(2.0)  # longer than PostgreSQL's deadlock timeout (1 s): with the key row taken first the deadlock would already have killed one of the two
        release.set()
        reclaimed, removed = await asyncio.wait_for(asyncio.gather(reclaim, removal), 60)
        assert reclaimed.status_code == 200, f"the revoke failed (a deadlock?): {reclaimed.status_code} {reclaimed.text}"
        assert removed.status_code == 200, f"the removal failed (a deadlock?): {removed.status_code} {removed.text}"


async def test_a_member_without_the_right_to_remove_the_key_takes_no_lock_and_gets_the_404(world, monkeypatch):
    """the removal checks WHO MAY remove the key before it takes the owner's session lock: somebody else's member asking to remove OWNER's key is answered 404 and never holds (or waits for) OWNER's lock."""
    import app.routers.auth as auth_router
    from tests.test_4424_desktop_setup_realdb import PLAIN

    async with _client() as c:
        phone = await _register(c, rt=await _login(OWNER))
        taken: list = []
        real_lock = auth_router._lock_person_sessions

        async def recording_lock(session, user_id, *, exclusive):
            taken.append((user_id, exclusive))
            return await real_lock(session, user_id, exclusive=exclusive)

        monkeypatch.setattr(auth_router, "_lock_person_sessions", recording_lock)
        denied = await c.delete(f"{PHONES}/{phone}", headers=_person(PLAIN))
        assert denied.status_code == 404, denied.text
        assert (OWNER, True) not in taken, "a caller who may not remove the key took the owner's session lock"


async def test_removing_a_phone_also_ends_the_fork_a_rotation_race_of_its_session_left(world):
    """story 4782 (third PR): the phone's login session rotated by two crossing refreshes with the same cookie (two pods · two requests) has a winner line AND a fork that nothing points at. The removal ends
    the session's whole family — the chain walk of `_end_phone_session` alone reaches the winner's line only."""
    async with _client() as c:
        phone_rt = await _login(OWNER)
        phone = await _register(c, rt=phone_rt)
        one, two = await asyncio.gather(_refresh(c, phone_rt), _refresh(c, phone_rt))
        assert one.status_code == 200 and two.status_code == 200, f"{one.status_code} {two.status_code}"
        live_before = (await _sql(fetch=f"SELECT count(*) FROM refresh_tokens WHERE user_id = '{OWNER}' AND revoked_at IS NULL AND expires_at > now()"))[0][0]
        assert live_before == 2, "the winner's token and the fork are both live before the removal"
        removed = await c.delete(f"{PHONES}/{phone}", headers=_person(OWNER))
        assert removed.status_code == 200 and removed.json() == {"removed": True, "session": "ended"}, removed.text
        live = (await _sql(fetch=f"SELECT count(*) FROM refresh_tokens WHERE user_id = '{OWNER}' AND revoked_at IS NULL AND expires_at > now()"))[0][0]
        assert live == 0, "the removal left the fork alive"
        for response in (one, two):
            assert (await _refresh(c, response.json()["data"]["refresh_token"])).status_code == 401


async def test_removing_a_phone_ends_a_family_that_starts_in_the_middle_of_its_sessions_chain(world):
    """codex 4782 (third PR) round 1: old pods write no family; the phone registered with R0, a refresh gave R1 (both without a family), and a new pod rotated R1 twice with one cookie: R1 started the family, the
    winner and the fork joined it, R0 has none. The removal looks at the family of EVERY row of the chain, not of the first only."""
    async with _client() as c:
        phone_rt = await _login(OWNER)
        phone = await _register(c, rt=phone_rt)
        r1 = (await _refresh(c, phone_rt)).json()["data"]["refresh_token"]
        await _sql(f"UPDATE refresh_tokens SET family_id = NULL WHERE user_id = '{OWNER}'")
        one, two = await asyncio.gather(_refresh(c, r1), _refresh(c, r1))
        assert one.status_code == 200 and two.status_code == 200
        removed = await c.delete(f"{PHONES}/{phone}", headers=_person(OWNER))
        assert removed.status_code == 200 and removed.json() == {"removed": True, "session": "ended"}, removed.text
        live = (await _sql(fetch=f"SELECT count(*) FROM refresh_tokens WHERE user_id = '{OWNER}' AND revoked_at IS NULL AND expires_at > now()"))[0][0]
        assert live == 0, "the removal left the fork of the later family alive"
