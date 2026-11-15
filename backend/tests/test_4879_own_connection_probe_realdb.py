"""story #4879 - tests of tests/own_connection_probe.py itself (real PG, no schema needed): the helper that lets a test count only ITS OWN idle-in-transaction connections
on a database it shares with other tests."""
from __future__ import annotations

import os

import pytest
from sqlalchemy import text
from sqlalchemy.ext.asyncio import async_sessionmaker, create_async_engine

_RAW = os.environ.get("ALEMBIC_DATABASE_URL") or os.environ.get("PARITY_TEST_DATABASE_URL") or os.environ.get("PARITY_DATABASE_URL") or ""

pytestmark = [pytest.mark.skipif(not _RAW, reason="real-DB URL 미설정 — skip"), pytest.mark.anyio]


@pytest.fixture
def anyio_backend():
    return "asyncio"


async def test_every_checkout_is_tagged_inside_the_block_even_for_an_engine_created_before_it():
    from tests.own_connection_probe import async_url, idle_in_tx_count, tag_every_checkout, unique_tag

    engine = create_async_engine(async_url(_RAW))  # created BEFORE the block, with no tag of its own
    Session = async_sessionmaker(engine, expire_on_commit=False)
    tag = unique_tag("t4879-h")
    try:
        with tag_every_checkout(tag):
            async with Session() as s:
                await s.execute(text("select 1"))  # autobegin: idle in transaction
                assert await idle_in_tx_count(Session, tag) == 1
                assert await idle_in_tx_count(Session, tag + "-other") == 0
                await s.rollback()
            assert await idle_in_tx_count(Session, tag) == 0
    finally:
        await engine.dispose()


async def test_the_listener_is_gone_after_the_block():
    from tests.own_connection_probe import async_url, tag_every_checkout, unique_tag

    tag = unique_tag("t4879-h2")
    with tag_every_checkout(tag):
        pass
    engine = create_async_engine(async_url(_RAW))  # a fresh engine: its first connection is checked out AFTER the block
    try:
        async with engine.connect() as conn:
            name = (await conn.execute(text("select current_setting('application_name')"))).scalar_one()
        assert name != tag, name
    finally:
        await engine.dispose()


async def test_a_neighbour_keeps_its_own_name_and_is_visible_database_wide():
    from tests.own_connection_probe import async_url, idle_in_tx_count, neighbour_transaction, tag_every_checkout, unique_tag

    engine = create_async_engine(async_url(_RAW))
    Session = async_sessionmaker(engine, expire_on_commit=False)
    tag = unique_tag("t4879-h3")
    try:
        with tag_every_checkout(tag):
            async with neighbour_transaction(_RAW, tag + "-neighbour"):
                assert await idle_in_tx_count(Session, tag + "-neighbour") == 1  # raw asyncpg: the tag did not touch it
                assert await idle_in_tx_count(Session, tag) == 0  # and it does not count as ours
                assert await idle_in_tx_count(Session) >= 1  # but the database-wide count sees it
            assert await idle_in_tx_count(Session, tag + "-neighbour") == 0  # rolled back and closed on exit
    finally:
        await engine.dispose()


async def test_a_tagged_engine_puts_its_name_on_every_connection():
    from tests.own_connection_probe import idle_in_tx_count, tagged_engine, unique_tag

    tag = unique_tag("t4879-h4")
    engine = tagged_engine(_RAW, tag)
    Session = async_sessionmaker(engine, expire_on_commit=False)
    try:
        async with Session() as a, Session() as b:
            await a.execute(text("select 1"))
            await b.execute(text("select 1"))
            assert await idle_in_tx_count(Session, tag) == 2
            await a.rollback()
            await b.rollback()
    finally:
        await engine.dispose()


async def test_our_tag_wins_over_an_earlier_listener_on_the_global_engine():
    """The destructive tests' conftest names the global engine's connections `ge|...` with a listener of its own on that engine. A listener registered on the instance runs after the
    class-level ones - so our tag must also be registered on the instance, after it, or the conftest's name would overwrite ours and the own count would read 0."""
    from sqlalchemy import event
    from sqlalchemy.util import await_only

    from app.core.database import async_session_factory
    from app.core.database import engine as global_engine
    from tests.own_connection_probe import idle_in_tx_count, tag_every_checkout, unique_tag

    def _conftest_like(dbapi_connection, _record, _proxy):
        driver = getattr(dbapi_connection, "driver_connection", None)
        if driver is not None:
            await_only(driver.execute("SELECT set_config('application_name', $1, false)", "ge|earlier|listener"))

    event.listen(global_engine.sync_engine, "checkout", _conftest_like)
    tag = unique_tag("t4879-h5")
    try:
        with tag_every_checkout(tag):
            async with async_session_factory() as s:
                await s.execute(text("select 1"))  # autobegin on the global engine
                assert await idle_in_tx_count(async_session_factory, tag) == 1
                await s.rollback()
    finally:
        event.remove(global_engine.sync_engine, "checkout", _conftest_like)
        await global_engine.dispose()


async def test_the_snapshot_reads_own_neighbour_and_everyone_in_one_statement():
    from tests.own_connection_probe import NEIGHBOUR_SUFFIX, async_url, idle_in_tx_snapshot, neighbour_transaction, tagged_engine, unique_tag

    tag = unique_tag("t4879-h6")
    engine = tagged_engine(_RAW, tag)
    Session = async_sessionmaker(engine, expire_on_commit=False)
    try:
        async with neighbour_transaction(_RAW, tag + NEIGHBOUR_SUFFIX):
            async with Session() as mine:
                await mine.execute(text("select 1"))  # ours, idle in transaction
                own, neighbour, everyone = await idle_in_tx_snapshot(Session, tag)
                await mine.rollback()
        assert (own, neighbour) == (1, 1) and everyone >= 2, (own, neighbour, everyone)
        own2, neighbour2, _everyone2 = await idle_in_tx_snapshot(Session, tag)
        assert (own2, neighbour2) == (0, 0), (own2, neighbour2)  # both gone again
    finally:
        await engine.dispose()
    assert async_url(_RAW).startswith("postgresql+asyncpg://")


async def test_a_pooled_connection_loses_the_tag_when_the_app_engines_are_disposed():
    """The tag stays on a pooled connection after the block: a test that uses tag_every_checkout ends with dispose_app_engines(), after which the next checkout is a fresh,
    untagged connection (the worker pool included - nobody else disposes it)."""
    from sqlalchemy import text as _t

    from app.core.database import async_session_factory
    from tests.own_connection_probe import dispose_app_engines, tag_every_checkout, unique_tag

    tag = unique_tag("t4879-h7")
    with tag_every_checkout(tag):
        async with async_session_factory() as s:
            assert (await s.execute(_t("select current_setting('application_name')"))).scalar_one() == tag
    await dispose_app_engines()
    async with async_session_factory() as s:
        assert (await s.execute(_t("select current_setting('application_name')"))).scalar_one() != tag
    await dispose_app_engines()


async def test_a_failure_while_registering_leaves_no_listener_behind(monkeypatch):
    from types import SimpleNamespace

    from tests import own_connection_probe as probe

    tag = probe.unique_tag("t4879-h8")
    monkeypatch.setattr(probe, "_app_engines", lambda: [SimpleNamespace(sync_engine=object())])  # event.listen on this raises after the class-level one was registered
    with pytest.raises(Exception):
        with probe.tag_every_checkout(tag):
            pass
    engine = create_async_engine(probe.async_url(_RAW))  # first connection checked out AFTER the failed block
    try:
        async with engine.connect() as conn:
            assert (await conn.execute(text("select current_setting('application_name')"))).scalar_one() != tag
    finally:
        await engine.dispose()


async def test_a_neighbour_is_really_idle_in_its_transaction():
    """Guards the noisy condition itself: the neighbour fixture's connection is idle IN A TRANSACTION (not merely connected)."""
    from tests.own_connection_probe import NEIGHBOUR_SUFFIX, async_url, idle_in_tx_count, neighbour_transaction, unique_tag

    engine = create_async_engine(async_url(_RAW))
    Session = async_sessionmaker(engine, expire_on_commit=False)
    tag = unique_tag("t4879-h9")
    try:
        async with neighbour_transaction(_RAW, tag + NEIGHBOUR_SUFFIX):
            assert await idle_in_tx_count(Session, tag + NEIGHBOUR_SUFFIX) == 1
    finally:
        await engine.dispose()


def test_unique_tags_differ_and_leave_room_for_the_neighbour_suffix():
    from tests.own_connection_probe import unique_tag

    tags = {unique_tag("t4879-x") for _ in range(50)}
    assert len(tags) == 50
    assert all(len((t + "-neighbour").encode()) <= 63 for t in tags)
