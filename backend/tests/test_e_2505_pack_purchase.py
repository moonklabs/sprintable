"""#2505 — 팩 구매 트리거. v2.1 §11.1: 관리자 명시 구매만, 자동 초과청구 없음."""
from __future__ import annotations

import uuid
from datetime import datetime, timedelta, timezone
from unittest.mock import AsyncMock, MagicMock, patch

import pytest


def _sub(*, org_id, status="active", offering_version_id=None, period_start=None, period_end=None):
    s = MagicMock()
    s.org_id = org_id
    s.status = status
    s.offering_version_id = offering_version_id or uuid.uuid4()
    s.current_period_start = period_start or datetime(2026, 8, 1, tzinfo=timezone.utc)
    s.current_period_end = period_end or datetime(2026, 9, 1, tzinfo=timezone.utc)
    return s


def _offering(*, tier="starter", currency="krw", pack_catalog=None):
    o = MagicMock()
    o.id = uuid.uuid4()
    o.tier = tier
    o.currency = currency
    o.pack_catalog = pack_catalog if pack_catalog is not None else {
        "au": {"unit": 150_000, "price_minor": 5_000, "max_packs": 5},
        "storage_gb": {"unit": 10, "price_minor": 3_000, "max_packs": 3},
    }
    return o


def _exec_result(scalar_value):
    r = MagicMock()
    r.scalar_one_or_none.return_value = scalar_value
    r.scalar_one.return_value = scalar_value
    return r


# ─── purchase_packs — 입력/전제 검증 ────────────────────────────────────────

@pytest.mark.anyio
async def test_purchase_packs_rejects_quantity_below_one():
    from app.services.billing_pack import PackPurchaseError, purchase_packs

    session = AsyncMock()
    with pytest.raises(PackPurchaseError, match="quantity"):
        await purchase_packs(session, org_id=uuid.uuid4(), resource="au", quantity=0, idempotency_key="k1")


@pytest.mark.anyio
async def test_purchase_packs_rejects_missing_idempotency_key():
    from app.services.billing_pack import PackPurchaseError, purchase_packs

    session = AsyncMock()
    with pytest.raises(PackPurchaseError, match="idempotency_key"):
        await purchase_packs(session, org_id=uuid.uuid4(), resource="au", quantity=1, idempotency_key="")


@pytest.mark.anyio
async def test_purchase_packs_raises_when_no_active_subscription():
    from app.services.billing_pack import PackPurchaseError, purchase_packs

    session = AsyncMock()
    session.execute = AsyncMock(return_value=_exec_result(None))
    with pytest.raises(PackPurchaseError, match="활성 유료 구독"):
        await purchase_packs(session, org_id=uuid.uuid4(), resource="au", quantity=1, idempotency_key="k1")


@pytest.mark.anyio
async def test_purchase_packs_raises_when_subscription_pending_not_active():
    from app.services.billing_pack import PackPurchaseError, purchase_packs

    org_id = uuid.uuid4()
    session = AsyncMock()
    session.execute = AsyncMock(return_value=_exec_result(_sub(org_id=org_id, status="pending")))
    with pytest.raises(PackPurchaseError, match="활성 유료 구독"):
        await purchase_packs(session, org_id=org_id, resource="au", quantity=1, idempotency_key="k1")


@pytest.mark.anyio
async def test_purchase_packs_raises_when_resource_not_sold_for_tier():
    from app.services.billing_pack import PackPurchaseError, purchase_packs

    org_id = uuid.uuid4()
    sub = _sub(org_id=org_id)
    offering = _offering(pack_catalog={"au": {"unit": 150_000, "price_minor": 5_000, "max_packs": 5}})
    session = AsyncMock()
    session.execute = AsyncMock(return_value=_exec_result(sub))
    session.get = AsyncMock(return_value=offering)
    with pytest.raises(PackPurchaseError, match="storage_gb"):
        await purchase_packs(session, org_id=org_id, resource="storage_gb", quantity=1, idempotency_key="k1")


# ─── purchase_packs — max_packs 캡 ───────────────────────────────────────────

@pytest.mark.anyio
async def test_purchase_packs_raises_when_exceeding_max_packs():
    from app.services.billing_pack import PackPurchaseError, purchase_packs

    org_id = uuid.uuid4()
    sub = _sub(org_id=org_id)
    offering = _offering()  # au max_packs=5, price=5000

    session = AsyncMock()
    session.execute = AsyncMock(side_effect=[
        _exec_result(sub),          # sub lookup
        MagicMock(),                # advisory xact lock 획득
        _exec_result(4 * 5_000),    # 이미 4개(20,000원어치) 예약/구매
    ])
    session.get = AsyncMock(return_value=offering)

    with pytest.raises(PackPurchaseError, match="max_packs"):
        await purchase_packs(session, org_id=org_id, resource="au", quantity=2, idempotency_key="k1")  # 4+2 > 5

    session.rollback.assert_awaited_once()  # 락을 즉시 해제


@pytest.mark.anyio
async def test_purchase_packs_allows_up_to_max_packs_exactly():
    from app.services.billing_pack import purchase_packs

    org_id = uuid.uuid4()
    sub = _sub(org_id=org_id)
    offering = _offering()

    confirmed_order = MagicMock()
    confirmed_order.status = "confirmed"

    session = AsyncMock()
    session.execute = AsyncMock(side_effect=[
        _exec_result(sub),
        MagicMock(),              # advisory xact lock 획득
        _exec_result(3 * 5_000),  # 3개 이미 예약/구매
    ])
    session.get = AsyncMock(return_value=offering)

    with patch("app.services.billing_pack.charge_org", new=AsyncMock(return_value=confirmed_order)) as mock_charge:
        result = await purchase_packs(session, org_id=org_id, resource="au", quantity=2, idempotency_key="k1")  # 3+2=5=max

    assert result.status == "confirmed"
    mock_charge.assert_awaited_once()


@pytest.mark.anyio
async def test_purchase_packs_no_cap_when_max_packs_none():
    """team/business의 lab_credit처럼 max_packs=None(무제한) — 대량 구매도 통과."""
    from app.services.billing_pack import purchase_packs

    org_id = uuid.uuid4()
    sub = _sub(org_id=org_id)
    offering = _offering(pack_catalog={"lab_credit": {"unit": 5_000, "price_minor": 10_000, "max_packs": None}})
    confirmed_order = MagicMock()
    confirmed_order.status = "confirmed"

    session = AsyncMock()
    session.execute = AsyncMock(return_value=_exec_result(sub))  # max_packs None → 두번째 조회(구매이력) 안 함
    session.get = AsyncMock(return_value=offering)

    with patch("app.services.billing_pack.charge_org", new=AsyncMock(return_value=confirmed_order)):
        result = await purchase_packs(session, org_id=org_id, resource="lab_credit", quantity=100, idempotency_key="k1")

    assert result.status == "confirmed"
    assert session.execute.await_count == 1  # 구매이력 조회를 아예 건너뜀


# ─── purchase_packs — 청구 연동 ──────────────────────────────────────────────

@pytest.mark.anyio
async def test_purchase_packs_charges_price_times_quantity_with_pack_purchase_entry_type():
    from app.services.billing_pack import purchase_packs

    org_id = uuid.uuid4()
    sub = _sub(org_id=org_id)
    offering = _offering()
    confirmed_order = MagicMock()
    confirmed_order.status = "confirmed"

    session = AsyncMock()
    session.execute = AsyncMock(side_effect=[_exec_result(sub), MagicMock(), _exec_result(0)])
    session.get = AsyncMock(return_value=offering)

    with patch("app.services.billing_pack.charge_org", new=AsyncMock(return_value=confirmed_order)) as mock_charge:
        await purchase_packs(session, org_id=org_id, resource="au", quantity=3, idempotency_key="click-1")

    kwargs = mock_charge.await_args.kwargs
    assert kwargs["amount_minor"] == 5_000 * 3
    assert kwargs["currency"] == "krw"
    assert kwargs["entry_type"] == "pack_purchase"
    assert kwargs["ledger_metadata"] == {"resource": "au", "quantity": 3, "unit": 150_000}
    assert kwargs["order_id"] == f"pack:{org_id}:au:click-1"


@pytest.mark.anyio
async def test_purchase_packs_same_idempotency_key_is_deterministic_order_id():
    from app.services.billing_pack import purchase_packs

    org_id = uuid.uuid4()
    sub = _sub(org_id=org_id)
    offering = _offering()
    confirmed_order = MagicMock()
    confirmed_order.status = "confirmed"

    session = AsyncMock()
    session.execute = AsyncMock(side_effect=[
        _exec_result(sub), MagicMock(), _exec_result(0),
        _exec_result(sub), MagicMock(), _exec_result(5_000),
    ])
    session.get = AsyncMock(return_value=offering)

    with patch("app.services.billing_pack.charge_org", new=AsyncMock(return_value=confirmed_order)) as mock_charge:
        await purchase_packs(session, org_id=org_id, resource="au", quantity=1, idempotency_key="same-key")
        await purchase_packs(session, org_id=org_id, resource="au", quantity=1, idempotency_key="same-key")

    order_ids = [c.kwargs["order_id"] for c in mock_charge.await_args_list]
    assert order_ids[0] == order_ids[1]  # charge_org의 원자적 claim이 중복 청구를 흡수


@pytest.mark.anyio
async def test_purchase_packs_declined_raises_with_order_attached():
    from app.services.billing_pack import PackPurchaseDeclined, purchase_packs
    from app.services.payment.toss_adapter import TossApiError

    org_id = uuid.uuid4()
    sub = _sub(org_id=org_id)
    offering = _offering()
    failed_order = MagicMock()
    failed_order.status = "failed"

    session = AsyncMock()
    session.execute = AsyncMock(side_effect=[_exec_result(sub), MagicMock(), _exec_result(0), _exec_result(failed_order)])
    session.get = AsyncMock(return_value=offering)

    with patch(
        "app.services.billing_pack.charge_org",
        new=AsyncMock(side_effect=TossApiError("CARD_DECLINED", "카드 거절", status_code=400)),
    ):
        with pytest.raises(PackPurchaseDeclined) as exc_info:
            await purchase_packs(session, org_id=org_id, resource="au", quantity=1, idempotency_key="k2")

    assert exc_info.value.order.status == "failed"
