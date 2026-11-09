"""story #4879 - count a test's OWN idle-in-transaction connections, not the whole (shared) database's.

Why: the non-destructive CI shards share one database. A test that counts every `idle in transaction` backend of the database while the code under test waits
(`WHERE datname = current_database() AND state LIKE 'idle in transaction%'`) also counts whatever else holds a transaction at that instant - a neighbour test's leftover
background task, another worker's connection. The code is fine, the count is 1: CI run 42639791595 (shard 5) failed `test_grace_cron_holds_no_open_transaction_during_blob_delete`
that way, and the same shape sat in test_4404 / test_4402 / test_4405_retro.

Two ways to say "mine" (both = a unique `application_name`, the idiom of test_4395 / test_4228):
  * `tagged_engine(url, tag)` - the test creates the engine whose connections it counts (the code under test is handed a session of it);
  * `tag_every_checkout(tag)` - the code under test runs on engines the test did not create (the app's global engine, an engine made by another test module's helper):
    for the duration of the block every connection checked out of ANY engine of this process carries the tag, including engines created before the block.
    Connections of other processes (the neighbours) are not touched, which is the point. A pooled connection keeps the tag after the block until its next checkout, so a test that
    uses it ends with `await dispose_app_engines()` (the app's pools are emptied; helper-made engines are the test's own to dispose).
A neighbour that must NOT carry the tag is opened with `neighbour_transaction` (raw asyncpg - it does not go through SQLAlchemy's pool events).

Every test that uses this reads, in ONE statement (`idle_in_tx_snapshot`, so the three numbers are one snapshot), its own count, the neighbour's count and the database-wide count at the
moment it matters, and asserts: the fixture's neighbour is idle in its transaction (== 1: the noisy condition is on purpose and really there - not "some" idle connection), its own count is
what the test is about. Each test also has a positive control (the tag really attaches: a transaction its own side holds open reads as 1), so a probe that always reads 0 cannot pass.
"""
from __future__ import annotations

import contextlib
import uuid
from collections.abc import AsyncIterator, Iterator

from sqlalchemy import event, text
from sqlalchemy.engine import Engine
from sqlalchemy.ext.asyncio import AsyncEngine, async_sessionmaker, create_async_engine
from sqlalchemy.util import await_only

_APP_NAME_MAX_BYTES = 63  # NAMEDATALEN - 1: Postgres cuts a longer application_name silently
NEIGHBOUR_SUFFIX = "-neighbour"


def unique_tag(prefix: str) -> str:
    tag = f"{prefix}-{uuid.uuid4().hex[:12]}"
    assert len(tag.encode("utf-8")) + len(NEIGHBOUR_SUFFIX) <= _APP_NAME_MAX_BYTES, tag  # the neighbour's name is the tag + a suffix
    return tag


def async_url(raw_url: str) -> str:
    for prefix in ("postgresql+psycopg2://", "postgresql+asyncpg://", "postgresql://"):
        if raw_url.startswith(prefix):
            return "postgresql+asyncpg://" + raw_url[len(prefix):]
    return raw_url


def tagged_engine(url: str, app_name: str, **kwargs) -> AsyncEngine:
    """An engine whose every connection carries `application_name = app_name`."""
    return create_async_engine(async_url(url), connect_args={"server_settings": {"application_name": app_name}}, **kwargs)


def _app_engines() -> list:
    """The app's distinct global engines (write, read, worker); [] when the app is not importable (the helper is then used for class-level tagging only)."""
    try:
        from app.core import database as db
    except Exception:  # noqa: BLE001
        return []
    seen: dict[int, object] = {}
    for name in ("engine", "read_engine", "worker_engine"):
        eng = getattr(db, name, None)
        if eng is not None:
            seen[id(eng)] = eng
    return list(seen.values())


async def dispose_app_engines() -> None:
    """Empty the app's pools (write, read, worker): the pooled connections still carry the last test's tag."""
    for eng in _app_engines():
        await eng.dispose()


@contextlib.contextmanager
def tag_every_checkout(app_name: str) -> Iterator[str]:
    """Every asyncpg connection checked out of any engine of this process, while the block runs, gets `application_name = app_name` (one server-side set_config at checkout)."""

    def _tag(dbapi_connection, _record, _proxy):
        driver = getattr(dbapi_connection, "driver_connection", None)
        if driver is None:  # a sync driver's connection: not ours to tag
            return
        await_only(driver.execute("SELECT set_config('application_name', $1, false)", app_name))

    # Class level: every engine of the process, including those created before this block. Instance level on the app's global engines as well: SQLAlchemy runs class-level
    # listeners FIRST and an engine's own listeners after, and the destructive tests' conftest names the global engines' connections `ge|<test>|...` with its own listener -
    # registered on the instance (tests/conftest.py _install_global_engine_checkout_tag). Registered after that one, ours runs last and its name is the one that stays.
    registered: list = []
    try:
        event.listen(Engine, "checkout", _tag)
        registered.append(Engine)
        for eng in _app_engines():
            event.listen(eng.sync_engine, "checkout", _tag)
            registered.append(eng.sync_engine)
        yield app_name
    finally:  # whatever was registered before a failure is removed again
        for target in reversed(registered):
            event.remove(target, "checkout", _tag)


@contextlib.asynccontextmanager
async def neighbour_transaction(url: str, app_name: str) -> AsyncIterator[None]:
    """A connection under ANOTHER application_name that opens a transaction and stays idle in it while the block runs - what a neighbour test's leftover would be."""
    import asyncpg

    conn = await asyncpg.connect(async_url(url).replace("postgresql+asyncpg://", "postgresql://", 1), server_settings={"application_name": app_name})
    try:
        tr = conn.transaction()
        await tr.start()
        await conn.execute("select 1")
        yield
    finally:
        await conn.close()  # closing the session ends its transaction (the server rolls it back)


_IDLE_IN_TX = "datname = current_database() AND pid <> pg_backend_pid() AND state LIKE 'idle in transaction%'"


async def idle_in_tx_snapshot(Session: async_sessionmaker, own_tag: str) -> tuple[int, int, int]:
    """(own, neighbour, everyone) idle-in-transaction backends of this database in ONE statement - one snapshot, the probing connection itself left out.
    `own` = application_name == own_tag, `neighbour` = own_tag + '-neighbour' (the fixture's), `everyone` = the whole database."""
    async with Session() as probe:
        row = (await probe.execute(text(
            "SELECT count(*) FILTER (WHERE application_name = :own), count(*) FILTER (WHERE application_name = :nb), count(*) "
            f"FROM pg_stat_activity WHERE {_IDLE_IN_TX}"
        ), {"own": own_tag, "nb": own_tag + NEIGHBOUR_SUFFIX})).one()
        await probe.rollback()
    return int(row[0]), int(row[1]), int(row[2])


async def idle_in_tx_count(Session: async_sessionmaker, app_name: "str | None" = None) -> int:
    """idle-in-transaction backends of this database, the probing connection itself left out; with `app_name` only those of that application_name."""
    sql = f"SELECT count(*) FROM pg_stat_activity WHERE {_IDLE_IN_TX}"
    params: dict = {}
    if app_name is not None:
        sql += " AND application_name = :app"
        params = {"app": app_name}
    async with Session() as probe:
        n = (await probe.execute(text(sql), params)).scalar_one()
        await probe.rollback()
    return n
