"""story 4782 (third PR) — a sign-in's refresh tokens are one FAMILY (`refresh_tokens.family_id`, migration 0468), and a logout · a lost phone's removal ends the whole family (real PostgreSQL).

The hole it closes: two refreshes with the SAME cookie inside the rotation grace window (two tabs · two pods, §2449) split the lineage — the winner is linked from the old token (`replaced_by`), the
loser's new token is a fork that NOTHING points at. A logout walks `replaced_by`: forward without a clock, backward bounded by the rotation window. So it reached the winner's line and missed the fork, and
from the fork's cookie it missed the winner — and from the winner's far end (an old R0 outside the window) it missed the fork altogether: a stolen token that had forked once survived the owner's logout for
30 days. Now every rotation inherits its parent's `family_id` and the logout is ONE statement over `(user_id, family_id)`.

Red on develop (the first two tests of the loser fork · the far end) · green with the family. The rest pins what the family must NOT do (another person · another sign-in of the same person), what it
inherits through (every rotation road), the rows from before the migration (the walks still cover them), the index the statement uses, and the migration's own downgrade / upgrade.
"""
from __future__ import annotations

import os

import pytest

from tests.test_4782_revoke_vs_issue_race_realdb import _live_except, _two_refreshes_with_one_cookie  # noqa: F401
from tests.test_4782_switch_after_revoke_realdb import _close, _dispose_global_engine_after_test, _no_rate_limit, _world, anyio_backend  # noqa: F401

_REAL_DB_URL = os.getenv("PARITY_TEST_DATABASE_URL") or os.getenv("ALEMBIC_DATABASE_URL")

pytestmark = [
    pytest.mark.skipif(not _REAL_DB_URL, reason="통합 테스트는 실 PG(PARITY/ALEMBIC_DATABASE_URL) 필요"),
    pytest.mark.anyio,
]


async def _exec(w, sql: str, **params) -> None:
    from sqlalchemy import text

    async with w.Session() as s:
        await s.execute(text(sql), params)
        await s.commit()


async def _fetch(w, sql: str, **params) -> list[tuple]:
    from sqlalchemy import text

    async with w.Session() as s:
        return [tuple(r) for r in (await s.execute(text(sql), params)).all()]


async def _plan(w, sql: str) -> str:
    """the planner's choice for a statement on `refresh_tokens` with sequential scans forbidden AND the plain `(user_id)` index dropped inside a transaction that is rolled back — the family index is then the only path
    that can serve `user_id = … AND family_id = …`, so the plan names it or the test fails (with both indexes present a tie between them would make the answer depend on table statistics). EXPLAIN only — nothing is
    executed; the session never commits."""
    from sqlalchemy import text

    async with w.Session() as s:
        for (name,) in (await s.execute(text("SELECT indexname FROM pg_indexes WHERE tablename = 'refresh_tokens' AND indexdef LIKE '%(user_id)'"))).all():
            await s.execute(text(f'DROP INDEX "{name}"'))
        await s.execute(text("SET LOCAL enable_seqscan = off"))
        plan = "\n".join(r[0] for r in (await s.execute(text("EXPLAIN " + sql))).all())
        await s.rollback()
    return plan


async def _family(w, raw_refresh: str):
    """(row id, family_id) of the token — as stored"""
    from sqlalchemy import select

    from app.core.security import hash_token
    from app.models.user import RefreshToken

    async with w.Session() as s:
        return (await s.execute(select(RefreshToken.id, RefreshToken.family_id).where(RefreshToken.token_hash == hash_token(raw_refresh)))).one()


async def _logout(w, raw_refresh: str):
    return await w.client.post("/api/v2/auth/logout", json={"refresh_token": raw_refresh})


async def test_a_sign_in_starts_a_family_of_its_own_and_every_rotation_road_inherits_it():
    engine, w = await _world()
    try:
        first = await w.login()
        second = await w.login()           # another sign-in of the same person (another device)
        other = await w.login(w.admin_email)  # another person
        root = await _family(w, first["refresh_token"])
        assert root.family_id == root.id, "a sign-in's family is its first token"
        assert (await _family(w, second["refresh_token"])).family_id != root.family_id, "another sign-in of the same person is another family"
        assert (await _family(w, other["refresh_token"])).family_id != root.family_id

        # refresh (the winner) · switch-org · switch-project · switch-account: the session goes on, the family stays
        rotated = (await w.refresh(first["refresh_token"])).json()["data"]
        assert (await _family(w, rotated["refresh_token"])).family_id == root.family_id, "the refresh winner inherits"
        project_resp = await w.switch_to_project2(rotated["access_token"], rotated["refresh_token"])  # project2 belongs to org1: switch the project before leaving org1
        assert project_resp.status_code == 200, project_resp.text
        project = project_resp.json()["data"]
        assert (await _family(w, project["refresh_token"])).family_id == root.family_id, "switch-project inherits"
        org_resp = await w.switch_to_org2(project["access_token"], project["refresh_token"])
        assert org_resp.status_code == 200, org_resp.text
        org = org_resp.json()["data"]
        assert (await _family(w, org["refresh_token"])).family_id == root.family_id, "switch-org inherits"
        account = (await w.client.post("/api/v2/auth/switch-account", json={"refresh_token": org["refresh_token"]})).json()["data"]
        assert (await _family(w, account["refresh_token"])).family_id == root.family_id, "switch-account inherits (it rotates the TARGET account's own token: the person does not change)"

        # the race loser's fork
        r0, winner, loser = await _two_refreshes_with_one_cookie(w)
        family = (await _family(w, r0["refresh_token"])).family_id
        assert (await _family(w, winner["refresh_token"])).family_id == family and (await _family(w, loser["refresh_token"])).family_id == family, "winner and fork inherit"
    finally:
        await _close(engine, w)


async def test_a_logout_from_the_far_end_of_the_winners_line_ends_a_fork_that_nothing_points_at():
    """the shape that matters for a stolen token: the fork was made long ago (R0 rotated hours back, far outside the rotation window the backward walk is bounded by), the owner's browser holds the winner
    line's latest token and logs out. Walking cannot reach the fork from there; the family does."""
    engine, w = await _world()
    try:
        r0, winner, fork = await _two_refreshes_with_one_cookie(w)
        latest = winner
        for _ in range(2):  # the winner's line goes on: W -> W2 -> W3
            latest = (await w.refresh(latest["refresh_token"])).json()["data"]
        await _exec(w, "UPDATE refresh_tokens SET revoked_at = now() - interval '3 hours' WHERE user_id = :u AND revoked_at IS NOT NULL", u=w.user_id)
        assert await _live_except(w, None) == 2, "the fork and the winner line's latest token are live before the logout"
        assert (await _logout(w, latest["refresh_token"])).status_code == 200
        assert await _live_except(w, None) == 0, "the logout left the fork (a token nothing points at) alive"
        assert (await w.refresh(fork["refresh_token"])).status_code == 401
    finally:
        await _close(engine, w)


async def test_a_logout_ends_this_sign_in_only_not_another_device_of_the_person_and_not_another_person():
    engine, w = await _world()
    try:
        phone_a = await w.login()
        phone_b = await w.login()            # the person's other device
        admin = await w.login(w.admin_email)  # another person
        r0, winner, fork = await _two_refreshes_with_one_cookie(w)
        assert (await _logout(w, r0["refresh_token"])).status_code == 200
        assert (await w.refresh(winner["refresh_token"])).status_code == 401 and (await w.refresh(fork["refresh_token"])).status_code == 401
        assert (await w.refresh(phone_b["refresh_token"])).status_code == 200, "another sign-in of the same person must stay"
        assert (await w.refresh(admin["refresh_token"])).status_code == 200, "another person's token must stay"
        assert phone_a["refresh_token"]
    finally:
        await _close(engine, w)


async def test_the_statement_is_keyed_by_the_person_a_family_value_on_another_persons_row_is_not_touched():
    """`user_id` is part of the statement's key, not only a courtesy of the index: a row of ANOTHER person that carries the same family value (a damaged row — nothing in the app writes it) is left alone."""
    from app.core.security import hash_token

    engine, w = await _world()
    try:
        member = await w.login()
        admin = await w.login(w.admin_email)
        member_family = (await _family(w, member["refresh_token"])).family_id
        await _exec(w, "UPDATE refresh_tokens SET family_id = :f WHERE token_hash = :h", f=member_family, h=hash_token(admin["refresh_token"]))
        assert (await _logout(w, member["refresh_token"])).status_code == 200
        assert (await w.refresh(admin["refresh_token"])).status_code == 200, "the logout reached another person's row through a shared family value"
    finally:
        await _close(engine, w)


async def test_rows_from_before_the_migration_have_no_family_and_the_walks_still_end_them():
    """family_id NULL (every row made before 0468): the second PR's walks are the only thing that reaches them — a logout with the first token ends the lineage forward."""
    engine, w = await _world()
    try:
        first = await w.login()
        second = (await w.refresh(first["refresh_token"])).json()["data"]
        third = (await w.refresh(second["refresh_token"])).json()["data"]
        await _exec(w, "UPDATE refresh_tokens SET family_id = NULL WHERE user_id = :u", u=w.user_id)
        assert (await _logout(w, first["refresh_token"])).status_code == 200
        assert await _live_except(w, None) == 0, "a lineage of rows with no family must still end through the walk"
        assert (await w.refresh(third["refresh_token"])).status_code == 401
        # the cookie of the logout and the one after it were rotated out inside their grace window: the walk closes those windows too (no family to do it)
        assert (await w.refresh(first["refresh_token"])).status_code == 401, "the rotated cookie of the logout still forked a new pair inside its window"
        assert (await w.refresh(second["refresh_token"])).status_code == 401, "a rotated token of the lineage still forked a new pair inside its window"
    finally:
        await _close(engine, w)


async def test_a_race_on_a_token_from_before_the_migration_starts_the_family_at_that_token():
    """the legacy token R0 (family NULL) is rotated by two crossing refreshes: it names ITSELF as the family and both children join it — the same value from both, whichever wrote first."""
    engine, w = await _world()
    try:
        r0 = await w.login()
        await _exec(w, "UPDATE refresh_tokens SET family_id = NULL WHERE user_id = :u", u=w.user_id)
        import asyncio

        one, two = await asyncio.gather(w.refresh(r0["refresh_token"]), w.refresh(r0["refresh_token"]))
        assert one.status_code == 200 and two.status_code == 200
        legacy = await _family(w, r0["refresh_token"])
        assert legacy.family_id == legacy.id, "the legacy parent starts the family at itself"
        for pair in (one.json()["data"], two.json()["data"]):
            assert (await _family(w, pair["refresh_token"])).family_id == legacy.id
        assert (await _logout(w, one.json()["data"]["refresh_token"])).status_code == 200
        assert await _live_except(w, None) == 0, "the family of a rotated legacy token must end as one"
    finally:
        await _close(engine, w)


async def test_the_index_has_the_shape_of_the_statement_that_uses_it():
    """`UPDATE … WHERE user_id = :u AND family_id = :f` runs on `(user_id, family_id)` — the planner is asked with sequential scans forbidden, so a missing or differently shaped index shows."""
    engine, w = await _world()
    try:
        rows = await _fetch(w, "SELECT indexdef FROM pg_indexes WHERE tablename = 'refresh_tokens' AND indexname = 'ix_refresh_tokens_user_family'")
        assert len(rows) == 1, "migration 0468 creates the index"
        assert "(user_id, family_id)" in rows[0][0] and "family_id IS NOT NULL" in rows[0][0], rows[0][0]
        plan = await _plan(w, 
            "UPDATE refresh_tokens SET expires_at = expires_at WHERE user_id = '00000000-0000-0000-0000-000000000001' AND family_id = '00000000-0000-0000-0000-000000000002' AND revoked_at IS NULL"
        )
        assert "ix_refresh_tokens_user_family" in plan, plan
    finally:
        await _close(engine, w)


async def test_the_migration_goes_down_and_up_again():
    """0468 → 0467 → 0468 through the module's own `downgrade()` / `upgrade()`: the column and the index go and come back; the tokens already stored are untouched by the round trip (the column is the only thing
    that changes), and a logout still ends them through the walks while the column is away is NOT claimed — it is the code of the same commit that reads it."""
    import importlib.util
    from pathlib import Path

    from alembic.migration import MigrationContext
    from alembic.operations import Operations

    path = Path(__file__).resolve().parent.parent / "alembic" / "versions" / "0468_refresh_tokens_family_id.py"
    spec = importlib.util.spec_from_file_location("m0468_rt", path)
    module = importlib.util.module_from_spec(spec)
    spec.loader.exec_module(module)
    assert module.revision == "0468" and module.down_revision == "0467"

    def _call(sync_conn, which: str) -> None:
        with Operations.context(MigrationContext.configure(sync_conn)):
            getattr(module, which)()

    engine, w = await _world()
    try:
        first = await w.login()
        async with engine.begin() as conn:
            await conn.run_sync(_call, "downgrade")
        assert await _fetch(w, "SELECT 1 FROM information_schema.columns WHERE table_name = 'refresh_tokens' AND column_name = 'family_id'") == [], "the column goes"
        assert await _fetch(w, "SELECT 1 FROM pg_indexes WHERE indexname = 'ix_refresh_tokens_user_family'") == [], "the index goes"
        assert (await _fetch(w, "SELECT count(*) FROM refresh_tokens WHERE user_id = :u", u=w.user_id))[0][0] >= 1, "the rows stay"
        async with engine.begin() as conn:
            await conn.run_sync(_call, "downgrade")   # a second downgrade finds nothing to drop: no error (IF EXISTS)
            await conn.run_sync(_call, "upgrade")
            await conn.run_sync(_call, "upgrade")     # an operator who built the column and the index by hand beforehand: the migration finds them and does nothing (IF NOT EXISTS)
        assert len(await _fetch(w, "SELECT 1 FROM information_schema.columns WHERE table_name = 'refresh_tokens' AND column_name = 'family_id'")) == 1, "the column is back"
        assert len(await _fetch(w, "SELECT 1 FROM pg_indexes WHERE indexname = 'ix_refresh_tokens_user_family'")) == 1, "the index is back"
        assert first["refresh_token"]
    finally:
        await _close(engine, w)


async def test_after_a_logout_with_the_forks_cookie_the_old_token_inside_its_window_cannot_fork_again():
    """the grace window of the rotated ORIGINAL token R0 (still open for `auth_refresh_chain_resolve_window_seconds`): nothing points at the fork, so no walk from the fork's cookie closes R0's window — and a refresh
    with R0 inside it would mint a new pair of the session that was just logged out. The family closes the windows of its rotated rows too."""
    engine, w = await _world()
    try:
        r0, winner, fork = await _two_refreshes_with_one_cookie(w)
        assert (await _logout(w, fork["refresh_token"])).status_code == 200
        assert (await w.refresh(r0["refresh_token"])).status_code == 401, "the rotated original token still forked a new pair inside its grace window after the logout"
        assert await _live_except(w, None) == 0
    finally:
        await _close(engine, w)


async def test_a_parent_of_another_person_is_not_inherited_the_new_token_starts_a_family_of_its_own():
    """`_store_refresh_token` reads the parent by hash AND by the person the token is issued to: a parent row of someone else is ignored (a family never crosses persons)."""
    import uuid
    from datetime import datetime, timedelta, timezone

    from sqlalchemy import select

    from app.core.security import hash_token
    from app.models.user import User
    from app.routers.auth import _store_refresh_token

    raw = f"raw-token-of-the-member-{uuid.uuid4().hex}"  # `token_hash` is unique and a mutant run reuses the database: one token per run
    engine, w = await _world()
    try:
        admin = await w.login(w.admin_email)
        admin_family = (await _family(w, admin["refresh_token"])).family_id
        async with w.Session() as s:
            member = (await s.execute(select(User).where(User.id == w.user_id))).scalar_one()
            new_id = await _store_refresh_token(
                s, member, raw, datetime.now(timezone.utc) + timedelta(days=1), app_metadata={},
                parent_token_hash=hash_token(admin["refresh_token"]),
            )
        stored = await _family(w, raw)
        assert stored.id == new_id and stored.family_id == new_id != admin_family, "the member's token inherited another person's family"
        assert uuid.UUID(str(stored.family_id))
    finally:
        await _close(engine, w)


async def test_with_a_family_a_logout_closes_every_rotated_row_of_the_session_however_old():
    """the other side of the walk's time bound (`test_the_logout_walk_stops_at_the_first_row_older_than_the_window`, which pins it for rows WITHOUT a family): with a family nothing is left to a clock — a and b,
    rotated an hour ago, lose what is left of their windows too."""
    from datetime import datetime, timedelta, timezone

    from sqlalchemy import select, update

    from app.core.security import hash_token
    from app.models.user import RefreshToken

    engine, w = await _world()
    try:
        a = await w.login()
        b = (await w.refresh(a["refresh_token"])).json()["data"]
        c = (await w.refresh(b["refresh_token"])).json()["data"]
        async with w.Session() as s:
            for old in (a, b):
                await s.execute(update(RefreshToken).where(RefreshToken.token_hash == hash_token(old["refresh_token"])).values(revoked_at=datetime.now(timezone.utc) - timedelta(hours=1)))
            await s.commit()
        assert (await _logout(w, c["refresh_token"])).status_code == 200
        async with w.Session() as s:
            open_windows = (await s.execute(select(RefreshToken.id).where(RefreshToken.user_id == w.user_id, RefreshToken.expires_at > datetime.now(timezone.utc)))).all()
        assert open_windows == [], "a rotated row of the session kept its grace window after the logout"
    finally:
        await _close(engine, w)


async def test_a_logout_waiting_for_a_rotation_of_a_token_from_before_the_migration_ends_the_fork_of_that_rotation(monkeypatch):
    """codex 4782 (third PR) round 1: the logout used to read the presented token's family BEFORE it waited for the person's exclusive session lock. A token from before migration 0468 (family NULL) that a
    rotation in flight gives its family at commit was still NULL in that read — the family step was skipped and the fork of the crossing second refresh survived. Held still: refresh A is paused after it
    ended the token (it holds the lock shared); refresh B with the same cookie waits on the token's row (it holds the lock shared too); the logout queues for the exclusive lock; A goes on, B follows as the race
    loser. The family is read after the lock."""
    import asyncio

    import app.routers.auth as auth_router
    from tests.test_4782_revoke_vs_issue_race_realdb import _wait_until_a_lock_is_waited_for

    engine, w = await _world()
    try:
        r0 = await w.login()
        await _exec(w, "UPDATE refresh_tokens SET family_id = NULL WHERE user_id = :u", u=w.user_id)  # a token from before the migration
        original = auth_router._store_refresh_token
        reached, release, first = asyncio.Event(), asyncio.Event(), []

        async def paused(session, user, *args, **kwargs):
            if user.id != w.user_id or first:  # only the first refresh is held
                return await original(session, user, *args, **kwargs)
            first.append(True)
            reached.set()
            await release.wait()
            return await original(session, user, *args, **kwargs)

        monkeypatch.setattr(auth_router, "_store_refresh_token", paused)
        a = asyncio.create_task(w.refresh(r0["refresh_token"]))
        await asyncio.wait_for(reached.wait(), 15)
        b = asyncio.create_task(w.refresh(r0["refresh_token"]))   # takes the lock shared, then waits on the token's row (A has not committed)
        await asyncio.sleep(0.5)                                  # B is past its lock and on the row before the logout asks for the lock
        out = asyncio.create_task(_logout(w, r0["refresh_token"]))
        assert await _wait_until_a_lock_is_waited_for(w), "the logout did not queue on the person's session lock"
        release.set()
        one, two, logged_out = await asyncio.wait_for(asyncio.gather(a, b, out), 60)
        assert one.status_code == 200 and logged_out.status_code == 200, f"{one.status_code} {logged_out.status_code}"
        assert two.status_code in (200, 401), two.text
        assert await _live_except(w, None) == 0, "the logout that waited left a token of the rotated session alive (the fork of the race loser)"
    finally:
        await _close(engine, w)


async def test_a_session_that_old_and_new_pods_rotated_in_turn_ends_as_one_the_family_starts_in_the_middle_of_the_chain():
    """old pods write no family: R0 -> R1 were made with none (NULL), then a new pod rotates R1 twice with the same cookie (a race): R1 starts the family, the winner and the fork join it, and R0 — the prefix — has none.
    A logout with the prefix's cookie walks to R1 and the winner (linked) and must end the fork too: the families of the whole lineage are ended, not only the presented token's."""
    import asyncio

    engine, w = await _world()
    try:
        r0 = await w.login()
        r1 = (await w.refresh(r0["refresh_token"])).json()["data"]
        await _exec(w, "UPDATE refresh_tokens SET family_id = NULL WHERE user_id = :u", u=w.user_id)  # what old pods leave behind
        one, two = await asyncio.gather(w.refresh(r1["refresh_token"]), w.refresh(r1["refresh_token"]))
        assert one.status_code == 200 and two.status_code == 200
        assert (await _logout(w, r0["refresh_token"])).status_code == 200
        assert await _live_except(w, None) == 0, "the logout with the prefix's cookie left the fork of the new pods' rotation alive"
        for response in (one, two):
            assert (await w.refresh(response.json()["data"]["refresh_token"])).status_code == 401
    finally:
        await _close(engine, w)


async def test_a_logout_with_the_forks_cookie_closes_the_window_of_a_prefix_that_old_pods_made_without_a_family():
    """codex 4782 (third PR) round 2: R0 -> R1 made by old pods (no family), a new pod races two refreshes of R1 (R1 starts the family, winner and fork join it). A logout with the FORK's cookie ends the family —
    and R0, the NULL prefix that is not in it, was rotated a moment ago: its grace window is still open, and a refresh with it would mint a new pair of the session that was just logged out. The family's first
    token is the point the backward close starts from."""
    import asyncio

    engine, w = await _world()
    try:
        r0 = await w.login()
        r1 = (await w.refresh(r0["refresh_token"])).json()["data"]
        await _exec(w, "UPDATE refresh_tokens SET family_id = NULL WHERE user_id = :u", u=w.user_id)
        one, two = await asyncio.gather(w.refresh(r1["refresh_token"]), w.refresh(r1["refresh_token"]))
        assert one.status_code == 200 and two.status_code == 200
        r1_row = await _family(w, r1["refresh_token"])
        winner_id = await _fork_target(w, r1["refresh_token"])   # the token R1 points at — the race winner's
        fork = two if (await _family(w, one.json()["data"]["refresh_token"])).id == winner_id else one
        assert (await _logout(w, fork.json()["data"]["refresh_token"])).status_code == 200
        assert (await w.refresh(r0["refresh_token"])).status_code == 401, "the NULL prefix still forked a new pair inside its grace window after the logout"
        assert (await w.refresh(r1["refresh_token"])).status_code == 401
        assert await _live_except(w, None) == 0
        assert r1_row.family_id == r1_row.id
    finally:
        await _close(engine, w)


async def _fork_target(w, raw_refresh: str):
    """the id of the token `raw_refresh` points at through `replaced_by` — the race winner's"""
    from sqlalchemy import select

    from app.core.security import hash_token
    from app.models.user import RefreshToken

    async with w.Session() as s:
        return (await s.execute(select(RefreshToken.replaced_by).where(RefreshToken.token_hash == hash_token(raw_refresh)))).scalar_one()


async def test_a_stale_token_of_a_legacy_lineage_rotated_after_a_later_one_joins_that_family_not_a_second_one():
    """codex 4782 (third PR) round 3: R0 -> R1 made by old pods (no family). A new pod rotates R1 (R1 starts the family, R2 joins), then a refresh crosses with the STALE R0 inside its grace window and forks R3. R3 must
    be in the family R1 started — with the old rule (a legacy parent names ITSELF) R0 started a second family and a logout of the session left R3 alive."""
    engine, w = await _world()
    try:
        r0 = await w.login()
        r1 = (await w.refresh(r0["refresh_token"])).json()["data"]
        await _exec(w, "UPDATE refresh_tokens SET family_id = NULL WHERE user_id = :u", u=w.user_id)
        r2 = (await w.refresh(r1["refresh_token"])).json()["data"]
        stale = await w.refresh(r0["refresh_token"])
        assert stale.status_code == 200, "the stale token inside its grace window forks (the §2449 straggler)"
        r3 = stale.json()["data"]
        assert (await _family(w, r3["refresh_token"])).family_id == (await _family(w, r2["refresh_token"])).family_id, "the fork of the stale token started a second family"
        assert (await _logout(w, r2["refresh_token"])).status_code == 200
        assert await _live_except(w, None) == 0, "the logout of the session left the fork of its stale legacy token alive"
        assert (await w.refresh(r3["refresh_token"])).status_code == 401
    finally:
        await _close(engine, w)


async def test_a_stale_token_rotated_before_the_tip_of_a_legacy_lineage_gets_the_family_the_tip_takes():
    """the other order: legacy R0 -> R1 -> R2 (R2 live, no family). The stale R0 forks R3 FIRST, then R2 is rotated (R4). Both must end up in one family — R0 names the END of its chain (R2) and R2 names itself."""
    engine, w = await _world()
    try:
        r0 = await w.login()
        r1 = (await w.refresh(r0["refresh_token"])).json()["data"]
        r2 = (await w.refresh(r1["refresh_token"])).json()["data"]
        await _exec(w, "UPDATE refresh_tokens SET family_id = NULL WHERE user_id = :u", u=w.user_id)
        stale = await w.refresh(r0["refresh_token"])
        assert stale.status_code == 200
        r3 = stale.json()["data"]
        r4 = (await w.refresh(r2["refresh_token"])).json()["data"]
        assert (await _family(w, r3["refresh_token"])).family_id == (await _family(w, r4["refresh_token"])).family_id, "the stale fork and the tip's successor are two families"
        assert (await _logout(w, r4["refresh_token"])).status_code == 200
        assert await _live_except(w, None) == 0
    finally:
        await _close(engine, w)


async def test_a_stale_token_rotated_before_the_tip_leaves_no_live_tip_outside_the_family():
    """codex 4782 (third PR) round 4: legacy R0 -> R1 -> R2 (R2 live, no family). The stale R0 forks R3 and the tip R2 has NOT been rotated: the family the fork takes (the id of the chain's end, R2) must be
    given to R2 too — a logout with the FORK's cookie ends the family and R2, the session's live token, is in it."""
    engine, w = await _world()
    try:
        r0 = await w.login()
        r1 = (await w.refresh(r0["refresh_token"])).json()["data"]
        r2 = (await w.refresh(r1["refresh_token"])).json()["data"]
        await _exec(w, "UPDATE refresh_tokens SET family_id = NULL WHERE user_id = :u", u=w.user_id)
        stale = await w.refresh(r0["refresh_token"])
        assert stale.status_code == 200
        fork = stale.json()["data"]
        assert (await _logout(w, fork["refresh_token"])).status_code == 200
        assert await _live_except(w, None) == 0, "the live tip of the legacy lineage stayed outside the family the fork was given"
        assert (await w.refresh(r2["refresh_token"])).status_code == 401
    finally:
        await _close(engine, w)


async def test_a_legacy_lineage_longer_than_any_cap_is_still_one_family():
    """codex 4782 (third PR) round 4: no hop cap may split one legacy lineage into two families. 260 rotations in a row (old rows, no family) and the stale first token forks inside its grace window: the fork and
    the tip are one family, and the logout of either ends both."""
    engine, w = await _world()
    try:
        first = await w.login()
        tip = first
        for _ in range(260):
            response = await w.refresh(tip["refresh_token"])
            assert response.status_code == 200, response.text
            tip = response.json()["data"]
        await _exec(w, "UPDATE refresh_tokens SET family_id = NULL WHERE user_id = :u", u=w.user_id)
        stale = await w.refresh(first["refresh_token"])
        assert stale.status_code == 200, "the first token is inside its grace window (it was rotated seconds ago)"
        fork = stale.json()["data"]
        assert (await _family(w, fork["refresh_token"])).family_id == (await _family(w, tip["refresh_token"])).family_id, "a lineage past 256 hops was split into two families"
        assert (await _logout(w, fork["refresh_token"])).status_code == 200
        assert await _live_except(w, None) == 0
    finally:
        await _close(engine, w)


async def test_two_stale_tokens_of_one_legacy_lineage_rotated_one_after_the_other_land_in_one_family():
    """the family a stale token joins is the one a row AHEAD of it already carries, whatever that value is: legacy a -> b -> c -> d (d live). The stale b forks first (b · c · d are given the id of the chain's end,
    d), then the older stale a forks: a looks ahead, meets b with its family and takes THAT one — not the id of b."""
    engine, w = await _world()
    try:
        a = await w.login()
        b = (await w.refresh(a["refresh_token"])).json()["data"]
        c = (await w.refresh(b["refresh_token"])).json()["data"]
        d = (await w.refresh(c["refresh_token"])).json()["data"]
        await _exec(w, "UPDATE refresh_tokens SET family_id = NULL WHERE user_id = :u", u=w.user_id)
        fork_b = await w.refresh(b["refresh_token"])
        fork_a = await w.refresh(a["refresh_token"])
        assert fork_b.status_code == 200 and fork_a.status_code == 200, f"{fork_b.status_code} {fork_a.status_code}"
        families = {(await _family(w, x["refresh_token"])).family_id for x in (d, fork_b.json()["data"], fork_a.json()["data"])}
        assert len(families) == 1, "two stale tokens of one lineage started two families"
        assert (await _logout(w, fork_a.json()["data"]["refresh_token"])).status_code == 200
        assert await _live_except(w, None) == 0
    finally:
        await _close(engine, w)


def _chain_sql(w, n: int, *, loop: bool = False) -> tuple[str, dict]:
    """INSERT of `n` family-less rows of one person that form one chain by `replaced_by` (1 -> 2 -> … -> n; `loop`: n points back at 1). The ids are built from the person's id and the row number, so they
    are the same for every test run and unique per person: `_chain_id`."""
    p = w.user_id.hex
    parts = {"p1": p[:8], "p2": p[8:12], "p3": p[12:16], "p4": p[16:20]}
    ident = "(:p1 || '-' || :p2 || '-' || :p3 || '-' || :p4 || '-' || lpad({}::text, 12, '0'))::uuid"
    nxt = f"CASE WHEN g < :n THEN {ident.format('(g + 1)')} ELSE {ident.format('1') if loop else 'NULL::uuid'} END"
    sql = (
        "INSERT INTO refresh_tokens (id, user_id, token_hash, expires_at, revoked_at, replaced_by) "
        f"SELECT {ident.format('g')}, :u, 'bulk-4782-' || :p1 || '-' || g, now() + interval '1 day', now(), {nxt} FROM generate_series(1, :n) AS g"
    )
    return sql, {**parts, "u": w.user_id, "n": n}


def _chain_id(w, g: int):
    import uuid

    p = w.user_id.hex
    return uuid.UUID(f"{p[:8]}-{p[8:12]}-{p[12:16]}-{p[16:20]}-{g:012d}")


@pytest.mark.timeout(120)  # building and walking 33 000 rows takes ~2 s; the headroom is for a busy machine, not for the work
async def test_a_legacy_chain_of_tens_of_thousands_of_rows_is_adopted_by_the_database_not_through_a_bind_list():
    """codex 4782 (third PR) round 5: the adoption read the whole stretch into the application and stamped it with `id IN (…)` — a chain somebody made long on purpose (rotations are free) would pass the
    bind-parameter limit of the driver (32 767) and fail the refresh with a 500. One recursive statement picks the family and one more stamps the stretch; no row is carried into the application."""
    from sqlalchemy import text

    from app.routers.auth import _adopt_legacy_family

    engine, w = await _world()
    try:
        n = 33_000  # past the driver's 32 767 bind parameters
        sql, params = _chain_sql(w, n)
        await _exec(w, sql, **params)
        async with w.Session() as s:
            family = await _adopt_legacy_family(s, w.user_id, _chain_id(w, 1))
            await s.commit()
        assert family == _chain_id(w, n), "no family on the way: the id of the END of the chain"
        stamped = (await _fetch(w, "SELECT count(*) FROM refresh_tokens WHERE user_id = :u AND family_id = :f", u=w.user_id, f=family))[0][0]
        assert stamped == n, f"{stamped} of {n} rows of the stretch were given the family"
    finally:
        # the rows are NOT deleted: `refresh_tokens.replaced_by` is a self-referencing foreign key (ON DELETE SET NULL) with no index, so deleting n rows scans the table n times — 33 000 rows took minutes
        # on a table with other tests' rows (CI: the 240 s timeout hit in this very `finally`). They belong to a throw-away person and a database that is dropped after the run.
        await _close(engine, w)


async def test_a_corrupted_loop_of_legacy_rows_gets_one_family_whichever_row_the_adopters_meet_it_at():
    """codex 4782 (third PR) round 5: a loop (nothing in the app writes one) has no end; two concurrent adopters meeting it at different rows used to name different families. The fallback is the smallest id of
    the stretch: the same value from every row of the loop."""
    from app.routers.auth import _adopt_legacy_family

    engine, w = await _world()
    try:
        sql, params = _chain_sql(w, 3, loop=True)
        await _exec(w, sql, **params)
        seen = set()
        for g in (1, 2, 3):
            await _exec(w, "UPDATE refresh_tokens SET family_id = NULL WHERE user_id = :u", u=w.user_id)
            async with w.Session() as s:
                seen.add(await _adopt_legacy_family(s, w.user_id, _chain_id(w, g)))
                await s.commit()
        assert seen == {_chain_id(w, 1)}, seen
    finally:
        await _exec(w, "DELETE FROM refresh_tokens WHERE user_id = :u AND token_hash LIKE 'bulk-4782-%'", u=w.user_id)  # this test's own three rows — never a pattern over the table
        await _close(engine, w)
