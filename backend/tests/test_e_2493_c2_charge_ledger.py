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


# ─── TossAdapter.get_payment_by_order_id ───────────────────────────────────

@pytest.mark.anyio
async def test_toss_get_payment_by_order_id_success():
    from app.services.payment.toss_adapter import TossAdapter

    mock_resp = MagicMock()
    mock_resp.status_code = 200
    mock_resp.json.return_value = {"paymentKey": "pay_key_recovered", "status": "DONE", "totalAmount": 29000}

    with patch("app.services.payment.toss_adapter.settings") as mock_settings:
        mock_settings.toss_payments_secret_key = "test_sk_dummy"
        mock_client = AsyncMock()
        mock_client.__aenter__.return_value.get = AsyncMock(return_value=mock_resp)
        with patch("httpx.AsyncClient", return_value=mock_client):
            adapter = TossAdapter()
            result = await adapter.get_payment_by_order_id(order_id="ord-dup1")

    assert result["paymentKey"] == "pay_key_recovered"
    call_args = mock_client.__aenter__.return_value.get.call_args
    assert call_args.args[0].endswith("/v1/payments/orders/ord-dup1")


@pytest.mark.anyio
async def test_toss_get_payment_by_order_id_error_logs_error_by_default(caplog):
    """story #2913 후속(페드루군 2026-08-22 라이브 실측) — 어댑터는 호출자를 모르므로
    기본값(quiet_codes 미지정)은 기존 그대로 ERROR. billing_reconciliation.py(confirmed
    order가 Toss에 없다=원장 무결성 이상)·billing_charge.py(DUPLICATED_ORDER_ID 뒤
    조회, 실시간 결제 경로) 둘 다 이 기본값을 그대로 쓰므로 이 회귀가 그 두 곳의 ERROR
    가시성을 보장한다."""
    import logging

    from app.services.payment.toss_adapter import TossAdapter, TossApiError

    mock_resp = MagicMock()
    mock_resp.status_code = 404
    mock_resp.headers = {"content-type": "application/json"}
    mock_resp.json.return_value = {"code": "NOT_FOUND_PAYMENT", "message": "not found"}

    with patch("app.services.payment.toss_adapter.settings") as mock_settings:
        mock_settings.toss_payments_secret_key = "test_sk_dummy"
        mock_client = AsyncMock()
        mock_client.__aenter__.return_value.get = AsyncMock(return_value=mock_resp)
        with patch("httpx.AsyncClient", return_value=mock_client):
            adapter = TossAdapter()
            with caplog.at_level(logging.INFO):
                with pytest.raises(TossApiError):
                    await adapter.get_payment_by_order_id(order_id="ord-x")

    assert any(
        r.levelno == logging.ERROR and "NOT_FOUND_PAYMENT" in r.getMessage()
        for r in caplog.records
    )


@pytest.mark.anyio
async def test_toss_get_payment_by_order_id_quiet_codes_downgrades_to_info(caplog):
    """story #2913 후속 — 호출자(sweep_stale_pending_orders)가 명시적으로 quiet_codes에
    NOT_FOUND_PAYMENT를 넣으면 어댑터 자신의 ERROR 한 줄이 INFO로 낮아진다(2896 라이브
    실측: billing_scheduler.py가 이미 자체 INFO를 남기는데 그 위에 어댑터가 또 ERROR를
    찍어 "일 단위 ERROR 반복"이 실제로는 안 없어졌던 잔여를 여기서 닫는다)."""
    import logging

    from app.services.payment.toss_adapter import TossAdapter, TossApiError

    mock_resp = MagicMock()
    mock_resp.status_code = 404
    mock_resp.headers = {"content-type": "application/json"}
    mock_resp.json.return_value = {"code": "NOT_FOUND_PAYMENT", "message": "not found"}

    with patch("app.services.payment.toss_adapter.settings") as mock_settings:
        mock_settings.toss_payments_secret_key = "test_sk_dummy"
        mock_client = AsyncMock()
        mock_client.__aenter__.return_value.get = AsyncMock(return_value=mock_resp)
        with patch("httpx.AsyncClient", return_value=mock_client):
            adapter = TossAdapter()
            with caplog.at_level(logging.INFO):
                with pytest.raises(TossApiError):
                    await adapter.get_payment_by_order_id(
                        order_id="ord-x", quiet_codes=frozenset({"NOT_FOUND_PAYMENT"}),
                    )

    assert not any(r.levelno == logging.ERROR for r in caplog.records), "quiet_codes 지정 시 ERROR가 찍히면 안 됨"
    assert any(
        r.levelno == logging.INFO and "NOT_FOUND_PAYMENT" in r.getMessage()
        for r in caplog.records
    ), "quiet_codes 지정 시 INFO로 대체 기록돼야 함"


# ─── charge_org — 원자적 claim + orderId-먼저-기록 오케스트레이션 ──────────

def _mock_billing_key_row(*, org_id: uuid.UUID):
    row = MagicMock()
    row.org_id = org_id
    row.status = "active"
    row.customer_key = "cust_existing"
    row.encrypted_billing_key = "enc-token"
    return row


def _claimed_result(rowcount: int) -> MagicMock:
    r = MagicMock()
    r.rowcount = rowcount
    return r


def _row_result(row) -> MagicMock:
    r = MagicMock()
    r.scalar_one_or_none.return_value = row
    r.scalar_one.return_value = row
    return r


@pytest.mark.anyio
async def test_charge_org_rejects_non_positive_amount():
    from app.services.billing_charge import charge_org

    session = AsyncMock()
    with pytest.raises(ValueError, match="amount_minor"):
        await charge_org(session, org_id=uuid.uuid4(), order_id="ord-x", amount_minor=0, currency="krw")
    session.execute.assert_not_awaited()


@pytest.mark.anyio
async def test_charge_org_confirmed_order_short_circuits_no_toss_call(monkeypatch):
    """진짜 멱등 — claim이 conflict(rowcount=0)나고 기존 행이 confirmed면 Toss를 안 부른다."""
    from app.models.billing_order import BillingOrder
    import app.services.billing_charge as svc

    confirmed_row = MagicMock(spec=BillingOrder)
    confirmed_row.status = "confirmed"
    session = AsyncMock()
    session.execute = AsyncMock(side_effect=[_claimed_result(0), _row_result(confirmed_row)])

    charge_mock = AsyncMock()
    monkeypatch.setattr(svc.TossAdapter, "charge", charge_mock)

    result = await svc.charge_org(session, org_id=uuid.uuid4(), order_id="ord-dup", amount_minor=29000, currency="krw")

    assert result is confirmed_row
    charge_mock.assert_not_awaited()
    assert session.execute.await_count == 2  # claim(conflict) + 기존행 조회. 그 이상 안 감.


@pytest.mark.anyio
async def test_charge_org_pending_owned_by_other_returns_without_toss_call(monkeypatch):
    """블로커1 근본fix 확인 — claim에 지고 기존 행이 pending이면(다른 호출이 소유 중) 이
    호출은 끼어들지 않고 그대로 반환한다(동시 Toss 이중호출 원천 차단)."""
    from app.models.billing_order import BillingOrder
    import app.services.billing_charge as svc

    pending_row = MagicMock(spec=BillingOrder)
    pending_row.status = "pending"
    session = AsyncMock()
    session.execute = AsyncMock(side_effect=[_claimed_result(0), _row_result(pending_row)])

    charge_mock = AsyncMock()
    monkeypatch.setattr(svc.TossAdapter, "charge", charge_mock)

    result = await svc.charge_org(session, org_id=uuid.uuid4(), order_id="ord-inflight", amount_minor=29000, currency="krw")

    assert result is pending_row
    charge_mock.assert_not_awaited()


@pytest.mark.anyio
async def test_charge_org_failed_order_reclaimed_and_retried(monkeypatch):
    """failed였던 order는 CAS(failed→pending)로 재claim에 성공하면 재시도한다."""
    import app.services.billing_charge as svc

    org_id = uuid.uuid4()
    order_id = "ord-retry"
    failed_row = MagicMock()
    failed_row.status = "failed"
    billing_key_row = _mock_billing_key_row(org_id=org_id)
    confirmed_row = MagicMock()

    session = AsyncMock()
    session.execute = AsyncMock(side_effect=[
        _claimed_result(0),           # claim insert — 이미 존재(conflict)
        _row_result(failed_row),      # 기존 행 조회 — failed
        _claimed_result(1),           # CAS(failed→pending) 성공
        _row_result(billing_key_row),  # billing key 조회
        _row_result(confirmed_row),   # _confirm_with_ledger의 update
        _row_result(confirmed_row),   # _confirm_with_ledger의 refetch
    ])

    monkeypatch.setattr(svc, "ensure_configured", MagicMock())
    monkeypatch.setattr(svc, "decrypt_billing_key", MagicMock(return_value="plaintext_bk"))
    monkeypatch.setattr(svc.TossAdapter, "charge", AsyncMock(return_value={"paymentKey": "pay_retry_1"}))
    monkeypatch.setattr(svc, "record_ledger_entry", AsyncMock())

    result = await svc.charge_org(session, org_id=org_id, order_id=order_id, amount_minor=29000, currency="krw")

    assert result is confirmed_row
    svc.TossAdapter.charge.assert_awaited_once()


@pytest.mark.anyio
async def test_charge_org_failed_reclaim_race_lost_returns_existing(monkeypatch):
    """failed→pending CAS가 레이스에서 졌으면(다른 호출이 먼저 낚아챔) 이 호출은 포기하고
    현재 상태를 그대로 반환한다 — Toss를 부르지 않는다."""
    import app.services.billing_charge as svc

    other_owned_row = MagicMock()
    other_owned_row.status = "pending"

    session = AsyncMock()
    session.execute = AsyncMock(side_effect=[
        _claimed_result(0),
        _row_result(MagicMock(status="failed")),
        _claimed_result(0),  # CAS 레이스 패배
        _row_result(other_owned_row),
    ])

    charge_mock = AsyncMock()
    monkeypatch.setattr(svc.TossAdapter, "charge", charge_mock)

    result = await svc.charge_org(session, org_id=uuid.uuid4(), order_id="ord-race", amount_minor=29000, currency="krw")

    assert result is other_owned_row
    charge_mock.assert_not_awaited()


@pytest.mark.anyio
async def test_charge_org_no_active_billing_key_raises(monkeypatch):
    import app.services.billing_charge as svc

    org_id = uuid.uuid4()
    session = AsyncMock()
    session.execute = AsyncMock(side_effect=[
        _claimed_result(1),       # claim 성공(신규)
        _row_result(None),        # billing key 없음
        _claimed_result(0),       # _mark_failed_if_not_confirmed의 update
    ])

    monkeypatch.setattr(svc, "ensure_configured", MagicMock())

    with pytest.raises(RuntimeError, match="no active billing key"):
        await svc.charge_org(session, org_id=org_id, order_id="ord-x", amount_minor=29000, currency="krw")


@pytest.mark.anyio
async def test_charge_org_checks_crypto_before_calling_toss(monkeypatch):
    """PO nit①과 동형 규율 — claim에 성공한 뒤에도, Toss 호출 前에 crypto 가용성부터 확認."""
    import app.services.billing_charge as svc
    from app.services.billing_key_crypto import BillingKeyEncryptionNotConfigured

    org_id = uuid.uuid4()
    session = AsyncMock()
    session.execute = AsyncMock(side_effect=[_claimed_result(1)])

    monkeypatch.setattr(
        svc, "ensure_configured", MagicMock(side_effect=BillingKeyEncryptionNotConfigured("x"))
    )
    charge_mock = AsyncMock()
    monkeypatch.setattr(svc.TossAdapter, "charge", charge_mock)

    with pytest.raises(BillingKeyEncryptionNotConfigured):
        await svc.charge_org(session, org_id=org_id, order_id="ord-x", amount_minor=29000, currency="krw")

    charge_mock.assert_not_awaited()
    assert session.execute.await_count == 1  # claim(성공)만 — billing key 조회도 안 감.


@pytest.mark.anyio
async def test_charge_org_writes_pending_before_calling_toss(monkeypatch):
    """⭐orderId-먼저-기록 — 원자적 claim(INSERT) 자체가 Toss charge 호출 前에 커밋되는지
    순서를 직접 증명한다."""
    import app.services.billing_charge as svc

    org_id = uuid.uuid4()
    order_id = "ord-order1"
    billing_key_row = _mock_billing_key_row(org_id=org_id)
    final_row = MagicMock()

    session = AsyncMock()
    session.execute = AsyncMock(side_effect=[
        _claimed_result(1),          # ⭐claim insert(성공) — 가장 먼저.
        _row_result(billing_key_row),
        _row_result(final_row),      # _confirm_with_ledger의 confirmed update
        _row_result(final_row),      # _confirm_with_ledger의 refetch
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
    # 1번째 호출(claim)이 pg_insert INSERT..ON CONFLICT DO NOTHING이었는지 — Toss charge
    # 는 그 뒤에야(mock side_effect 순서가 이를 강제) 호출됨.
    claim_call = session.execute.call_args_list[0]
    compiled = claim_call.args[0].compile().params
    assert compiled["order_id"] == order_id
    assert compiled["status"] == "pending"

    # ⛔블로커2 순서 확인 — record_ledger_entry가 confirmed-update보다 먼저 불려야(코드
    # 순서상 항상 그렇지만, AsyncMock 호출 자체가 일어났는지+kwargs로 재확認).
    svc.record_ledger_entry.assert_awaited_once()
    ledger_kwargs = svc.record_ledger_entry.call_args.kwargs
    assert ledger_kwargs["provider_ref"] == "pay_key_xyz"
    assert ledger_kwargs["entry_type"] == "charge"

    confirmed_update_call = session.execute.call_args_list[2]
    update_compiled = confirmed_update_call.args[0].compile().params
    assert update_compiled["status"] == "confirmed"
    assert update_compiled["payment_key"] == "pay_key_xyz"


@pytest.mark.anyio
async def test_charge_org_toss_failure_marks_order_failed_and_reraises(monkeypatch):
    import app.services.billing_charge as svc
    from app.services.payment.toss_adapter import TossApiError

    org_id = uuid.uuid4()
    billing_key_row = _mock_billing_key_row(org_id=org_id)
    session = AsyncMock()
    session.execute = AsyncMock(side_effect=[
        _claimed_result(1), _row_result(billing_key_row), _claimed_result(1),
    ])

    monkeypatch.setattr(svc, "ensure_configured", MagicMock())
    monkeypatch.setattr(svc, "decrypt_billing_key", MagicMock(return_value="plaintext_bk"))
    monkeypatch.setattr(
        svc.TossAdapter, "charge",
        AsyncMock(side_effect=TossApiError("EXCEED_MAX_DAILY_PAYMENT_COUNT", "too many", status_code=400)),
    )
    monkeypatch.setattr(svc, "record_ledger_entry", AsyncMock())

    with pytest.raises(TossApiError, match="EXCEED_MAX_DAILY_PAYMENT_COUNT"):
        await svc.charge_org(session, org_id=org_id, order_id="ord-fail", amount_minor=29000, currency="krw")

    failed_call = session.execute.call_args_list[2]
    compiled = failed_call.args[0].compile().params
    assert compiled["status"] == "failed"
    assert "EXCEED_MAX_DAILY_PAYMENT_COUNT" in compiled["failure_reason"]
    svc.record_ledger_entry.assert_not_awaited()


@pytest.mark.anyio
async def test_charge_org_missing_payment_key_marks_failed(monkeypatch):
    """PO nit — Toss 응답에 paymentKey가 없으면(malformed) crash 대신 명시 failed."""
    import app.services.billing_charge as svc

    org_id = uuid.uuid4()
    billing_key_row = _mock_billing_key_row(org_id=org_id)
    session = AsyncMock()
    session.execute = AsyncMock(side_effect=[
        _claimed_result(1), _row_result(billing_key_row), _claimed_result(1),
    ])

    monkeypatch.setattr(svc, "ensure_configured", MagicMock())
    monkeypatch.setattr(svc, "decrypt_billing_key", MagicMock(return_value="plaintext_bk"))
    monkeypatch.setattr(svc.TossAdapter, "charge", AsyncMock(return_value={"status": "DONE"}))  # paymentKey 없음
    monkeypatch.setattr(svc, "record_ledger_entry", AsyncMock())

    with pytest.raises(RuntimeError, match="missing paymentKey"):
        await svc.charge_org(session, org_id=org_id, order_id="ord-malformed", amount_minor=29000, currency="krw")

    svc.record_ledger_entry.assert_not_awaited()


# ─── DUPLICATED_ORDER_ID — 재시도가 이미 성공한 charge를 다시 치는 케이스 ──

@pytest.mark.anyio
async def test_charge_org_duplicated_order_id_reconciles_as_success(monkeypatch):
    """⚠️PO 권장 처리 — DUPLICATED_ORDER_ID는 진짜 실패가 아니다. 조회해서 DONE이면
    confirmed+원장으로 매핑(failed로 오마킹하지 않는다)."""
    import app.services.billing_charge as svc
    from app.services.payment.toss_adapter import TossApiError

    org_id = uuid.uuid4()
    billing_key_row = _mock_billing_key_row(org_id=org_id)
    confirmed_row = MagicMock()
    session = AsyncMock()
    session.execute = AsyncMock(side_effect=[
        _claimed_result(1), _row_result(billing_key_row),
        _row_result(confirmed_row),  # _confirm_with_ledger의 update
        _row_result(confirmed_row),  # _confirm_with_ledger의 refetch
    ])

    monkeypatch.setattr(svc, "ensure_configured", MagicMock())
    monkeypatch.setattr(svc, "decrypt_billing_key", MagicMock(return_value="plaintext_bk"))
    monkeypatch.setattr(
        svc.TossAdapter, "charge",
        AsyncMock(side_effect=TossApiError("DUPLICATED_ORDER_ID", "dup", status_code=400)),
    )
    monkeypatch.setattr(
        svc.TossAdapter, "get_payment_by_order_id",
        AsyncMock(return_value={"status": "DONE", "paymentKey": "pay_recovered"}),
    )
    monkeypatch.setattr(svc, "record_ledger_entry", AsyncMock())

    result = await svc.charge_org(session, org_id=org_id, order_id="ord-dup2", amount_minor=29000, currency="krw")

    assert result is confirmed_row
    svc.record_ledger_entry.assert_awaited_once()
    assert svc.record_ledger_entry.call_args.kwargs["provider_ref"] == "pay_recovered"


@pytest.mark.anyio
async def test_charge_org_duplicated_order_id_not_done_marks_failed(monkeypatch):
    """조회 결과가 DONE이 아니면(취소 등) — 이번엔 진짜 failed로 정합."""
    import app.services.billing_charge as svc
    from app.services.payment.toss_adapter import TossApiError

    org_id = uuid.uuid4()
    billing_key_row = _mock_billing_key_row(org_id=org_id)
    failed_row = MagicMock()
    failed_row.status = "failed"
    session = AsyncMock()
    session.execute = AsyncMock(side_effect=[
        _claimed_result(1), _row_result(billing_key_row),
        _claimed_result(1),  # _mark_failed_if_not_confirmed
        _row_result(failed_row),  # refetch
    ])

    monkeypatch.setattr(svc, "ensure_configured", MagicMock())
    monkeypatch.setattr(svc, "decrypt_billing_key", MagicMock(return_value="plaintext_bk"))
    monkeypatch.setattr(
        svc.TossAdapter, "charge",
        AsyncMock(side_effect=TossApiError("DUPLICATED_ORDER_ID", "dup", status_code=400)),
    )
    monkeypatch.setattr(
        svc.TossAdapter, "get_payment_by_order_id",
        AsyncMock(return_value={"status": "CANCELED"}),
    )
    monkeypatch.setattr(svc, "record_ledger_entry", AsyncMock())

    result = await svc.charge_org(session, org_id=org_id, order_id="ord-dup3", amount_minor=29000, currency="krw")

    assert result.status == "failed"
    svc.record_ledger_entry.assert_not_awaited()


# ─── story #3209 PR-2 — _confirm_with_ledger의 결제 완료 메일 배선 ──────────

def _rowcount_result(rowcount: int, refetch_row=None) -> MagicMock:
    """update() 실행 결과 mock — rowcount만 쓴다(_claimed_result와 동형, 이름만 이 파일
    문맥에 맞게)."""
    r = MagicMock()
    r.rowcount = rowcount
    return r


@pytest.mark.anyio
async def test_confirm_with_ledger_sends_receipt_email_on_first_confirmation(monkeypatch):
    """rowcount==1(실제로 이번 호출이 confirmed로 전이시킴)이면 결제 완료 메일을 정확한
    kwargs로 1회 발송한다."""
    import app.services.billing_charge as svc
    import app.services.billing_receipt_email as email_svc

    org_id = uuid.uuid4()
    confirmed_row = MagicMock()
    session = AsyncMock()
    session.execute = AsyncMock(side_effect=[_rowcount_result(1), _row_result(confirmed_row)])

    monkeypatch.setattr(svc, "record_ledger_entry", AsyncMock())
    send_mock = AsyncMock()
    monkeypatch.setattr(email_svc, "send_payment_receipt_email", send_mock)

    result = await svc._confirm_with_ledger(
        session, org_id=org_id, order_id="ord-1", amount_minor=49000, currency="krw",
        payment_key="pay_1", receipt_url="https://dashboard.tosspayments.com/receipt/abc",
    )

    assert result is confirmed_row
    send_mock.assert_awaited_once_with(
        session, org_id=org_id, receipt_url="https://dashboard.tosspayments.com/receipt/abc",
        amount_minor=49000, currency="krw",
    )


@pytest.mark.anyio
async def test_confirm_with_ledger_skips_email_on_idempotent_reentry(monkeypatch):
    """rowcount==0(이미 confirmed였던 order — 재시도/중복 진입)이면 재발송하지 않는다.
    별도 dedup 플래그 없이 claim/confirmed-update의 WHERE 가드 자체가 이 신호다."""
    import app.services.billing_charge as svc
    import app.services.billing_receipt_email as email_svc

    org_id = uuid.uuid4()
    already_confirmed_row = MagicMock()
    session = AsyncMock()
    session.execute = AsyncMock(side_effect=[_rowcount_result(0), _row_result(already_confirmed_row)])

    monkeypatch.setattr(svc, "record_ledger_entry", AsyncMock())
    send_mock = AsyncMock()
    monkeypatch.setattr(email_svc, "send_payment_receipt_email", send_mock)

    result = await svc._confirm_with_ledger(
        session, org_id=org_id, order_id="ord-2", amount_minor=49000, currency="krw",
        payment_key="pay_2", receipt_url="https://dashboard.tosspayments.com/receipt/xyz",
    )

    assert result is already_confirmed_row
    send_mock.assert_not_awaited()


@pytest.mark.anyio
async def test_confirm_with_ledger_email_failure_does_not_break_confirmation(monkeypatch):
    """메일 발송 실패(예외)가 결제 확정 자체를 되돌리지 않는다 — 돈은 이미 움직였다."""
    import app.services.billing_charge as svc
    import app.services.billing_receipt_email as email_svc

    org_id = uuid.uuid4()
    confirmed_row = MagicMock()
    session = AsyncMock()
    session.execute = AsyncMock(side_effect=[_rowcount_result(1), _row_result(confirmed_row)])

    monkeypatch.setattr(svc, "record_ledger_entry", AsyncMock())
    monkeypatch.setattr(email_svc, "send_payment_receipt_email", AsyncMock(side_effect=RuntimeError("smtp down")))

    result = await svc._confirm_with_ledger(
        session, org_id=org_id, order_id="ord-3", amount_minor=49000, currency="krw",
        payment_key="pay_3", receipt_url="https://dashboard.tosspayments.com/receipt/qwe",
    )

    assert result is confirmed_row  # 예외가 새지 않고, confirmed 결과가 그대로 반환된다.
