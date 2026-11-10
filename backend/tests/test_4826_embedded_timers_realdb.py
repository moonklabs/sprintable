"""story 4826 — the in-app timers on a real Postgres.

- the last run of a job is the database's own clock: written by `_write_last_run`, read back as «seconds ago» by `_seconds_since_last_run`, updated in place (one row per job)
- the refresh prerequisite is the real query: nothing due → skip; a connection that is due → run
- a call through the REAL app with the REAL cron guard and a real session: `hitl-timeouts` answers 200 for the bearer the timer sends
"""
from __future__ import annotations

import uuid
from contextlib import asynccontextmanager

import pytest
from sqlalchemy import text

from app.services import embedded_timers as et
from app.services.embedded_timers import TimerJob
from tests.test_4676_setup_key_one_receiver_realdb import _REAL_DB_URL

pytestmark = [
    pytest.mark.anyio,
    pytest.mark.skipif(not _REAL_DB_URL, reason="통합 테스트는 실 PG(PARITY/ALEMBIC_DATABASE_URL) 필요"),
]


@pytest.fixture
def anyio_backend():
    return "asyncio"


@asynccontextmanager
async def _job_rows(*suffixes: str):
    """fresh job names for one test and their rows removed at its end — IN the test's own loop (the conftest disposes the global engine there as the last step; a fixture
    would run in another loop and leave a pooled connection of it behind)"""
    base = f"t4826-{uuid.uuid4().hex[:10]}"
    names = [base + s for s in suffixes] or [base]
    try:
        yield names
    finally:
        from app.core.database import async_session_factory

        async with async_session_factory() as db:
            await db.execute(text("DELETE FROM embedded_timer_runs WHERE job_name = ANY(:n)"), {"n": names})
            await db.commit()


async def test_a_job_that_never_ran_has_no_last_run() -> None:
    async with _job_rows() as (name,):
        assert await et._seconds_since_last_run(name) is None


async def test_the_last_run_is_written_and_read_back_as_seconds_ago() -> None:
    async with _job_rows() as (name,):
        await et._write_last_run(name, 200, 12)
        since = await et._seconds_since_last_run(name)
        assert since is not None and 0.0 <= since < 30.0  # the database's own now()


async def test_the_last_run_is_one_row_per_job_updated_in_place() -> None:
    from app.core.database import async_session_factory

    async with _job_rows() as (name,):
        await et._write_last_run(name, 500, 7)
        await et._write_last_run(name, 200, 9)
        async with async_session_factory() as db:
            rows = (await db.execute(text("SELECT last_status, last_ms FROM embedded_timer_runs WHERE job_name = :n"), {"n": name})).all()
        assert [tuple(r) for r in rows] == [(200, 9)]


async def test_an_old_last_run_reads_as_long_ago() -> None:
    from app.core.database import async_session_factory

    async with _job_rows() as (name,):
        async with async_session_factory() as db:
            await db.execute(text("INSERT INTO embedded_timer_runs (job_name, last_run_at) VALUES (:n, now() - interval '3 hours')"), {"n": name})
            await db.commit()
        since = await et._seconds_since_last_run(name)
        assert since is not None and 3 * 3600 - 5 <= since <= 3 * 3600 + 60


async def test_writing_again_moves_the_last_run_to_now() -> None:
    """an old row (3 h ago) written again is «just now» — the time is the thing the catch-up reads"""
    from app.core.database import async_session_factory

    async with _job_rows() as (name,):
        async with async_session_factory() as db:
            await db.execute(text("INSERT INTO embedded_timer_runs (job_name, last_run_at) VALUES (:n, now() - interval '3 hours')"), {"n": name})
            await db.commit()
        await et._write_last_run(name, 200, 5)
        since = await et._seconds_since_last_run(name)
        assert since is not None and since < 30.0


async def test_a_lap_that_ran_leaves_its_last_run_and_a_skipped_one_does_not() -> None:
    async def ready(db):
        return None

    async def not_ready(db):
        return "not now"

    async def call(app, job):
        return 200

    async with _job_rows("-s", "-r") as (s_name, r_name):
        skipped = TimerJob(s_name, "GET", 60, precondition=not_ready)
        ran = TimerJob(r_name, "GET", 60, precondition=ready)
        assert await et._lap(object(), skipped, call=call) == "skipped"
        assert await et._lap(object(), ran, call=call) == "ran"
        assert await et._seconds_since_last_run(skipped.name) is None
        assert await et._seconds_since_last_run(ran.name) is not None


async def test_refresh_runs_when_a_connection_is_due_and_is_skipped_when_none_is() -> None:
    """the real query on the real table: a threads connection (auto-refreshable) whose token expires within the lead time is «due»; moved far out it is not (the shared test
    database may hold due connections of other tests — the skip is asserted against the query's own answer, the run against the row seeded here)"""
    import uuid
    from datetime import datetime, timedelta, timezone

    from app.core.database import async_session_factory
    from app.models.channel_connection import ChannelConnection
    from app.models.organization import Organization
    from app.services.channel_connection import list_connections_due_for_refresh

    org_id, conn_id = uuid.uuid4(), uuid.uuid4()
    try:
        async with async_session_factory() as db:
            db.add(Organization(id=org_id, name="t4826", slug=f"t4826-{uuid.uuid4().hex[:8]}"))
            await db.commit()
            db.add(ChannelConnection(
                id=conn_id, org_id=org_id, channel="threads", account_id=f"acct-{uuid.uuid4().hex[:8]}", status="active", credential_kind="oauth",
                refresh_mode="reissue_from_access_token", encrypted_access_token="not-decrypted-by-this-query",
                token_expires_at=datetime.now(timezone.utc) + timedelta(hours=1),
            ))
            await db.commit()
        async with async_session_factory() as db:
            assert await et._refresh_due(db) is None  # a connection is due → the lap runs
        async with async_session_factory() as db:
            await db.execute(text("UPDATE channel_connections SET token_expires_at = now() + interval '30 days' WHERE id = :i"), {"i": conn_id})
            await db.commit()
        async with async_session_factory() as db:
            due = await list_connections_due_for_refresh(db, now=datetime.now(timezone.utc))
            assert conn_id not in {r.id for r in due}
            why = await et._refresh_due(db)
        assert (why is None) == bool(due)  # none due (this connection no longer is) → skipped, with the reason
    finally:
        async with async_session_factory() as db:
            await db.execute(text("DELETE FROM channel_connections WHERE id = :i"), {"i": conn_id})
            await db.execute(text("DELETE FROM organizations WHERE id = :o"), {"o": org_id})
            await db.commit()


async def test_a_call_through_the_real_app_with_the_timers_bearer_is_answered(monkeypatch) -> None:
    from app.main import app
    from app.routers import cron

    monkeypatch.setattr(cron, "CRON_SECRET", "s3cret-4826-real-app")
    status = await et._call_cron(app, TimerJob("hitl-timeouts", "GET", 600))
    assert status == 200
    monkeypatch.setattr(cron, "CRON_SECRET", "another-secret-set-after")  # the app checks the module's secret at request time
    import httpx

    transport = httpx.ASGITransport(app=app, raise_app_exceptions=False)
    async with httpx.AsyncClient(transport=transport, base_url="http://127.0.0.1") as c:
        r = await c.get(et.CRON_PREFIX + "hitl-timeouts", headers={"Authorization": "Bearer s3cret-4826-real-app"})
    assert r.status_code == 401


async def test_a_whole_lap_through_the_real_app_leaves_its_last_run(monkeypatch) -> None:
    """`_lap` with the default call: the real app, the real guard, then the last-run row — the same path a timer lap takes (the route's own name is the job's, so the row is
    removed at the end, in this test's loop)"""
    from app.core.database import async_session_factory
    from app.main import app
    from app.routers import cron

    monkeypatch.setattr(cron, "CRON_SECRET", "s3cret-4826-lap")
    job = TimerJob("hitl-timeouts", "GET", 600)
    try:
        assert await et._lap(app, job) == "ran"
        since = await et._seconds_since_last_run("hitl-timeouts")
        assert since is not None and since < 60
        async with async_session_factory() as db:
            row = (await db.execute(text("SELECT last_status FROM embedded_timer_runs WHERE job_name = 'hitl-timeouts'"))).first()
        assert row is not None and row[0] == 200
    finally:
        async with async_session_factory() as db:
            await db.execute(text("DELETE FROM embedded_timer_runs WHERE job_name = 'hitl-timeouts'"))
            await db.commit()
