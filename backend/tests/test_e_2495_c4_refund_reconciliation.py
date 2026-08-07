"""#2495(C4) — 환불(refund) + 일일 대사(reconciliation) + BILLING_DELETED 보조 웹훅.
PO 계약(2026-08-07): webhook 서명은 secret 있으면 필수·없으면 dev한정 통과(BILLING_DELETED
write가 멱등이라 안전한 폴백)."""
from __future__ import annotations

import hashlib
import hmac
import json
import uuid
from datetime import datetime, timedelta, timezone
from unittest.mock import AsyncMock, MagicMock, patch

import pytest


def _order(*, status="confirmed", payment_key="pay_123", amount_minor=59_000, currency="krw", org_id=None, created_days_ago=0, now=None):
    now = now or datetime.now(timezone.utc)
    o = MagicMock()
    o.org_id = org_id or uuid.uuid4()
    o.order_id = f"ord-{uuid.uuid4()}"
    o.status = status
    o.payment_key = payment_key
    o.amount_minor = amount_minor
    o.currency = currency
    o.created_at = now - timedelta(days=created_days_ago)
    return o


def _exec_result(scalar_value):
    r = MagicMock()
    r.scalar_one_or_none.return_value = scalar_value
    return r


def _scalars_result(items):
    r = MagicMock()
    r.scalars.return_value.all.return_value = items
    return r


# ─── TossAdapter.refund ──────────────────────────────────────────────────────

@pytest.mark.anyio
async def test_toss_adapter_refund_posts_cancel_with_reason_and_idempotency_key():
    from app.services.payment.toss_adapter import TossAdapter

    adapter = TossAdapter()
    with patch.object(adapter, "_post", new=AsyncMock(return_value={"cancels": [{"transactionKey": "tx-1", "cancelAmount": 59_000}]})) as mock_post:
        result = await adapter.refund(
            payment_key="pay_123", cancel_reason="고객 요청", idempotency_key="refund:ord-1",
        )

    assert result["cancels"][0]["transactionKey"] == "tx-1"
    mock_post.assert_awaited_once()
    call = mock_post.await_args
    assert call.args[0] == "/v1/payments/pay_123/cancel"
    assert call.kwargs["json"] == {"cancelReason": "고객 요청"}
    assert call.kwargs["idempotency_key"] == "refund:ord-1"


@pytest.mark.anyio
async def test_toss_adapter_refund_includes_cancel_amount_when_partial():
    from app.services.payment.toss_adapter import TossAdapter

    adapter = TossAdapter()
    with patch.object(adapter, "_post", new=AsyncMock(return_value={"cancels": []})) as mock_post:
        await adapter.refund(
            payment_key="pay_123", cancel_reason="부분환불", cancel_amount_minor=10_000,
            idempotency_key="refund:ord-2",
        )

    assert mock_post.await_args.kwargs["json"] == {"cancelReason": "부분환불", "cancelAmount": 10_000}


# ─── TossAdapter.verify_webhook ──────────────────────────────────────────────

def test_verify_webhook_passes_when_secret_unset_dev_fallback(monkeypatch):
    from app.services.payment.toss_adapter import TossAdapter
    import app.core.config as config_module

    monkeypatch.setattr(config_module.settings, "toss_webhook_secret", "")
    assert TossAdapter().verify_webhook(b'{"eventType":"BILLING_DELETED"}', None) is True


def test_verify_webhook_rejects_missing_signature_when_secret_set(monkeypatch):
    from app.services.payment.toss_adapter import TossAdapter
    import app.core.config as config_module

    monkeypatch.setattr(config_module.settings, "toss_webhook_secret", "shh")
    assert TossAdapter().verify_webhook(b"body", None) is False


def test_verify_webhook_rejects_wrong_signature_when_secret_set(monkeypatch):
    from app.services.payment.toss_adapter import TossAdapter
    import app.core.config as config_module

    monkeypatch.setattr(config_module.settings, "toss_webhook_secret", "shh")
    assert TossAdapter().verify_webhook(b"body", "wrong-signature") is False


def test_verify_webhook_accepts_correct_hmac_signature_positive_control(monkeypatch):
    """양성대조 — 진짜 서명은 통과해야(위 거부 테스트들이 «항상 거부»로 무의미해지지 않게)."""
    from app.services.payment.toss_adapter import TossAdapter
    import app.core.config as config_module

    monkeypatch.setattr(config_module.settings, "toss_webhook_secret", "shh")
    body = b'{"eventType":"BILLING_DELETED"}'
    expected = hmac.new(b"shh", body, hashlib.sha256).hexdigest()
    assert TossAdapter().verify_webhook(body, expected) is True


# ─── refund_org ───────────────────────────────────────────────────────────

@pytest.mark.anyio
async def test_refund_org_full_refund_records_debit_ledger_entry():
    from app.services.billing_refund import refund_org

    org_id = uuid.uuid4()
    order = _order(org_id=org_id, status="confirmed", amount_minor=59_000)
    session = AsyncMock()
    session.execute = AsyncMock(return_value=_exec_result(order))

    toss_result = {"cancels": [{"transactionKey": "tx-abc", "cancelAmount": 59_000}]}
    entry = MagicMock()
    with patch("app.services.billing_refund.TossAdapter") as MockAdapter, \
         patch("app.services.billing_refund.record_ledger_entry", new=AsyncMock(return_value=entry)) as mock_record:
        MockAdapter.return_value.refund = AsyncMock(return_value=toss_result)
        result = await refund_org(session, org_id=org_id, order_id=order.order_id, cancel_reason="고객 요청")

    assert result is entry
    mock_record.assert_awaited_once()
    kwargs = mock_record.await_args.kwargs
    assert kwargs["entry_type"] == "refund"
    assert kwargs["direction"] == "debit"
    assert kwargs["amount_minor"] == 59_000
    assert kwargs["provider_ref"] == "tx-abc"


@pytest.mark.anyio
async def test_refund_org_uses_deterministic_idempotency_key():
    from app.services.billing_refund import refund_org

    org_id = uuid.uuid4()
    order = _order(org_id=org_id, status="confirmed")
    session = AsyncMock()
    session.execute = AsyncMock(return_value=_exec_result(order))

    with patch("app.services.billing_refund.TossAdapter") as MockAdapter, \
         patch("app.services.billing_refund.record_ledger_entry", new=AsyncMock()):
        MockAdapter.return_value.refund = AsyncMock(
            return_value={"cancels": [{"transactionKey": "tx-1", "cancelAmount": order.amount_minor}]}
        )
        await refund_org(session, org_id=org_id, order_id=order.order_id, cancel_reason="r")

    call_kwargs = MockAdapter.return_value.refund.await_args.kwargs
    assert call_kwargs["idempotency_key"] == f"refund:{order.order_id}"


@pytest.mark.anyio
async def test_refund_org_raises_when_order_not_found():
    from app.services.billing_refund import RefundError, refund_org

    session = AsyncMock()
    session.execute = AsyncMock(return_value=_exec_result(None))

    with pytest.raises(RefundError, match="no billing_order"):
        await refund_org(session, org_id=uuid.uuid4(), order_id="missing", cancel_reason="r")


@pytest.mark.anyio
async def test_refund_org_raises_when_order_belongs_to_different_org():
    from app.services.billing_refund import RefundError, refund_org

    order = _order(org_id=uuid.uuid4(), status="confirmed")
    session = AsyncMock()
    session.execute = AsyncMock(return_value=_exec_result(order))

    with pytest.raises(RefundError, match="does not belong"):
        await refund_org(session, org_id=uuid.uuid4(), order_id=order.order_id, cancel_reason="r")


@pytest.mark.anyio
async def test_refund_org_raises_when_order_not_confirmed():
    from app.services.billing_refund import RefundError, refund_org

    org_id = uuid.uuid4()
    order = _order(org_id=org_id, status="pending")
    session = AsyncMock()
    session.execute = AsyncMock(return_value=_exec_result(order))

    with pytest.raises(RefundError, match="not a confirmed charge"):
        await refund_org(session, org_id=org_id, order_id=order.order_id, cancel_reason="r")


@pytest.mark.anyio
async def test_refund_org_raises_when_partial_amount_exceeds_original():
    from app.services.billing_refund import RefundError, refund_org

    org_id = uuid.uuid4()
    order = _order(org_id=org_id, status="confirmed", amount_minor=10_000)
    session = AsyncMock()
    session.execute = AsyncMock(return_value=_exec_result(order))

    with pytest.raises(RefundError, match="exceeds original"):
        await refund_org(session, org_id=org_id, order_id=order.order_id, cancel_reason="r", cancel_amount_minor=20_000)


@pytest.mark.anyio
async def test_refund_org_raises_when_toss_response_missing_cancels():
    from app.services.billing_refund import RefundError, refund_org

    org_id = uuid.uuid4()
    order = _order(org_id=org_id, status="confirmed")
    session = AsyncMock()
    session.execute = AsyncMock(return_value=_exec_result(order))

    with patch("app.services.billing_refund.TossAdapter") as MockAdapter:
        MockAdapter.return_value.refund = AsyncMock(return_value={"cancels": []})
        with pytest.raises(RefundError, match="missing cancels"):
            await refund_org(session, org_id=org_id, order_id=order.order_id, cancel_reason="r")


# ─── mark_billing_key_deleted ────────────────────────────────────────────────

@pytest.mark.anyio
async def test_mark_billing_key_deleted_is_idempotent_update():
    from app.services.org_billing_key import mark_billing_key_deleted

    session = AsyncMock()
    session.execute = AsyncMock()
    session.commit = AsyncMock()

    await mark_billing_key_deleted(session, customer_key="cust-1")

    session.execute.assert_awaited_once()
    compiled = session.execute.await_args.args[0].compile().params
    assert compiled["status"] == "deleted"
    session.commit.assert_awaited_once()


# ─── daily_reconcile_confirmed_orders ────────────────────────────────────────

@pytest.mark.anyio
async def test_reconciliation_matched_order_writes_no_adjustment():
    from app.services.billing_reconciliation import daily_reconcile_confirmed_orders

    now = datetime(2026, 8, 15, tzinfo=timezone.utc)
    order = _order(amount_minor=59_000, created_days_ago=1, now=now)
    session = AsyncMock()
    session.execute = AsyncMock(return_value=_scalars_result([order]))

    with patch("app.services.billing_reconciliation.TossAdapter") as MockAdapter, \
         patch("app.services.billing_reconciliation.record_ledger_entry", new=AsyncMock()) as mock_record:
        MockAdapter.return_value.get_payment_by_order_id = AsyncMock(
            return_value={"status": "DONE", "totalAmount": 59_000}
        )
        result = await daily_reconcile_confirmed_orders(session, now=now)

    assert result == {"orders_checked": 1, "matched": 1, "mismatched": 0, "skipped_lookup_error": 0}
    mock_record.assert_not_awaited()


@pytest.mark.anyio
async def test_reconciliation_mismatch_writes_adjustment_entry():
    from app.services.billing_reconciliation import daily_reconcile_confirmed_orders

    now = datetime(2026, 8, 15, tzinfo=timezone.utc)
    order = _order(amount_minor=59_000, created_days_ago=1, now=now)
    session = AsyncMock()
    session.execute = AsyncMock(return_value=_scalars_result([order]))

    with patch("app.services.billing_reconciliation.TossAdapter") as MockAdapter, \
         patch("app.services.billing_reconciliation.record_ledger_entry", new=AsyncMock()) as mock_record:
        MockAdapter.return_value.get_payment_by_order_id = AsyncMock(
            return_value={"status": "DONE", "totalAmount": 49_000}  # Toss says less than we recorded
        )
        result = await daily_reconcile_confirmed_orders(session, now=now)

    assert result["mismatched"] == 1
    mock_record.assert_awaited_once()
    kwargs = mock_record.await_args.kwargs
    assert kwargs["entry_type"] == "adjustment"
    assert kwargs["amount_minor"] == 10_000
    assert kwargs["direction"] == "debit"  # toss(49k) - internal(59k) = -10k → debit
    assert kwargs["provider_ref"] == f"reconciliation-adjustment:{order.order_id}"


@pytest.mark.anyio
async def test_reconciliation_credit_direction_when_toss_amount_higher():
    from app.services.billing_reconciliation import daily_reconcile_confirmed_orders

    now = datetime(2026, 8, 15, tzinfo=timezone.utc)
    order = _order(amount_minor=59_000, created_days_ago=1, now=now)
    session = AsyncMock()
    session.execute = AsyncMock(return_value=_scalars_result([order]))

    with patch("app.services.billing_reconciliation.TossAdapter") as MockAdapter, \
         patch("app.services.billing_reconciliation.record_ledger_entry", new=AsyncMock()) as mock_record:
        MockAdapter.return_value.get_payment_by_order_id = AsyncMock(
            return_value={"status": "DONE", "totalAmount": 69_000}
        )
        await daily_reconcile_confirmed_orders(session, now=now)

    assert mock_record.await_args.kwargs["direction"] == "credit"
    assert mock_record.await_args.kwargs["amount_minor"] == 10_000


@pytest.mark.anyio
async def test_reconciliation_leaves_order_unflagged_on_transient_lookup_error():
    """PO 확認 패턴(C3 fix-forward①과 동형) — 조회 실패는 불일치가 아니다, 매번 회귀
    확인만 skipped로 세고 adjustment는 안 쓴다."""
    from app.services.billing_reconciliation import daily_reconcile_confirmed_orders

    now = datetime(2026, 8, 15, tzinfo=timezone.utc)
    order = _order(created_days_ago=1, now=now)
    session = AsyncMock()
    session.execute = AsyncMock(return_value=_scalars_result([order]))

    with patch("app.services.billing_reconciliation.TossAdapter") as MockAdapter, \
         patch("app.services.billing_reconciliation.record_ledger_entry", new=AsyncMock()) as mock_record:
        MockAdapter.return_value.get_payment_by_order_id = AsyncMock(side_effect=RuntimeError("network"))
        result = await daily_reconcile_confirmed_orders(session, now=now)

    assert result == {"orders_checked": 1, "matched": 0, "mismatched": 0, "skipped_lookup_error": 1}
    mock_record.assert_not_awaited()


@pytest.mark.anyio
async def test_reconciliation_treats_not_done_status_as_mismatch():
    """Toss가 이 orderId를 DONE이 아닌 상태로 안다면(CANCELED 등) 우리 confirmed와
    어긋난 신호 — adjustment로 기입."""
    from app.services.billing_reconciliation import daily_reconcile_confirmed_orders

    now = datetime(2026, 8, 15, tzinfo=timezone.utc)
    order = _order(amount_minor=59_000, created_days_ago=1, now=now)
    session = AsyncMock()
    session.execute = AsyncMock(return_value=_scalars_result([order]))

    with patch("app.services.billing_reconciliation.TossAdapter") as MockAdapter, \
         patch("app.services.billing_reconciliation.record_ledger_entry", new=AsyncMock()) as mock_record:
        MockAdapter.return_value.get_payment_by_order_id = AsyncMock(
            return_value={"status": "CANCELED"}
        )
        result = await daily_reconcile_confirmed_orders(session, now=now)

    assert result["mismatched"] == 1
    assert mock_record.await_args.kwargs["amount_minor"] == 59_000
    assert mock_record.await_args.kwargs["direction"] == "debit"


# ─── toss_webhook router ──────────────────────────────────────────────────

@pytest.mark.anyio
async def test_toss_webhook_billing_deleted_marks_key_deleted(monkeypatch):
    from fastapi.testclient import TestClient
    import app.core.config as config_module
    from app.main import app
    from tests.conftest import override_db_and_read

    monkeypatch.setattr(config_module.settings, "toss_webhook_secret", "")  # dev 통과

    fake_session = AsyncMock()

    async def _override_get_db():
        yield fake_session

    # story #2451(§6 Phase3 root-fix): get_db+get_read_db 항상 같이 거는 공용 헬퍼.
    override_db_and_read(app, _override_get_db)
    try:
        with patch("app.routers.toss_webhooks.mark_billing_key_deleted", new=AsyncMock()) as mock_mark:
            with TestClient(app) as client:
                resp = client.post(
                    "/api/v2/webhooks/toss",
                    content=json.dumps({"eventType": "BILLING_DELETED", "data": {"customerKey": "cust-1"}}),
                    headers={"Content-Type": "application/json"},
                )
        assert resp.status_code == 200
        mock_mark.assert_awaited_once_with(fake_session, customer_key="cust-1")
    finally:
        app.dependency_overrides.clear()


@pytest.mark.anyio
async def test_toss_webhook_rejects_invalid_signature_when_secret_set(monkeypatch):
    from fastapi.testclient import TestClient
    import app.core.config as config_module
    from app.main import app
    from tests.conftest import override_db_and_read

    monkeypatch.setattr(config_module.settings, "toss_webhook_secret", "shh")

    async def _override_get_db():
        yield AsyncMock()

    override_db_and_read(app, _override_get_db)
    try:
        with TestClient(app) as client:
            resp = client.post(
                "/api/v2/webhooks/toss",
                content=json.dumps({"eventType": "BILLING_DELETED", "data": {}}),
                headers={"Content-Type": "application/json", "TossPayments-Signature": "wrong"},
            )
        assert resp.status_code == 401
    finally:
        app.dependency_overrides.clear()


@pytest.mark.anyio
async def test_toss_webhook_ignores_unknown_event_type(monkeypatch):
    from fastapi.testclient import TestClient
    import app.core.config as config_module
    from app.main import app
    from tests.conftest import override_db_and_read

    monkeypatch.setattr(config_module.settings, "toss_webhook_secret", "")

    async def _override_get_db():
        yield AsyncMock()

    override_db_and_read(app, _override_get_db)
    try:
        with patch("app.routers.toss_webhooks.mark_billing_key_deleted", new=AsyncMock()) as mock_mark:
            with TestClient(app) as client:
                resp = client.post(
                    "/api/v2/webhooks/toss",
                    content=json.dumps({"eventType": "PAYMENT_STATUS_CHANGED", "data": {}}),
                    headers={"Content-Type": "application/json"},
                )
        assert resp.status_code == 200
        mock_mark.assert_not_awaited()
    finally:
        app.dependency_overrides.clear()
