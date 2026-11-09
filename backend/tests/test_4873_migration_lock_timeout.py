"""story #4873 — a migration FAILS FAST on a lock it cannot get.

A transaction left open on `events` (prod's idle-in-transaction connections) made an `ALTER TABLE events` queue behind it, and every chat delivery behind the ALTER. The migration connection now
carries a `lock_timeout` (`ALEMBIC_LOCK_TIMEOUT_MS`, 10 s by default); the deployer runs the migration BEFORE the swap and stops there on a failure (`deploy/vm/bin/deployer.py`), so the old
release keeps serving and the next deploy tries again.

The real-database test is the story's: a fresh database at 0470, another connection holding a lock on `events` the way an open transaction does, `alembic upgrade 0471` (it alters `events`).
With the fix the migration ends with Postgres' «canceling statement due to lock timeout» and the revision stays 0470; once the holder lets go the same migration runs to the end.
Without the fix it WAITS — the test's watchdog (`subprocess` timeout) turns that into a failure.
"""
from __future__ import annotations

import os
import subprocess
import sys
import uuid
from pathlib import Path

import pytest

from app.core.migration_lock_timeout import DEFAULT_LOCK_TIMEOUT_MS, ENV_NAME, migration_lock_timeout_ms

BACKEND = Path(__file__).resolve().parents[1]
_REAL_DB_URL = os.getenv("PARITY_TEST_DATABASE_URL") or os.getenv("ALEMBIC_DATABASE_URL")


# ─── the setting ─────────────────────────────────────────────────────────────────────────────────────────────────

def test_the_default_is_ten_seconds():
    assert DEFAULT_LOCK_TIMEOUT_MS == 10_000
    assert migration_lock_timeout_ms({}) == 10_000
    assert migration_lock_timeout_ms({ENV_NAME: ""}) == 10_000
    assert migration_lock_timeout_ms({ENV_NAME: "  "}) == 10_000


def test_the_environment_changes_it_and_zero_means_no_limit():
    assert migration_lock_timeout_ms({ENV_NAME: "2500"}) == 2500
    assert migration_lock_timeout_ms({ENV_NAME: " 750 "}) == 750
    assert migration_lock_timeout_ms({ENV_NAME: "0"}) == 0


@pytest.mark.parametrize("raw", ["ten", "1.5", "-1", "10s"])
def test_a_value_that_is_not_a_whole_non_negative_number_of_milliseconds_is_refused(raw):
    with pytest.raises(RuntimeError, match=ENV_NAME):
        migration_lock_timeout_ms({ENV_NAME: raw})


# ─── the migration itself ────────────────────────────────────────────────────────────────────────────────────────

def _admin_and_dsn(db_name: str):
    from sqlalchemy.engine import make_url

    url = make_url(_REAL_DB_URL.replace("postgresql+asyncpg://", "postgresql+psycopg2://"))
    admin = url.set(drivername="postgresql", database=url.database)
    fresh = url.set(drivername="postgresql+psycopg2", database=db_name)
    return admin, fresh


def _alembic(sqlalchemy_url: str, *args: str, lock_timeout_ms: str | None = None, timeout: int) -> subprocess.CompletedProcess:
    env = {**os.environ, "ALEMBIC_DATABASE_URL": sqlalchemy_url, "PYTHONPATH": str(BACKEND)}
    env.pop(ENV_NAME, None)
    if lock_timeout_ms is not None:
        env[ENV_NAME] = lock_timeout_ms
    return subprocess.run([sys.executable, "-m", "alembic", *args], cwd=BACKEND, env=env, capture_output=True, text=True, timeout=timeout)


def _revision(dsn: str) -> str | None:
    import psycopg2

    conn = psycopg2.connect(dsn)
    try:
        with conn.cursor() as cur:
            cur.execute("SELECT version_num FROM alembic_version")
            row = cur.fetchone()
            return row[0] if row else None
    finally:
        conn.close()


@pytest.mark.timeout(600)   # the repo's 30 s default is for in-process tests: this one builds a database through hundreds of migrations in a subprocess (its own watchdog below judges the wait)
@pytest.mark.skipif(not _REAL_DB_URL, reason="real Postgres 필요")
def test_a_migration_fails_fast_when_another_connection_holds_the_table_and_runs_once_it_lets_go():
    import psycopg2

    name = f"t4873_{uuid.uuid4().hex[:10]}"
    admin_url, fresh_url = _admin_and_dsn(name)
    admin_dsn = admin_url.render_as_string(hide_password=False)
    fresh_dsn = fresh_url.set(drivername="postgresql").render_as_string(hide_password=False)

    admin = psycopg2.connect(admin_dsn)
    admin.autocommit = True
    holder = None
    try:
        with admin.cursor() as cur:
            cur.execute(f'CREATE DATABASE "{name}"')
        sqlalchemy_url = fresh_url.render_as_string(hide_password=False)

        built = _alembic(sqlalchemy_url, "upgrade", "0470", timeout=900)
        assert built.returncode == 0, (built.stdout + built.stderr)[-1500:]
        assert _revision(fresh_dsn) == "0470"

        # another connection that has READ `events` inside a transaction it never ends — the lock an `ALTER TABLE events` has to wait for
        holder = psycopg2.connect(fresh_dsn)
        with holder.cursor() as cur:
            cur.execute("BEGIN")
            cur.execute("LOCK TABLE events IN ACCESS SHARE MODE")

        try:
            blocked = _alembic(sqlalchemy_url, "upgrade", "0471", lock_timeout_ms="1000", timeout=60)   # the watchdog: without the fix the migration waits for ever
        except subprocess.TimeoutExpired:
            pytest.fail("the migration WAITED for the lock instead of failing fast (no lock_timeout on the migration connection)")
        assert blocked.returncode != 0
        assert "lock timeout" in (blocked.stdout + blocked.stderr).lower(), (blocked.stdout + blocked.stderr)[-1500:]
        assert _revision(fresh_dsn) == "0470"                                                   # nothing of 0471 was kept

        holder.rollback()
        holder.close()
        holder = None
        done = _alembic(sqlalchemy_url, "upgrade", "0471", timeout=300)                         # the default limit, nobody holds the table now
        assert done.returncode == 0, (done.stdout + done.stderr)[-1500:]
        assert _revision(fresh_dsn) == "0471"
    finally:
        if holder is not None:
            holder.close()
        with admin.cursor() as cur:
            try:
                cur.execute(f'DROP DATABASE IF EXISTS "{name}" WITH (FORCE)')
            except psycopg2.Error:
                cur.execute(f'DROP DATABASE IF EXISTS "{name}"')
        admin.close()
