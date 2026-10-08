"""story #4632: the flood-block stamps record the moment of the write, not the start of the transaction.

`chain_circuit_breaker.opened_at` and `conversation_messages.created_at` used `now()` (the start of the writing transaction). A long
transaction stamped its breaker and messages earlier than they happened, so the auto-release check could release early and the velocity
window could miss late messages. Migration 0448 moves both defaults to `clock_timestamp()`. These tests pin that on a real DB:
- AC2: a breaker opened late in a long transaction carries its write time, so it is not treated as two windows old.
- AC3: a message written late in a long transaction carries its write time, so it counts inside the velocity window.
- PO (4632): two messages in one transaction get distinct, increasing stamps, so the list order does not change.

Each test runs against an alembic-migrated DB (PARITY_TEST_DATABASE_URL or ALEMBIC_DATABASE_URL). With the old `now()` defaults the
first three assertions fail (RED).
"""
from __future__ import annotations

import os
import uuid
from datetime import timedelta

import pytest
from sqlalchemy import text

_REAL_DB_URL = os.getenv("PARITY_TEST_DATABASE_URL") or os.getenv("ALEMBIC_DATABASE_URL")

# Not destructive: these tests only write rows into the migrated DB and never reset its schema.
pytestmark = pytest.mark.skipif(not _REAL_DB_URL, reason="needs PARITY_TEST_DATABASE_URL or ALEMBIC_DATABASE_URL")

# A transaction held open this long before the write. Any value well above the clock resolution works; the assertions compare against
# this same value, not against a wall-clock budget.
HELD_OPEN_SECONDS = 2.5


@pytest.fixture
def anyio_backend():
    return "asyncio"


@pytest.fixture(autouse=True)
async def _dispose_global_engine_after_test():
    yield
    from app.core.database import engine as _global_engine

    await _global_engine.dispose()


async def _realdb_session():
    from sqlalchemy.ext.asyncio import async_sessionmaker, create_async_engine

    url = _REAL_DB_URL
    for prefix in ("postgresql+psycopg2://", "postgresql://"):
        if url.startswith(prefix):
            url = "postgresql+asyncpg://" + url[len(prefix):]
            break
    engine = create_async_engine(url)
    return engine, async_sessionmaker(engine, expire_on_commit=False)


async def _seed_conversation(session) -> tuple[uuid.UUID, uuid.UUID]:
    from app.models.conversation import Conversation
    from app.models.organization import Organization
    from app.models.project import Project

    org = Organization(id=uuid.uuid4(), name="Org4632", slug=f"org4632-{uuid.uuid4().hex[:8]}")
    session.add(org)
    await session.commit()
    project = Project(id=uuid.uuid4(), org_id=org.id, name="P")
    session.add(project)
    await session.commit()
    conv = Conversation(id=uuid.uuid4(), org_id=org.id, project_id=project.id, type="group")
    session.add(conv)
    await session.commit()
    return org.id, conv.id


@pytest.mark.anyio
async def test_breaker_opened_late_in_long_transaction_carries_write_time():
    """AC2: opened_at is the moment of the insert, not the start of the transaction."""
    from app.models.chain_circuit_breaker import ChainCircuitBreaker

    engine, factory = await _realdb_session()
    try:
        async with factory() as session:
            org_id, conv_id = await _seed_conversation(session)
        async with factory() as session:
            async with session.begin():
                txn_start = (await session.execute(text("SELECT now()"))).scalar_one()
                await session.execute(text(f"SELECT pg_sleep({HELD_OPEN_SECONDS})"))
                breaker = ChainCircuitBreaker(id=uuid.uuid4(), org_id=org_id, conversation_id=conv_id)
                session.add(breaker)
                await session.flush()
                opened_at = (await session.execute(
                    text("SELECT opened_at FROM chain_circuit_breaker WHERE id = :id"), {"id": breaker.id}
                )).scalar_one()
                # The stamp is after the sleep, so it is not the transaction start.
                assert opened_at - txn_start >= timedelta(seconds=HELD_OPEN_SECONDS)
                # The auto-release check's test: a block opened just now is not two windows old.
                two_windows_old = (await session.execute(text(
                    "SELECT :opened <= clock_timestamp() - make_interval(secs => CAST(:secs AS double precision))"
                ), {"opened": opened_at, "secs": 1.0})).scalar_one()
                assert two_windows_old is False
    finally:
        await engine.dispose()


@pytest.mark.anyio
async def test_message_written_late_in_long_transaction_carries_write_time():
    """AC3: created_at is the moment of the insert, so the message counts inside the velocity window."""
    from app.models.conversation import ConversationMessage

    engine, factory = await _realdb_session()
    try:
        async with factory() as session:
            _org_id, conv_id = await _seed_conversation(session)
        async with factory() as session:
            async with session.begin():
                txn_start = (await session.execute(text("SELECT now()"))).scalar_one()
                await session.execute(text(f"SELECT pg_sleep({HELD_OPEN_SECONDS})"))
                msg = ConversationMessage(id=uuid.uuid4(), conversation_id=conv_id, content="late", mentioned_ids=[])
                session.add(msg)
                await session.flush()
                created_at = (await session.execute(
                    text("SELECT created_at FROM conversation_messages WHERE id = :id"), {"id": msg.id}
                )).scalar_one()
                assert created_at - txn_start >= timedelta(seconds=HELD_OPEN_SECONDS)
                # Counted inside the velocity window (the window's start is taken with clock_timestamp()).
                in_window = (await session.execute(text(
                    "SELECT :created >= clock_timestamp() - make_interval(secs => CAST(:secs AS double precision))"
                ), {"created": created_at, "secs": 5.0})).scalar_one()
                assert in_window is True
    finally:
        await engine.dispose()


@pytest.mark.anyio
async def test_two_messages_in_one_transaction_keep_their_order():
    """PO (4632): two messages written in one transaction get distinct, increasing stamps, so the list order is the write order."""
    from app.models.conversation import ConversationMessage

    engine, factory = await _realdb_session()
    try:
        async with factory() as session:
            _org_id, conv_id = await _seed_conversation(session)
        async with factory() as session:
            async with session.begin():
                first = ConversationMessage(id=uuid.uuid4(), conversation_id=conv_id, content="first", mentioned_ids=[])
                session.add(first)
                await session.flush()
                second = ConversationMessage(id=uuid.uuid4(), conversation_id=conv_id, content="second", mentioned_ids=[])
                session.add(second)
                await session.flush()
                rows = (await session.execute(text(
                    "SELECT id FROM conversation_messages WHERE conversation_id = :c ORDER BY created_at, id"
                ), {"c": conv_id})).scalars().all()
                stamps = (await session.execute(text(
                    "SELECT created_at FROM conversation_messages WHERE id IN (:a, :b) ORDER BY created_at"
                ), {"a": first.id, "b": second.id})).scalars().all()
                assert len(stamps) == 2 and stamps[0] < stamps[1]
                assert rows == [first.id, second.id]
    finally:
        await engine.dispose()
