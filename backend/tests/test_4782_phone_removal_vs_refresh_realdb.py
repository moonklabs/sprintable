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
