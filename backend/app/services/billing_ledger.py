"""결제 원장 기입 API(#2472 A2). billing_ledger_entries는 append-only — 이 모듈이 유일한
쓰기 경로가 되어야 한다(직접 INSERT/UPDATE 산발 금지).

멱등: provider_ref가 있는 호출은 UNIQUE 충돌 시 새로 쓰지 않고 기존 엔트리를 반환한다(no-op).
반드시 ON CONFLICT DO NOTHING만 쓴다 — DO UPDATE는 트리거(billing_ledger_entries_block_
mutation, 0229)가 거부한다(append-only 위반이므로 의도된 실패).

⛔이 모듈은 PG 웹훅을 «수신»하지 않는다 — 호출자가 이미 검증된 이벤트를 record_ledger_entry로
넘길 뿐이다(웹훅 수신 배선은 B/C 범위). ⛔pack_purchase entry_type을 자동 생성하는 호출부는
이 스토리 기준 어디에도 없다 — v2.3 「자동 초과청구 없음」 원칙상 향후에도 명시적 구매 확인
경로에서만 호출되어야 한다(코드 리뷰 감시 대상)."""
from __future__ import annotations

import uuid

from sqlalchemy import select
from sqlalchemy.dialects.postgresql import insert as pg_insert
from sqlalchemy.ext.asyncio import AsyncSession

from app.models.billing_ledger_entry import BillingLedgerEntry

ENTRY_TYPES = frozenset({"charge", "refund", "pack_purchase", "credit_grant", "credit_consume", "adjustment"})
DIRECTIONS = frozenset({"debit", "credit"})


async def record_ledger_entry(
    session: AsyncSession,
    *,
    org_id: uuid.UUID,
    entry_type: str,
    amount_minor: int,
    currency: str,
    direction: str,
    provider: str | None = None,
    provider_ref: str | None = None,
    subscription_id: uuid.UUID | None = None,
    metadata: dict | None = None,
) -> BillingLedgerEntry:
    """원장에 1건 기입. provider_ref가 이미 존재하면(멱등 충돌) 새로 쓰지 않고 기존 행을
    반환한다 — 호출자는 성공/재시도를 구분할 필요 없이 항상 유효한 엔트리를 받는다."""
    if entry_type not in ENTRY_TYPES:
        raise ValueError(f"invalid entry_type: {entry_type!r}")
    if direction not in DIRECTIONS:
        raise ValueError(f"invalid direction: {direction!r}")
    if amount_minor <= 0:
        raise ValueError(f"amount_minor must be positive: {amount_minor!r}")

    entry_id = uuid.uuid4()
    stmt = pg_insert(BillingLedgerEntry).values(
        id=entry_id,
        org_id=org_id,
        entry_type=entry_type,
        amount_minor=amount_minor,
        currency=currency,
        direction=direction,
        provider=provider,
        provider_ref=provider_ref,
        subscription_id=subscription_id,
        entry_metadata=metadata,
    )
    if provider_ref is not None:
        stmt = stmt.on_conflict_do_nothing(index_elements=["provider_ref"])
    result = await session.execute(stmt)
    await session.commit()

    if provider_ref is not None and result.rowcount == 0:
        # 멱등 충돌 — 기존 행을 재조회해 반환(no-op, 조용히 삼키지 않고 명시적으로 알려준다).
        existing = (
            await session.execute(
                select(BillingLedgerEntry).where(BillingLedgerEntry.provider_ref == provider_ref)
            )
        ).scalar_one()
        return existing

    return (
        await session.execute(select(BillingLedgerEntry).where(BillingLedgerEntry.id == entry_id))
    ).scalar_one()


async def get_org_balance(session: AsyncSession, org_id: uuid.UUID, currency: str) -> int:
    """org_ledger_balances 뷰에서 순잔액(minor unit) 조회. 엔트리 0건이면 0(적자/흑자 아님)."""
    from sqlalchemy import text

    row = (
        await session.execute(
            text("SELECT balance_minor FROM org_ledger_balances WHERE org_id = :oid AND currency = :cur"),
            {"oid": str(org_id), "cur": currency},
        )
    ).first()
    return int(row[0]) if row else 0
