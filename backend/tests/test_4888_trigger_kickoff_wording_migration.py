"""story #4888 — migration 0473 corrects the description of the SYSTEM workflow trigger «kickoff» («에픽» → «목표») and nothing else.

Real database: a fresh database is built to 0472, rows are laid down the way an organization that already has its seed rows looks (the seed inserts with `ON CONFLICT DO NOTHING`,
so they keep the old text), then `alembic upgrade 0473` / `downgrade 0472`:

- a system row with exactly the old seed text → corrected (and back on downgrade);
- a system row whose description a person edited → untouched both ways;
- a custom (non-system) row that carries the very same old words → untouched both ways;
- the stored key `slug` never moves, the number of rows never changes.

Reverted (no 0473 — or an `UPDATE` without `is_system` / the exact-text condition) this test fails on the row it names.
"""
from __future__ import annotations

import uuid

import pytest

from tests.test_4873_migration_lock_timeout import (
    _REAL_DB_URL,
    _admin_and_dsn,
    _alembic,
    _may_create_databases,
    _revision,
)

OLD = "스프린트 또는 에픽 킥오프"
NEW = "스프린트 또는 목표 킥오프"
EDITED = "우리 팀 킥오프(에픽 포함) — 사람이 고친 글"


@pytest.mark.timeout(900)
@pytest.mark.skipif(not _REAL_DB_URL, reason="real Postgres 필요")
def test_the_migration_corrects_only_system_rows_with_exactly_the_old_seed_text_and_goes_back():
    import psycopg2

    if not _may_create_databases():
        pytest.skip("the test role may not create databases")

    name = f"t4888_{uuid.uuid4().hex[:10]}"
    admin_url, fresh_url = _admin_and_dsn(name)
    admin_dsn = admin_url.render_as_string(hide_password=False)
    fresh_dsn = fresh_url.set(drivername="postgresql").render_as_string(hide_password=False)
    sqlalchemy_url = fresh_url.render_as_string(hide_password=False)

    admin = psycopg2.connect(admin_dsn, connect_timeout=15)
    admin.autocommit = True
    try:
        with admin.cursor() as cur:
            cur.execute(f'CREATE DATABASE "{name}"')

        built = _alembic(sqlalchemy_url, "upgrade", "0472", timeout=600)
        assert built.returncode == 0, (built.stdout + built.stderr)[-1500:]
        assert _revision(fresh_dsn) == "0472"

        org = uuid.uuid4()
        ids = {k: uuid.uuid4() for k in ("system_old", "system_edited", "custom_old", "system_other")}
        conn = psycopg2.connect(fresh_dsn, connect_timeout=15)
        try:
            with conn, conn.cursor() as cur:
                cur.execute("INSERT INTO organizations (id, name, slug) VALUES (%s, %s, %s)", (str(org), "t4888", f"t4888-{uuid.uuid4().hex[:8]}"))
                rows = [
                    (ids["system_old"], "kickoff", "Kickoff", OLD, True),
                    (ids["system_edited"], "kickoff_edited", "Kickoff 2", EDITED, True),
                    (ids["custom_old"], "my_kickoff", "My Kickoff", OLD, False),
                    (ids["system_other"], "review_request", "Review Request", "코드 리뷰 요청", True),
                ]
                for rid, slug, label, desc, system in rows:
                    cur.execute(
                        "INSERT INTO workflow_trigger_types (id, org_id, slug, label, description, is_system) VALUES (%s, %s, %s, %s, %s, %s)",
                        (str(rid), str(org), slug, label, desc, system),
                    )

            def read():
                c = psycopg2.connect(fresh_dsn, connect_timeout=15)
                try:
                    with c.cursor() as cur:
                        cur.execute("SELECT id::text, slug, description FROM workflow_trigger_types ORDER BY slug")
                        return {r[0]: (r[1], r[2]) for r in cur.fetchall()}
                finally:
                    c.close()

            before = read()
            up = _alembic(sqlalchemy_url, "upgrade", "0473", timeout=120)
            assert up.returncode == 0, (up.stdout + up.stderr)[-1500:]
            assert _revision(fresh_dsn) == "0473"
            after = read()
            assert after[str(ids["system_old"])] == ("kickoff", NEW), "the system row with exactly the old seed text is corrected"
            assert after[str(ids["system_edited"])] == ("kickoff_edited", EDITED), "a description a person edited is never touched"
            assert after[str(ids["custom_old"])] == ("my_kickoff", OLD), "a custom (non-system) row with the same words is never touched"
            assert after[str(ids["system_other"])] == ("review_request", "코드 리뷰 요청")
            assert len(after) == len(before) == 4 and {v[0] for v in after.values()} == {v[0] for v in before.values()}, "no row added, no slug moved"

            down = _alembic(sqlalchemy_url, "downgrade", "0472", timeout=120)
            assert down.returncode == 0, (down.stdout + down.stderr)[-1500:]
            assert _revision(fresh_dsn) == "0472"
            assert read() == before, "the downgrade gives back exactly what was there before"
        finally:
            conn.close()
    finally:
        with admin.cursor() as cur:
            cur.execute("SELECT pg_terminate_backend(pid) FROM pg_stat_activity WHERE datname = %s AND pid <> pg_backend_pid()", (name,))
            cur.execute(f'DROP DATABASE IF EXISTS "{name}"')
        admin.close()


@pytest.mark.timeout(900)
@pytest.mark.skipif(not _REAL_DB_URL, reason="real Postgres 필요")
def test_list_repairs_a_row_the_old_release_seeded_in_the_deploy_window_without_overwriting_a_concurrent_edit():
    """The migration runs BEFORE the old backend is swapped out, so the old release can still seed a new organization with the old text in that window. `list()` repairs it with ONE
    conditional UPDATE (system row · description exactly the old text). Here a person edits row A between `list()`'s read and its UPDATE (the race): A stays as the person left it
    (the old ORM «set attribute + flush» wrote by primary key and overwrote it), row B is repaired, a person-edited row and a custom row with the old words are never touched."""
    import asyncio

    import psycopg2
    from sqlalchemy.ext.asyncio import AsyncSession, create_async_engine

    from app.repositories.workflow_trigger_type import WorkflowTriggerTypeRepository

    if not _may_create_databases():
        pytest.skip("the test role may not create databases")

    name = f"t4888r_{uuid.uuid4().hex[:9]}"
    admin_url, fresh_url = _admin_and_dsn(name)
    admin = psycopg2.connect(admin_url.render_as_string(hide_password=False), connect_timeout=15)
    admin.autocommit = True
    fresh_dsn = fresh_url.set(drivername="postgresql").render_as_string(hide_password=False)
    async_url = fresh_url.set(drivername="postgresql+asyncpg").render_as_string(hide_password=False)
    try:
        with admin.cursor() as cur:
            cur.execute(f'CREATE DATABASE "{name}"')
        built = _alembic(fresh_url.render_as_string(hide_password=False), "upgrade", "0473", timeout=600)
        assert built.returncode == 0, (built.stdout + built.stderr)[-1500:]

        org = uuid.uuid4()
        a, b, edited, custom = (uuid.uuid4() for _ in range(4))
        conn = psycopg2.connect(fresh_dsn, connect_timeout=15)
        try:
            with conn, conn.cursor() as cur:
                cur.execute("INSERT INTO organizations (id, name, slug) VALUES (%s, %s, %s)", (str(org), "t4888r", f"t4888r-{uuid.uuid4().hex[:8]}"))
                for rid, slug, desc, system in (
                    (a, "kickoff", OLD, True), (b, "kickoff_b", OLD, True), (edited, "kickoff_c", EDITED, True), (custom, "mine", OLD, False),
                ):
                    cur.execute(
                        "INSERT INTO workflow_trigger_types (id, org_id, slug, label, description, is_system) VALUES (%s, %s, %s, %s, %s, %s)",
                        (str(rid), str(org), slug, slug, desc, system),
                    )
        finally:
            conn.close()

        person = "사람이 방금 고친 글"

        def person_edits_a():
            c = psycopg2.connect(fresh_dsn, connect_timeout=15)
            try:
                with c, c.cursor() as cur:
                    cur.execute("UPDATE workflow_trigger_types SET description = %s WHERE id = %s", (person, str(a)))
            finally:
                c.close()

        async def run():
            engine = create_async_engine(async_url)
            try:
                async with AsyncSession(engine) as session:
                    original = session.execute
                    state = {"raced": False}

                    async def racing(stmt, *args, **kwargs):
                        if getattr(stmt, "is_update", False) and not state["raced"]:
                            state["raced"] = True
                            await asyncio.get_running_loop().run_in_executor(None, person_edits_a)   # the person's edit lands between the read and the UPDATE
                        return await original(stmt, *args, **kwargs)

                    session.execute = racing
                    items = await WorkflowTriggerTypeRepository(session, org).list()
                    seen = {i.id: i.description for i in items}   # read before the commit expires the objects
                    await session.commit()
                    assert state["raced"], "the repair did not run an UPDATE"
                    return seen
            finally:
                await engine.dispose()

        returned = asyncio.run(run())

        c = psycopg2.connect(fresh_dsn, connect_timeout=15)
        try:
            with c.cursor() as cur:
                cur.execute("SELECT id::text, description FROM workflow_trigger_types WHERE org_id = %s", (str(org),))
                db = dict(cur.fetchall())
        finally:
            c.close()
        assert db[str(a)] == person, "the person's concurrent edit was overwritten by the repair"
        assert db[str(b)] == NEW, "the stuck row was not repaired"
        assert db[str(edited)] == EDITED and db[str(custom)] == OLD
        assert returned[a] == person and returned[b] == NEW, "list() returns the rows as the database has them"
    finally:
        with admin.cursor() as cur:
            cur.execute("SELECT pg_terminate_backend(pid) FROM pg_stat_activity WHERE datname = %s AND pid <> pg_backend_pid()", (name,))
            cur.execute(f'DROP DATABASE IF EXISTS "{name}"')
        admin.close()
