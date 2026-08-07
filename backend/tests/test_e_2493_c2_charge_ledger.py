"""#2493(C2) — TossAdapter.charge + billing_orders(orderId-먼저-기록) + A2 원장 연동.
PO 계약(2026-08-07): C2는 메커니즘만 — amount/currency/order_id는 파라미터."""
from __future__ import annotations

import uuid
from unittest.mock import AsyncMock, MagicMock, patch

import pytest


# ─── TossAdapter.charge — 실 HTTP 파이프라인 ───────────────────────────────

@pytest.mark.anyio
async def test_toss_charge_success():
    from app.services.payment.toss_adapter import TossAdapter

    mock_resp = MagicMock()
    mock_resp.status_code = 200
    mock_resp.json.return_value = {
        "paymentKey": "pay_key_123", "status": "DONE", "totalAmount": 29000,
        "approvedAt": "2026-08-07T00:00:00+09:00",
        "orderId": "ord-abc123", "orderName": "Sprintable 정기결제",
        "card": {"issuerCode": "61", "number": "1234********5678"},
        "receipt": {"url": "https://dashboard.tosspayments.com/receipt/abc"},
    }

    with patch("app.services.payment.toss_adapter.settings") as mock_settings:
        mock_settings.toss_payments_secret_key = "test_sk_dummy"
        mock_client = AsyncMock()
        mock_client.__aenter__.return_value.post = AsyncMock(return_value=mock_resp)
        with patch("httpx.AsyncClient", return_value=mock_client):
            adapter = TossAdapter()
            result = await adapter.charge(
                billing_key="billing_key_plain", customer_key="cust_x",
                order_id="ord-abc123", amount_minor=29000, order_name="Sprintable 정기결제",
            )

    assert result["paymentKey"] == "pay_key_123"
    assert result["totalAmount"] == 29000
    call_args = mock_client.__aenter__.return_value.post.call_args
    assert call_args.args[0].endswith("/v1/billing/billing_key_plain")
    assert call_args.kwargs["json"] == {
        "customerKey": "cust_x", "orderId": "ord-abc123", "amount": 29000,
        "orderName": "Sprintable 정기결제",
    }


@pytest.mark.anyio
async def test_toss_charge_error_status_raises_runtime_error():
    from app.services.payment.toss_adapter import TossAdapter

    mock_resp = MagicMock()
    mock_resp.status_code = 400
    mock_resp.headers = {"content-type": "application/json"}
    mock_resp.json.return_value = {"code": "REJECT_CARD_COMPANY", "message": "..."}

    with patch("app.services.payment.toss_adapter.settings") as mock_settings:
        mock_settings.toss_payments_secret_key = "test_sk_dummy"
        mock_client = AsyncMock()
        mock_client.__aenter__.return_value.post = AsyncMock(return_value=mock_resp)
        with patch("httpx.AsyncClient", return_value=mock_client):
            adapter = TossAdapter()
            with pytest.raises(RuntimeError, match="REJECT_CARD_COMPANY"):
                await adapter.charge(
                    billing_key="bk", customer_key="cust_x", order_id="ord-x",
                    amount_minor=1000, order_name="test",
                )


@pytest.mark.anyio
async def test_toss_charge_no_secret_fails_closed():
    from app.services.payment.toss_adapter import TossAdapter

    with patch("app.services.payment.toss_adapter.settings") as mock_settings:
        mock_settings.toss_payments_secret_key = ""
        adapter = TossAdapter()
        with pytest.raises(RuntimeError, match="TOSS_PAYMENTS_SECRET_KEY"):
            await adapter.charge(
                billing_key="bk", customer_key="cust_x", order_id="ord-x",
                amount_minor=1000, order_name="test",
            )


# ─── charge_org — orderId-먼저-기록 오케스트레이션 ──────────────────────────

def _mock_billing_key_row(*, org_id: uuid.UUID):
    row = MagicMock()
    row.org_id = org_id
    row.status = "active"
    row.customer_key = "cust_existing"
    row.encrypted_billing_key = "enc-token"
    return row


@pytest.mark.anyio
async def test_charge_org_rejects_non_positive_amount():
    from app.services.billing_charge import charge_org

    session = AsyncMock()
    with pytest.raises(ValueError, match="amount_minor"):
        await charge_org(session, org_id=uuid.uuid4(), order_id="ord-x", amount_minor=0, currency="krw")
    session.execute.assert_not_awaited()


@pytest.mark.anyio
async def test_charge_org_confirmed_order_short_circuits_no_toss_call(monkeypatch):
    """진짜 멱등 — 이미 confirmed면 Toss를 다시 안 부른다."""
    from app.models.billing_order import BillingOrder
    import app.services.billing_charge as svc

    confirmed_row = MagicMock(spec=BillingOrder)
    confirmed_row.status = "confirmed"
    session = AsyncMock()
    existing_result = MagicMock()
    existing_result.scalar_one_or_none.return_value = confirmed_row
    session.execute = AsyncMock(return_value=existing_result)

    charge_mock = AsyncMock()
    monkeypatch.setattr(svc.TossAdapter, "charge", charge_mock)

    result = await svc.charge_org(session, org_id=uuid.uuid4(), order_id="ord-dup", amount_minor=29000, currency="krw")

    assert result is confirmed_row
    charge_mock.assert_not_awaited()
    session.execute.assert_awaited_once()  # existing-check만, pending insert도 안 함


@pytest.mark.anyio
async def test_charge_org_no_active_billing_key_raises(monkeypatch):
    import app.services.billing_charge as svc

    org_id = uuid.uuid4()
    session = AsyncMock()
    no_existing_order = MagicMock()
    no_existing_order.scalar_one_or_none.return_value = None
    no_billing_key = MagicMock()
    no_billing_key.scalar_one_or_none.return_value = None
    session.execute = AsyncMock(side_effect=[no_existing_order, no_billing_key])

    monkeypatch.setattr(svc, "ensure_configured", MagicMock())

    with pytest.raises(RuntimeError, match="no active billing key"):
        await svc.charge_org(session, org_id=org_id, order_id="ord-x", amount_minor=29000, currency="krw")


@pytest.mark.anyio
async def test_charge_org_checks_crypto_before_calling_toss(monkeypatch):
    """PO nit①과 동형 규율 — charge도 되돌릴 수 없는 외부호출 前에 crypto 가용성 확認."""
    import app.services.billing_charge as svc
    from app.services.billing_key_crypto import BillingKeyEncryptionNotConfigured

    org_id = uuid.uuid4()
    session = AsyncMock()
    no_existing_order = MagicMock()
    no_existing_order.scalar_one_or_none.return_value = None
    session.execute = AsyncMock(return_value=no_existing_order)

    monkeypatch.setattr(
        svc, "ensure_configured", MagicMock(side_effect=BillingKeyEncryptionNotConfigured("x"))
    )
    charge_mock = AsyncMock()
    monkeypatch.setattr(svc.TossAdapter, "charge", charge_mock)

    with pytest.raises(BillingKeyEncryptionNotConfigured):
        await svc.charge_org(session, org_id=org_id, order_id="ord-x", amount_minor=29000, currency="krw")

    charge_mock.assert_not_awaited()
    # existing-check(1)만 — billing key 조회·pending insert 전부 crypto 확認보다 먼저 안 감.
    assert session.execute.await_count == 1


@pytest.mark.anyio
async def test_charge_org_writes_pending_before_calling_toss(monkeypatch):
    """⭐orderId-먼저-기록 — Toss charge 호출 前에 billing_orders가 pending으로 먼저
    기록되는지 순서를 직접 증명한다."""
    import app.services.billing_charge as svc

    org_id = uuid.uuid4()
    order_id = "ord-order1"
    session = AsyncMock()

    no_existing_order = MagicMock()
    no_existing_order.scalar_one_or_none.return_value = None
    billing_key_result = MagicMock()
    billing_key_result.scalar_one_or_none.return_value = _mock_billing_key_row(org_id=org_id)
    pending_insert_result = MagicMock()
    confirmed_update_result = MagicMock()
    final_select_result = MagicMock()
    final_row = MagicMock()
    final_select_result.scalar_one.return_value = final_row

    session.execute = AsyncMock(side_effect=[
        no_existing_order, billing_key_result, pending_insert_result,
        confirmed_update_result, final_select_result,
    ])
    session.commit = AsyncMock()

    monkeypatch.setattr(svc, "ensure_configured", MagicMock())
    monkeypatch.setattr(svc, "decrypt_billing_key", MagicMock(return_value="plaintext_bk"))

    async def _toss_charge(*args, **kwargs):
        return {"paymentKey": "pay_key_xyz"}

    monkeypatch.setattr(svc.TossAdapter, "charge", _toss_charge)
    monkeypatch.setattr(svc, "record_ledger_entry", AsyncMock())

    result = await svc.charge_org(session, org_id=org_id, order_id=order_id, amount_minor=29000, currency="krw")

    assert result is final_row
    # 3번째 session.execute 호출(pending insert)이 pg_insert INSERT..ON CONFLICT문이었는지.
    pending_insert_call = session.execute.call_args_list[2]
    compiled = pending_insert_call.args[0].compile().params
    assert compiled["order_id"] == order_id
    assert compiled["status"] == "pending"
    # 4번째 호출(confirmed update)이 결제 성공 뒤에야 실행됨 — call_args_list 순서 자체가
    # pending(2번째 인덱스)이 먼저, Toss 결과 반영 update(3번째 인덱스)가 그 다음임을 보증
    # (mock side_effect가 순서대로 소비되므로 이 assert가 실패하면 순서가 깨진 것).
    confirmed_update_call = session.execute.call_args_list[3]
    update_compiled = confirmed_update_call.args[0].compile().params
    assert update_compiled["status"] == "confirmed"
    assert update_compiled["payment_key"] == "pay_key_xyz"

    svc.record_ledger_entry.assert_awaited_once()
    ledger_kwargs = svc.record_ledger_entry.call_args.kwargs
    assert ledger_kwargs["provider_ref"] == "pay_key_xyz"
    assert ledger_kwargs["entry_type"] == "charge"


@pytest.mark.anyio
async def test_charge_org_toss_failure_marks_order_failed_and_reraises(monkeypatch):
    import app.services.billing_charge as svc

    org_id = uuid.uuid4()
    session = AsyncMock()
    no_existing_order = MagicMock()
    no_existing_order.scalar_one_or_none.return_value = None
    billing_key_result = MagicMock()
    billing_key_result.scalar_one_or_none.return_value = _mock_billing_key_row(org_id=org_id)
    pending_insert_result = MagicMock()
    failed_update_result = MagicMock()
    session.execute = AsyncMock(side_effect=[
        no_existing_order, billing_key_result, pending_insert_result, failed_update_result,
    ])
    session.commit = AsyncMock()

    monkeypatch.setattr(svc, "ensure_configured", MagicMock())
    monkeypatch.setattr(svc, "decrypt_billing_key", MagicMock(return_value="plaintext_bk"))
    monkeypatch.setattr(
        svc.TossAdapter, "charge", AsyncMock(side_effect=RuntimeError("Toss charge failed: EXCEED_MAX_DAILY_PAYMENT_COUNT"))
    )
    monkeypatch.setattr(svc, "record_ledger_entry", AsyncMock())

    with pytest.raises(RuntimeError, match="EXCEED_MAX_DAILY_PAYMENT_COUNT"):
        await svc.charge_org(session, org_id=org_id, order_id="ord-fail", amount_minor=29000, currency="krw")

    failed_call = session.execute.call_args_list[3]
    compiled = failed_call.args[0].compile().params
    assert compiled["status"] == "failed"
    assert "EXCEED_MAX_DAILY_PAYMENT_COUNT" in compiled["failure_reason"]
    svc.record_ledger_entry.assert_not_awaited()
