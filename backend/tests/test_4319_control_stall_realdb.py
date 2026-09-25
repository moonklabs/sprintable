"""story #4319 AC6 양성대조 — 일부러 멈추는 테스트(다른 연결이 쥔 잠금을 기다리는 DDL). 병합 전에 뺀다."""
import os

import pytest
import sqlalchemy as sa

_URL = os.getenv("PARITY_TEST_DATABASE_URL") or os.getenv("ALEMBIC_DATABASE_URL")
pytestmark = [pytest.mark.destructive_schema, pytest.mark.skipif(not _URL, reason="real PG")]


@pytest.fixture
def anyio_backend():
    return "asyncio"


@pytest.mark.anyio
async def test_control_ddl_waits_on_a_lock_held_by_another_connection():
    from sqlalchemy.ext.asyncio import create_async_engine

    holder = sa.create_engine(_URL.replace("postgresql+asyncpg://", "postgresql+psycopg2://"))
    with holder.begin() as c:
        c.execute(sa.text("CREATE TABLE IF NOT EXISTS stall_control_4319 (id int)"))
    hold = holder.connect()
    tx = hold.begin()
    hold.execute(sa.text("LOCK TABLE stall_control_4319 IN ACCESS EXCLUSIVE MODE"))  # 쥐고 놓지 않는다
    waiter = create_async_engine(_URL.replace("postgresql+psycopg2://", "postgresql+asyncpg://"))
    async with waiter.begin() as conn:
        await conn.execute(sa.text("ALTER TABLE stall_control_4319 ADD COLUMN extra int"))  # 여기서 멈춘다
    tx.rollback()
