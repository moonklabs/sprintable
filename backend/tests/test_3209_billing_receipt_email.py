"""story #3209(PR-2) — send_payment_receipt_email 단위 테스트.
cron.py의 storage/AU 경고 메일 발송 패턴(수신자=owner/admin 전원, 개별 locale, 개별
실패 격리)과 동형 관례를 그대로 따르는지 고정한다."""
from __future__ import annotations

import uuid
from unittest.mock import AsyncMock, MagicMock, patch

import pytest


@pytest.mark.anyio
async def test_skips_entirely_when_receipt_url_is_none():
    """receipt_url이 없으면(Toss 응답에 receipt 필드 자체가 없는 극히 드문 케이스) 조회도
    발송도 안 한다 — CTA 없는 메일을 지어내지 않는다."""
    from app.services.billing_receipt_email import send_payment_receipt_email

    session = AsyncMock()
    with patch("app.services.billing_receipt_email.send_email") as send_email_mock:
        await send_payment_receipt_email(
            session, org_id=uuid.uuid4(), receipt_url=None, amount_minor=49000, currency="krw",
        )
    session.execute.assert_not_awaited()
    send_email_mock.assert_not_called()


@pytest.mark.anyio
async def test_sends_to_owner_admin_recipients_with_per_recipient_locale():
    """owner/admin 전원에게, 각자의 locale로 발송한다(cron.py storage/AU 경고와 동형)."""
    from app.services.billing_receipt_email import send_payment_receipt_email

    org_id = uuid.uuid4()
    session = AsyncMock()
    recipients_result = MagicMock()
    recipients_result.all.return_value = [
        ("owner@example.com", "ko"),
        ("admin@example.com", "en"),
    ]
    session.execute = AsyncMock(return_value=recipients_result)

    with patch("app.services.billing_receipt_email.send_email") as send_email_mock, \
         patch("app.services.billing_receipt_email.asyncio.to_thread", new=AsyncMock(side_effect=lambda fn, *a: fn(*a))):
        await send_payment_receipt_email(
            session, org_id=org_id, receipt_url="https://dashboard.tosspayments.com/receipt/abc",
            amount_minor=49000, currency="krw",
        )

    assert send_email_mock.call_count == 2
    ko_call = next(c for c in send_email_mock.call_args_list if c.args[0] == "owner@example.com")
    en_call = next(c for c in send_email_mock.call_args_list if c.args[0] == "admin@example.com")
    assert ko_call.args[1] == "Sprintable 결제가 완료됐습니다"
    assert "49,000원" in ko_call.args[2]
    assert "https://dashboard.tosspayments.com/receipt/abc" in ko_call.args[2]
    assert en_call.args[1] == "Your Sprintable payment is complete"
    assert "₩49,000" in en_call.args[2]


@pytest.mark.anyio
async def test_one_recipient_send_failure_does_not_block_the_other():
    """한 명 발송 실패가 나머지 발송을 막지 않는다(개별 로그만, cron.py 경고 메일과 동형)."""
    from app.services.billing_receipt_email import send_payment_receipt_email

    org_id = uuid.uuid4()
    session = AsyncMock()
    recipients_result = MagicMock()
    recipients_result.all.return_value = [
        ("fails@example.com", "ko"),
        ("ok@example.com", "ko"),
    ]
    session.execute = AsyncMock(return_value=recipients_result)

    async def _to_thread(fn, *args):
        if args[0] == "fails@example.com":
            raise RuntimeError("smtp down")
        return fn(*args)

    with patch("app.services.billing_receipt_email.send_email") as send_email_mock, \
         patch("app.services.billing_receipt_email.asyncio.to_thread", new=AsyncMock(side_effect=_to_thread)):
        await send_payment_receipt_email(
            session, org_id=org_id, receipt_url="https://dashboard.tosspayments.com/receipt/abc",
            amount_minor=49000, currency="krw",
        )

    ok_calls = [c for c in send_email_mock.call_args_list if c.args[0] == "ok@example.com"]
    assert len(ok_calls) == 1
