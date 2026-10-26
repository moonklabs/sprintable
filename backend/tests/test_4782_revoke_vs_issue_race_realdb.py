"""story 4782 (second PR) — a revoke-everything that crosses a token being issued must not leave the issued token alive (real PostgreSQL).

The promise of 4782: after a logout · «sign out everywhere else» · an administrator's removal · a password change, NO token of the person works. The all-device revoke
(`_revoke_other_sessions`, which the administrator's removal calls through `org_members._revoke_user_refresh_tokens`) is a pair of UPDATEs that run on the snapshot of their own start.
A token being issued at that moment — a switch / switch-account / refresh rotation: each ends its source token in a transaction and inserts the successor in the SAME transaction — leaves the
revoke waiting on the source row's lock; when the issuer commits, the revoke re-checks that one row, skips it and never sees the successor: it lives on (30-day refresh · 60-minute access).

The tests pause the issuing request between «the source token is ended» and «the successor is stored» (the seam `_store_refresh_token`), run the revoke in that gap, and let the issue finish.
Expected: nothing of the person is live afterwards (but the one session a «sign out everywhere else» keeps). Red on develop · green with the per-person session lock. Further tests pin the
OTHER order (the revoke is in flight, the issuer arrives), and the lock ORDER (the lock before any row of the person) with a deadlock that PostgreSQL would break by killing one side.
"""
from __future__ import annotations

import asyncio
import os

import pytest

# the world (one person in two organizations, an administrator) and the three fixtures are the 4782 file's own — one definition, not a copy
from tests.test_4782_switch_after_revoke_realdb import _PASSWORD, _close, _dispose_global_engine_after_test, _no_rate_limit, _world, anyio_backend  # noqa: F401

_REAL_DB_URL = os.getenv("PARITY_TEST_DATABASE_URL") or os.getenv("ALEMBIC_DATABASE_URL")

pytestmark = [
    pytest.mark.skipif(not _REAL_DB_URL, reason="통합 테스트는 실 PG(PARITY/ALEMBIC_DATABASE_URL) 필요"),
    pytest.mark.anyio,
]

_ISSUERS = ["switch_to_org2", "switch_to_project2", "refresh", "switch_account"]
# every way a person's sessions all end: an administrator's removal · «sign out everywhere else» · a password change · the person deleting the account · a mailbox proof that reclaims
# an account nobody had proved (it drops every sign-in)
_REVOKERS = ["removal", "logout_others", "change_password", "reset_password", "delete_account", "verify_email"]
_WAIT = 60  # no test may hang forever on a lock wait that is not a deadlock


async def _prepare(w, revoker: str) -> None:
    """what a revoker needs from the world, done AFTER the sessions are logged in (they sign in with the password)"""
    if revoker == "verify_email":  # the account is one nobody had proved: no password, mailbox not verified — the e-mail link then reclaims it
        from sqlalchemy import update

        from app.models.user import User

        async with w.Session() as s:
            await s.execute(update(User).where(User.id == w.user_id).values(email_verified=False, hashed_password=""))
            await s.commit()


async def _issue(w, issuer: str, member: dict):
    if issuer == "refresh":
        return await w.refresh(member["refresh_token"])
    if issuer == "switch_account":
        return await w.client.post("/api/v2/auth/switch-account", json={"refresh_token": member["refresh_token"]})
    return await getattr(w, issuer)(member["access_token"], member["refresh_token"])


async def _revoke(w, revoker: str, *, kept: dict, admin: dict, seat):
    bearer = {"Authorization": f"Bearer {kept['access_token']}"}
    if revoker == "removal":
        return await w.client.delete(f"/api/v2/org-members/{seat}", headers={"Authorization": f"Bearer {admin['access_token']}"})
    if revoker == "change_password":
        return await w.client.patch("/api/v2/auth/change-password", json={"current_password": _PASSWORD, "new_password": "new-pw-4782-Xx1"}, headers=bearer)
    if revoker == "delete_account":
        return await w.client.post("/api/v2/account/delete", headers=bearer)
    if revoker == "reset_password":  # the mailed link: signed out, the token names the password it replaces
        from sqlalchemy import select

        from app.core.security import create_password_reset_token
        from app.models.user import User

        async with w.Session() as s:
            current = (await s.execute(select(User.hashed_password).where(User.id == w.user_id))).scalar_one()
        return await w.client.post("/api/v2/auth/reset-password", json={"token": create_password_reset_token(str(w.user_id), current), "new_password": "new-pw-4782-Xx1"})
    if revoker == "verify_email":
        from app.core.security import create_email_verification_token

        return await w.client.get(f"/api/v2/auth/verify-email?token={create_email_verification_token(str(w.user_id))}")
    return await w.client.post("/api/v2/auth/logout-others", json={"refresh_token": kept["refresh_token"]}, headers=bearer)


def _keeps_one(revoker: str) -> bool:
    return revoker == "logout_others"


async def _live_except(w, kept: dict | None) -> int:
    from datetime import datetime, timezone

    from sqlalchemy import func, select

    from app.core.security import hash_token
    from app.models.user import RefreshToken

    conditions = [RefreshToken.user_id == w.user_id, RefreshToken.revoked_at.is_(None), RefreshToken.expires_at > datetime.now(timezone.utc)]
    if kept is not None:
        conditions.append(RefreshToken.token_hash != hash_token(kept["refresh_token"]))
    async with w.Session() as s:
        return (await s.execute(select(func.count()).select_from(RefreshToken).where(*conditions))).scalar_one()


async def _wait_until_a_lock_is_waited_for(w, timeout: float = 3.0) -> bool:
    """true as soon as some backend is waiting for a person's session lock (an ADVISORY lock that is not granted) — the revoke has reached the point under test, no sleeping and hoping. Without the
    lock (the code before the fix, or a mutant that took it out) nothing ever waits on it: the wait then runs out after `timeout` and the test goes on, so the revoke has had that long to reach
    whatever it waits on instead (the source token's row) — the assertions after it decide."""
    from sqlalchemy import text

    loop = asyncio.get_running_loop()
    deadline = loop.time() + timeout
    while loop.time() < deadline:
        async with w.Session() as s:
            if (await s.execute(text("SELECT count(*) FROM pg_locks WHERE locktype = 'advisory' AND NOT granted"))).scalar_one():
                return True
        await asyncio.sleep(0.05)
    return False


@pytest.mark.parametrize("revoker", _REVOKERS)
@pytest.mark.parametrize("issuer", _ISSUERS)
async def test_a_token_issued_while_every_other_session_is_ended_does_not_survive(issuer, revoker, monkeypatch):
    from sqlalchemy import select

    import app.routers.auth as auth_router
    from app.models.project import OrgMember

    engine, w = await _world()
    try:
        member = await w.login()          # the session the issue starts from
        kept = await w.login()            # the session «sign out everywhere else» is sent from (kept) · the caller of the other revokes
        admin = await w.login(w.admin_email)
        async with w.Session() as s:
            seat = (await s.execute(select(OrgMember.id).where(OrgMember.org_id == w.org1, OrgMember.user_id == w.user_id))).scalar_one()
        await _prepare(w, revoker)

        original = auth_router._store_refresh_token
        reached, release = asyncio.Event(), asyncio.Event()

        async def paused(session, user, *args, **kwargs):
            if user.id != w.user_id:  # the administrator's own logins are not the issue under test
                return await original(session, user, *args, **kwargs)
            reached.set()
            await release.wait()
            return await original(session, user, *args, **kwargs)

        monkeypatch.setattr(auth_router, "_store_refresh_token", paused)

        issue = asyncio.create_task(_issue(w, issuer, member))
        await asyncio.wait_for(reached.wait(), 15)  # the source token is ended; the new one is not stored yet

        revoke = asyncio.create_task(_revoke(w, revoker, kept=kept, admin=admin, seat=seat))
        assert await _wait_until_a_lock_is_waited_for(w), f"{issuer} × {revoker}: the revoke did not queue on the person's session lock behind the issue"
        release.set()
        issued, revoked = await asyncio.wait_for(asyncio.gather(issue, revoke), _WAIT)

        assert revoked.status_code == 200, revoked.text
        assert issued.status_code == 200, f"{issuer}: the issue under test did not complete: {issued.status_code} {issued.text}"
        survivors = await _live_except(w, kept if _keeps_one(revoker) else None)
        assert survivors == 0, f"{issuer} × {revoker}: a token issued across the revoke is live (live refresh tokens besides the kept one: {survivors})"
    finally:
        await _close(engine, w)


@pytest.mark.parametrize("issuer", _ISSUERS)
async def test_the_revoke_first_makes_the_issue_wait_and_then_refuses_it(issuer, monkeypatch):
    """the other order: the revoke is in flight — it HOLDS the person's session lock and has touched no row yet (the lock call is paused right after it was granted) — when the issuer arrives.
    The issuer must queue on the lock (not run on past it: the source row is free), then find its source token ended and be refused — never mint a pair. Pins the issuers' shared lock."""
    import app.routers.auth as auth_router

    engine, w = await _world()
    try:
        member = await w.login()
        kept = await w.login()
        real_lock = auth_router._lock_person_sessions
        reached, release = asyncio.Event(), asyncio.Event()

        async def holding_lock(session, user_id, *, exclusive):
            await real_lock(session, user_id, exclusive=exclusive)
            if exclusive and not reached.is_set():
                reached.set()
                await release.wait()  # holds the lock, touches nothing

        monkeypatch.setattr(auth_router, "_lock_person_sessions", holding_lock)
        revoke = asyncio.create_task(w.client.post("/api/v2/auth/logout-others", json={"refresh_token": kept["refresh_token"]}, headers={"Authorization": f"Bearer {kept['access_token']}"}))
        await asyncio.wait_for(reached.wait(), 15)
        issue = asyncio.create_task(_issue(w, issuer, member))
        assert await _wait_until_a_lock_is_waited_for(w), f"{issuer}: the issue did not queue on the person's session lock behind the revoke"
        await asyncio.sleep(0.5)
        assert not issue.done(), f"{issuer}: the issue ran on while the revoke held the person's session lock"
        release.set()
        revoked, issued = await asyncio.wait_for(asyncio.gather(revoke, issue), _WAIT)

        assert revoked.status_code == 200, revoked.text
        assert issued.status_code == 401, f"{issuer}: an issue that came after the revoke was not refused: {issued.status_code} {issued.text}"
        assert await _live_except(w, kept) == 0
    finally:
        await _close(engine, w)


@pytest.mark.parametrize("issuer", _ISSUERS)
async def test_revoke_and_issue_crossing_for_real_end_with_nothing_alive_and_no_deadlock(issuer):
    """no pauses: «sign out everywhere else» and an issue launched together, repeated. Every answer is a clean 200 / 401 (a deadlock between the lock and the person's row would surface as a 500 after
    PostgreSQL's deadlock timeout), and whichever came first, no token besides the kept one is alive at the end."""
    engine, w = await _world()
    try:
        for round_n in range(8):
            member = await w.login()
            kept = await w.login()
            issued, revoked = await asyncio.wait_for(asyncio.gather(_issue(w, issuer, member), w.client.post(
                "/api/v2/auth/logout-others", json={"refresh_token": kept["refresh_token"]}, headers={"Authorization": f"Bearer {kept['access_token']}"},
            )), _WAIT)
            assert revoked.status_code == 200, f"round {round_n}: {revoked.status_code} {revoked.text}"
            assert issued.status_code in (200, 401), f"round {round_n} {issuer}: {issued.status_code} {issued.text}"
            survivors = await _live_except(w, kept)
            assert survivors == 0, f"round {round_n} {issuer}: {survivors} token(s) besides the kept one are alive after «sign out everywhere else»"
            # the next round starts clean: end the kept one too
            await w.client.post("/api/v2/auth/logout", json={"refresh_token": kept["refresh_token"]})
    finally:
        await _close(engine, w)


@pytest.mark.parametrize("revoker", ["change_password", "reset_password", "delete_account", "verify_email"])
@pytest.mark.parametrize("issuer", ["switch_to_org2", "switch_to_project2"])
async def test_a_revoke_that_writes_the_persons_row_queues_on_the_lock_before_it_does(issuer, revoker, monkeypatch):
    """lock ORDER, held still: a switch has claimed its token (it holds the person's session lock, SHARED) and has NOT yet written the person's row (`last_org_id` · `last_project_id` — a later
    statement). A revoke that writes or locks the person's row arrives (a password change · the person deleting the account · a mailbox proof that reclaims the account). It must wait for the
    lock BEFORE it touches the person's row: if it took the row first and then waited, the switch's next statement would wait for that row while the revoke waits for the switch — PostgreSQL would
    break the deadlock by killing one of them (an error answer after its deadlock timeout)."""
    import app.routers.auth as auth_router

    engine, w = await _world()
    try:
        member = await w.login()
        kept = await w.login()
        await _prepare(w, revoker)
        original = auth_router._claim_switching_session
        reached, release = asyncio.Event(), asyncio.Event()

        async def paused_claim(*args, **kwargs):
            result = await original(*args, **kwargs)  # the lock is held, the source token is claimed — nothing of the person's row is written yet
            reached.set()
            await release.wait()
            return result

        monkeypatch.setattr(auth_router, "_claim_switching_session", paused_claim)
        issue = asyncio.create_task(_issue(w, issuer, member))
        await asyncio.wait_for(reached.wait(), 15)
        revoke = asyncio.create_task(_revoke(w, revoker, kept=kept, admin={}, seat=None))
        await asyncio.sleep(2.0)  # longer than PostgreSQL's deadlock timeout (1 s): a deadlock would already have killed one of the two
        assert not revoke.done(), f"{revoker}: the revoke did not wait for the issuing request"
        release.set()
        issued, revoked = await asyncio.wait_for(asyncio.gather(issue, revoke), _WAIT)
        assert revoked.status_code == 200, f"{revoker} failed (a deadlock?): {revoked.status_code} {revoked.text}"
        assert issued.status_code == 200, f"{issuer} failed (a deadlock?): {issued.status_code} {issued.text}"
        assert await _live_except(w, None) == 0
    finally:
        await _close(engine, w)


@pytest.mark.parametrize("late", ["refresh", "switch_to_org2"])
async def test_after_the_set_password_confirmation_a_token_a_rotation_just_ended_cannot_mint_a_new_pair(late, monkeypatch):
    """the confirmation of «set a first password» (the account signed in through a provider and had none) ends every session. Its own inline UPDATE ended only the LIVE rows and left the refresh grace
    window of a token a rotation had just ended open: R0 -> R1 by refresh, confirmation, then a late refresh / switch with R0 minted a new pair after the password was set. The shared revoke closes that
    window too. The password-staleness check of #3649 refuses such a session anyway once a whole second has passed since it began; it is switched off HERE (not left to the clock) so that only
    the closed window can refuse the late token — otherwise a second boundary between the login and the confirmation would let the test pass without testing anything."""
    from sqlalchemy import update

    import app.routers.auth as auth_router

    from app.core.security import create_set_password_confirm_token, hash_password
    from app.models.user import User

    monkeypatch.setattr(auth_router, "_is_session_stale_after_password_change", lambda *args, **kwargs: False)
    engine, w = await _world()
    try:
        r0 = await w.login()
        r1 = (await w.refresh(r0["refresh_token"])).json()["data"]  # R0 was rotated a moment ago: its window is open
        assert r1["refresh_token"]
        async with w.Session() as s:  # an account that has no password yet
            await s.execute(update(User).where(User.id == w.user_id).values(hashed_password=""))
            await s.commit()
        token = create_set_password_confirm_token(str(w.user_id), hash_password("new-pw-4782-Xx1"))
        confirmed = await w.client.get(f"/api/v2/auth/set-password/confirm?token={token}")
        assert confirmed.status_code == 200, confirmed.text
        before = await w.token_rows()
        resp = await w.refresh(r0["refresh_token"]) if late == "refresh" else await w.switch_to_org2(r0["access_token"], r0["refresh_token"])
        assert resp.status_code == 401, f"{late}: a token a rotation had just ended minted a new pair after the password was set: {resp.status_code} {resp.text}"
        assert await w.token_rows() == before
        assert await w.live_tokens() == 0
    finally:
        await _close(engine, w)


async def test_one_persons_revoke_does_not_hold_up_another_persons_refresh(monkeypatch):
    """the lock is per PERSON: while one person's all-device revoke holds it (paused right after it was granted), another person's refresh goes through at once. A lock keyed on «everybody» would
    stall every sign-in renewal of the product behind one person's account deletion."""
    import app.routers.auth as auth_router

    engine, w = await _world()
    try:
        member = await w.login()
        kept = await w.login()
        admin = await w.login(w.admin_email)  # another person
        real_lock = auth_router._lock_person_sessions
        reached, release = asyncio.Event(), asyncio.Event()

        async def holding_lock(session, user_id, *, exclusive):
            await real_lock(session, user_id, exclusive=exclusive)
            if exclusive and user_id == w.user_id and not reached.is_set():
                reached.set()
                await release.wait()

        monkeypatch.setattr(auth_router, "_lock_person_sessions", holding_lock)
        revoke = asyncio.create_task(w.client.post("/api/v2/auth/logout-others", json={"refresh_token": kept["refresh_token"]}, headers={"Authorization": f"Bearer {kept['access_token']}"}))
        await asyncio.wait_for(reached.wait(), 15)
        try:
            other = await asyncio.wait_for(w.refresh(admin["refresh_token"]), 10)
            assert other.status_code == 200, other.text
        finally:
            release.set()
        assert (await asyncio.wait_for(revoke, _WAIT)).status_code == 200
        assert member["refresh_token"]
    finally:
        await _close(engine, w)


@pytest.mark.parametrize("issuer", ["refresh", "switch_account"])
async def test_a_rotation_commits_its_link_to_the_new_token_with_the_new_token(issuer, monkeypatch):
    """the person's session lock is released at the commit that stores the successor; whoever takes it next (a phone removal, a logout) follows `replaced_by` from the old token. The link must be in that
    commit — not written by a statement that comes after it (a gap in which the chain looks like it ends at the old token)."""
    from sqlalchemy import select

    import app.routers.auth as auth_router
    from app.core.security import hash_token
    from app.models.user import RefreshToken

    engine, w = await _world()
    try:
        member = await w.login()
        original = auth_router._store_refresh_token
        seen: list = []

        async def checking(session, user, *args, **kwargs):
            result = await original(session, user, *args, **kwargs)
            async with w.Session() as s:  # a separate connection: only what the commit made visible
                seen.append((await s.execute(select(RefreshToken.replaced_by).where(RefreshToken.token_hash == hash_token(member["refresh_token"])))).scalar_one())
            return result

        monkeypatch.setattr(auth_router, "_store_refresh_token", checking)
        resp = await _issue(w, issuer, member)
        assert resp.status_code == 200, resp.text
        assert len(seen) == 1 and seen[0] is not None, f"{issuer}: the old token did not point at its successor when the successor's commit became visible: {seen}"
    finally:
        await _close(engine, w)


async def test_a_logout_with_the_cookie_a_refresh_is_rotating_ends_the_session_the_refresh_started(monkeypatch):
    """the cookie the browser logs out with was rotated out by a refresh that is still in flight (it has ended that token and not yet stored the next one). The logout used to find its token
    already ended, end nothing and leave the successor alive. Now it queues on the person's lock, sees the successor the refresh commits and ends it too."""
    import app.routers.auth as auth_router

    engine, w = await _world()
    try:
        member = await w.login()
        original = auth_router._store_refresh_token
        reached, release = asyncio.Event(), asyncio.Event()

        async def paused(session, user, *args, **kwargs):
            reached.set()
            await release.wait()
            return await original(session, user, *args, **kwargs)

        monkeypatch.setattr(auth_router, "_store_refresh_token", paused)
        refresh = asyncio.create_task(w.refresh(member["refresh_token"]))
        await asyncio.wait_for(reached.wait(), 15)
        logout = asyncio.create_task(w.client.post("/api/v2/auth/logout", json={"refresh_token": member["refresh_token"]}))
        assert await _wait_until_a_lock_is_waited_for(w), "the logout did not queue on the person's session lock behind the refresh"
        release.set()
        refreshed, logged_out = await asyncio.wait_for(asyncio.gather(refresh, logout), _WAIT)
        assert refreshed.status_code == 200, refreshed.text
        assert logged_out.status_code == 200, logged_out.text
        assert await _live_except(w, None) == 0, "the logout left the session alive: the successor the refresh committed is live"
        assert (await w.refresh(refreshed.json()["data"]["refresh_token"])).status_code == 401
    finally:
        await _close(engine, w)


async def test_a_logout_with_a_cookie_that_was_just_rotated_out_leaves_that_cookie_unusable():
    """R0 -> R1 by refresh (R0's grace window is open), then the browser logs out with the OLD cookie R0. R1 ends (it is the same session), and R0 itself must not be exchangeable any more: a logout
    that only skipped the already-ended R0 would leave R0's window open and a refresh with it would mint a live fork of the session that was just logged out."""
    engine, w = await _world()
    try:
        r0 = await w.login()
        r1 = (await w.refresh(r0["refresh_token"])).json()["data"]
        assert (await w.client.post("/api/v2/auth/logout", json={"refresh_token": r0["refresh_token"]})).status_code == 200
        assert await _live_except(w, None) == 0, "the session's later token is alive after the logout"
        before = await w.token_rows()
        resp = await w.refresh(r0["refresh_token"])
        assert resp.status_code == 401, f"the cookie the logout was sent with minted a new pair afterwards: {resp.status_code} {resp.text}"
        assert await w.token_rows() == before
        assert (await w.refresh(r1["refresh_token"])).status_code == 401
    finally:
        await _close(engine, w)


async def test_a_logout_waits_for_a_later_rotation_of_the_same_session_in_flight(monkeypatch):
    """R0 -> R1 is done; a refresh of R1 (-> R2) is in flight; the browser logs out with the OLD cookie R0. Following the chain forward from R0 without waiting would stop at R1 (R1's row is locked by
    the refresh in flight, R2 is not visible yet): R2 would live on. The logout takes the person's lock first, so R2 and its link have been committed when it reads."""
    import app.routers.auth as auth_router

    engine, w = await _world()
    try:
        r0 = await w.login()
        r1 = (await w.refresh(r0["refresh_token"])).json()["data"]
        original = auth_router._store_refresh_token
        reached, release = asyncio.Event(), asyncio.Event()

        async def paused(session, user, *args, **kwargs):
            reached.set()
            await release.wait()
            return await original(session, user, *args, **kwargs)

        monkeypatch.setattr(auth_router, "_store_refresh_token", paused)
        refresh = asyncio.create_task(w.refresh(r1["refresh_token"]))
        await asyncio.wait_for(reached.wait(), 15)
        logout = asyncio.create_task(w.client.post("/api/v2/auth/logout", json={"refresh_token": r0["refresh_token"]}))
        assert await _wait_until_a_lock_is_waited_for(w), "the logout did not queue on the person's session lock behind the rotation in flight"
        release.set()
        refreshed, logged_out = await asyncio.wait_for(asyncio.gather(refresh, logout), _WAIT)
        assert refreshed.status_code == 200 and logged_out.status_code == 200
        assert await _live_except(w, None) == 0, "the logout missed the token the refresh in flight handed out"
        assert (await w.refresh(refreshed.json()["data"]["refresh_token"])).status_code == 401
    finally:
        await _close(engine, w)


async def test_a_logout_with_the_oldest_cookie_closes_the_windows_of_every_rotated_token_after_it():
    """R0 -> R1 -> R2 by refresh, the browser logs out with the OLD cookie R0. R2 (live) ends, and R1 — rotated out a moment ago, its grace window open — must not stay exchangeable either: a walk that ended
    only the live rows would leave R1 able to fork a new pair of the session that was just logged out."""
    engine, w = await _world()
    try:
        r0 = await w.login()
        r1 = (await w.refresh(r0["refresh_token"])).json()["data"]
        r2 = (await w.refresh(r1["refresh_token"])).json()["data"]
        assert (await w.client.post("/api/v2/auth/logout", json={"refresh_token": r0["refresh_token"]})).status_code == 200
        before = await w.token_rows()
        for name, old in (("R0", r0), ("R1", r1), ("R2", r2)):
            resp = await w.refresh(old["refresh_token"])
            assert resp.status_code == 401, f"{name} still exchanged for a new pair after the logout: {resp.status_code} {resp.text}"
        assert await w.token_rows() == before
        assert await _live_except(w, None) == 0
    finally:
        await _close(engine, w)
