"""#2472(A2) real-DB — billing_ledger_entries 불변성·멱등·파생 잔액이 실제로 도는지 증명.

DB env(ALEMBIC_DATABASE_URL) 없으면 skip — CI alembic-fresh-db 잡 env에서 실행/로컬 PG
(alembic upgrade head 가 이미 적용된 DB를 전제한다)."""
from __future__ import annotations

import os
import uuid

import pytest
from sqlalchemy import text
from sqlalchemy.exc import DBAPIError
from sqlalchemy.ext.asyncio import async_sessionmaker, create_async_engine

from app.services.billing_ledger import get_org_balance, record_ledger_entry

_RAW = os.environ.get("ALEMBIC_DATABASE_URL") or os.environ.get("PARITY_TEST_DATABASE_URL") or ""
_ASYNC = _RAW.replace("postgresql+psycopg2://", "postgresql+asyncpg://").replace(
    "postgresql://", "postgresql+asyncpg://"
)

pytestmark = pytest.mark.skipif(not _RAW, reason="real-DB URL 미설정 — skip")


@pytest.fixture
def anyio_backend():
    return "asyncio"


# 정리(cleanup) 없음 — append-only 테이블이라 DELETE 자체가 거부된다(그게 이 스토리가
# 증명하려는 것). org_id를 매 테스트 uuid4()로 무작위 생성해 교차 오염 없이 흘려보낸다.


@pytest.mark.anyio
async def test_record_entry_and_balance_derivation():
    """양성대조 — 기입 N건 → 파생 잔액 정확성(AC 명시 요구)."""
    engine = create_async_engine(_ASYNC)
    Session = async_sessionmaker(engine, expire_on_commit=False)
    org_id = uuid.uuid4()
    try:
        async with Session() as session:
            await record_ledger_entry(
                session, org_id=org_id, entry_type="charge", amount_minor=59_000,
                currency="krw", direction="credit", provider="toss", provider_ref=f"ref-{uuid.uuid4()}",
            )
            await record_ledger_entry(
                session, org_id=org_id, entry_type="refund", amount_minor=10_000,
                currency="krw", direction="debit", provider="toss", provider_ref=f"ref-{uuid.uuid4()}",
            )
            await record_ledger_entry(
                session, org_id=org_id, entry_type="credit_grant", amount_minor=5_000,
                currency="krw", direction="credit",  # provider 없음 — 내부전용 엔트리
            )
            balance = await get_org_balance(session, org_id, "krw")
            assert balance == 59_000 - 10_000 + 5_000  # = 54,000

            row = (
                await session.execute(
                    text(
                        "SELECT entry_count FROM org_ledger_balances WHERE org_id = :oid AND currency = 'krw'"
                    ),
                    {"oid": org_id},
                )
            ).scalar_one()
            assert row == 3
    finally:
        await engine.dispose()


@pytest.mark.anyio
async def test_record_entry_idempotent_on_provider_ref_conflict():
    """양성대조 — 같은 provider_ref 재기입은 새 행을 만들지 않고 기존 엔트리를 반환(no-op)."""
    engine = create_async_engine(_ASYNC)
    Session = async_sessionmaker(engine, expire_on_commit=False)
    org_id = uuid.uuid4()
    ref = f"webhook-{uuid.uuid4()}"
    try:
        async with Session() as session:
            first = await record_ledger_entry(
                session, org_id=org_id, entry_type="charge", amount_minor=1_000,
                currency="krw", direction="credit", provider="toss", provider_ref=ref,
            )
            second = await record_ledger_entry(
                session, org_id=org_id, entry_type="charge", amount_minor=1_000,
                currency="krw", direction="credit", provider="toss", provider_ref=ref,
            )
            assert first.id == second.id  # 새 행 아님 — 기존 엔트리 반환

            count = (
                await session.execute(
                    text("SELECT COUNT(*) FROM billing_ledger_entries WHERE provider_ref = :ref"),
                    {"ref": ref},
                )
            ).scalar()
            assert count == 1  # 재시도해도 1건만
    finally:
        await engine.dispose()


@pytest.mark.anyio
async def test_append_only_rejects_update():
    """양성대조 — 0229 트리거가 실제 UPDATE를 거부하는가."""
    engine = create_async_engine(_ASYNC)
    Session = async_sessionmaker(engine, expire_on_commit=False)
    org_id = uuid.uuid4()
    try:
        async with Session() as session:
            entry = await record_ledger_entry(
                session, org_id=org_id, entry_type="adjustment", amount_minor=100,
                currency="krw", direction="credit",
            )
            with pytest.raises(DBAPIError, match="append-only"):
                await session.execute(
                    text("UPDATE billing_ledger_entries SET amount_minor = 999 WHERE id = :id"),
                    {"id": entry.id},
                )
                await session.commit()
            await session.rollback()
    finally:
        await engine.dispose()


@pytest.mark.anyio
async def test_append_only_rejects_delete():
    """양성대조 — 0229 트리거가 실제 DELETE를 거부하는가."""
    engine = create_async_engine(_ASYNC)
    Session = async_sessionmaker(engine, expire_on_commit=False)
    org_id = uuid.uuid4()
    try:
        async with Session() as session:
            entry = await record_ledger_entry(
                session, org_id=org_id, entry_type="adjustment", amount_minor=100,
                currency="krw", direction="credit",
            )
            with pytest.raises(DBAPIError, match="append-only"):
                await session.execute(
                    text("DELETE FROM billing_ledger_entries WHERE id = :id"), {"id": entry.id}
                )
                await session.commit()
            await session.rollback()
    finally:
        await engine.dispose()


@pytest.mark.anyio
async def test_record_entry_rejects_invalid_entry_type_and_negative_amount():
    engine = create_async_engine(_ASYNC)
    Session = async_sessionmaker(engine, expire_on_commit=False)
    org_id = uuid.uuid4()
    try:
        async with Session() as session:
            with pytest.raises(ValueError):
                await record_ledger_entry(
                    session, org_id=org_id, entry_type="bogus_type", amount_minor=100,
                    currency="krw", direction="credit",
                )
            with pytest.raises(ValueError):
                await record_ledger_entry(
                    session, org_id=org_id, entry_type="charge", amount_minor=0,
                    currency="krw", direction="credit",
                )
    finally:
        await engine.dispose()


@pytest.mark.anyio
async def test_no_entries_org_balance_is_zero():
    """양성대조(음성 기준선) — 원장에 없는 org는 0(적자/흑자 아님)."""
    engine = create_async_engine(_ASYNC)
    Session = async_sessionmaker(engine, expire_on_commit=False)
    try:
        async with Session() as session:
            balance = await get_org_balance(session, uuid.uuid4(), "krw")
            assert balance == 0
    finally:
        await engine.dispose()
