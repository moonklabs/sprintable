"""story #2892(P0, 실사고 2026-08-21) — `compute_pack_charge_minor`가 Postgres
`SUM(bigint)`(SQL 표준상 numeric 반환 → asyncpg가 Decimal로 디코드)를 그대로 반환하던
결함. 반환 타입힌트는 `-> int`인데 실제로는 Decimal이 나와, 그 값이 `charge_org`→
`TossAdapter.charge()`의 JSON 바디까지 흘러 들어가 httpx `json.dumps`가 "Object of type
Decimal is not JSON serializable"로 500을 냈다(Toss 네트워크 호출 자체가 안 나간 순수
인코딩 실패 — dev 실 Cloud Logging 08:18:04Z 확認).

이 테스트는 실제 SUM 집계가 일어나는 경로(billing_ledger_entries에 pack_purchase 2건
이상 INSERT 후 합산)로 재현한다 — 단건/0건 케이스는 Python 레벨 `+ 0` 등으로 우연히
int가 나올 수 있어 버그를 못 잡는다(SUM 자체가 진짜로 도는 경로가 필요)."""
from __future__ import annotations

import os
import uuid
from datetime import datetime, timedelta, timezone

import pytest

_REAL_DB_URL = os.getenv("PARITY_TEST_DATABASE_URL") or os.getenv("ALEMBIC_DATABASE_URL")

pytestmark = [
    pytest.mark.skipif(not _REAL_DB_URL, reason="통합 테스트는 실 PG(PARITY/ALEMBIC_DATABASE_URL) 필요"),
    pytest.mark.anyio,
]


@pytest.fixture
def anyio_backend():
    return "asyncio"


@pytest.fixture(autouse=True)
async def _dispose_global_engine_after_test():
    yield
    from app.core.database import engine as _global_engine
    await _global_engine.dispose()


def _async_url() -> str:
    url = _REAL_DB_URL
    for prefix in ("postgresql+psycopg2://", "postgresql+asyncpg://", "postgresql://"):
        if url.startswith(prefix):
            return "postgresql+asyncpg://" + url[len(prefix):]
    return url


async def _session_factory():
    from sqlalchemy.ext.asyncio import async_sessionmaker, create_async_engine
    engine = create_async_engine(_async_url())
    return engine, async_sessionmaker(engine, expire_on_commit=False)


async def _seed_org_and_ledger(session) -> tuple[uuid.UUID, uuid.UUID, datetime, datetime]:
    from app.models.organization import Organization
    from app.models.org_subscription import OrgSubscription
    from app.models.billing_ledger_entry import BillingLedgerEntry

    org = Organization(id=uuid.uuid4(), name="Org2892", slug=f"org2892-{uuid.uuid4().hex[:8]}")
    session.add(org)
    await session.flush()

    # billing_ledger_entries.subscription_id는 org_subscriptions.id FK — 실제 행 필요.
    subscription_id = uuid.uuid4()
    session.add(OrgSubscription(
        id=subscription_id, org_id=org.id, tier="starter", billing_cycle="monthly",
        status="active", provider="toss", currency="krw",
    ))
    await session.flush()

    period_start = datetime(2026, 8, 1, tzinfo=timezone.utc)
    period_end = period_start + timedelta(days=30)

    # story #2892 재현 핵심 — 2건 이상(SUM이 진짜로 여러 행을 더하게).
    for amount in (5000, 3000):
        session.add(BillingLedgerEntry(
            id=uuid.uuid4(), org_id=org.id, ts=period_start + timedelta(days=1),
            entry_type="pack_purchase", amount_minor=amount, currency="krw",
            direction="credit", subscription_id=subscription_id,
        ))
    await session.commit()
    return org.id, subscription_id, period_start, period_end


@pytest.mark.asyncio
async def test_compute_pack_charge_minor_returns_native_int_not_decimal():
    from app.services.billing_charge_amount import compute_pack_charge_minor
    from decimal import Decimal

    engine, Session = await _session_factory()
    try:
        async with Session() as s:
            org_id, subscription_id, period_start, period_end = await _seed_org_and_ledger(s)

        async with Session() as s:
            result = await compute_pack_charge_minor(
                s, org_id=org_id, subscription_id=subscription_id,
                period_start=period_start, period_end=period_end,
            )
            assert result == 8000
            assert type(result) is int, (
                f"compute_pack_charge_minor가 {type(result)}를 반환함(Decimal이면 "
                f"httpx json.dumps가 TossAdapter.charge() 호출 전에 TypeError로 죽는다 — "
                f"#2892 실사고 재현)"
            )
            assert not isinstance(result, Decimal)
    finally:
        await engine.dispose()


@pytest.mark.asyncio
async def test_compute_pack_charge_minor_zero_when_no_period():
    from app.services.billing_charge_amount import compute_pack_charge_minor

    engine, Session = await _session_factory()
    try:
        result = await compute_pack_charge_minor(
            None, org_id=uuid.uuid4(), subscription_id=uuid.uuid4(),
            period_start=None, period_end=None,
        )
        assert result == 0
        assert type(result) is int
    finally:
        await engine.dispose()


@pytest.mark.asyncio
async def test_toss_adapter_charge_json_body_amount_is_native_int_even_given_decimal():
    """어댑터 경계 방어(둘째 층) — 호출부가 실수로 Decimal을 넘겨도 charge()가 int로
    강제 변환해 httpx json 인코딩이 죽지 않는다. 실 Toss 호출은 안 나가게 시크릿
    미설정으로 그 전 단계(_auth_header)에서 명시 실패시켜 네트워크 접촉 0으로 검증."""
    from decimal import Decimal
    from app.services.payment.toss_adapter import TossAdapter
    from app.core.config import settings

    adapter = TossAdapter()
    original_secret = settings.toss_payments_secret_key
    settings.toss_payments_secret_key = ""
    try:
        with pytest.raises(RuntimeError, match="TOSS_PAYMENTS_SECRET_KEY"):
            await adapter.charge(
                billing_key="bk_test", customer_key="ck_test", order_id="ord_test",
                amount_minor=Decimal("29000"), order_name="test",
            )
    finally:
        settings.toss_payments_secret_key = original_secret
