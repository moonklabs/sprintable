"""story #3207 — dunning(빌링 재시도)·구독 하향취소 자동취소 알림 2종의 locale 분기 pin.
#3205와 동형(email_copy.py 사전+resolve_locale), 순수 dict/DB 불요 부분과 mock 세션
부분을 나눠 검증한다."""
from __future__ import annotations

import uuid
from datetime import date
from unittest.mock import AsyncMock, MagicMock

import pytest


def test_dunning_copy_has_both_locales_and_required_fields():
    from app.services.email_copy import DUNNING_COPY

    for locale in ("ko", "en"):
        copy = DUNNING_COPY[locale]
        assert copy["subject"] and copy["greeting"] and copy["intro"]
        assert copy["grace_note"] and copy["cta_label"] and copy["closing"]
        # 동적 값 포맷 안 깨지는지.
        formatted = copy["grace_note"].format(grace_date="2026-09-01", tier_display="Team")
        assert "2026-09-01" in formatted and "Team" in formatted


def test_downgrade_auto_cancel_copy_has_both_locales_and_required_fields():
    from app.services.email_copy import DOWNGRADE_AUTO_CANCEL_COPY

    for locale in ("ko", "en"):
        copy = DOWNGRADE_AUTO_CANCEL_COPY[locale]
        assert copy["subject"] and copy["greeting"] and copy["body1"] and copy["body2"] and copy["closing"]
        formatted = copy["body1"].format(tier="team", seat_count=12, included_seats=10)
        assert "team" in formatted and "12" in formatted and "10" in formatted


def test_dunning_email_content_locale_branch_and_shell_wrapped():
    from app.services.billing_scheduler import _dunning_email_content

    ko_subject, ko_html = _dunning_email_content(tier="team", grace_expires_at=date(2026, 9, 1), locale="ko")
    en_subject, en_html = _dunning_email_content(tier="team", grace_expires_at=date(2026, 9, 1), locale="en")

    assert ko_subject == "[Sprintable] 결제가 처리되지 않았습니다 — 확인해 주세요"
    assert "안녕하세요, Sprintable입니다." in ko_html
    assert en_subject == "[Sprintable] Your payment couldn't be processed — please check"
    assert "Hello, this is Sprintable." in en_html
    # story #3206 공용 셸 경유 확認(회사정보 푸터 존재).
    assert "주식회사 뭉클랩" in ko_html
    assert "주식회사 뭉클랩" in en_html
    assert 'lang="en"' in en_html


@pytest.mark.anyio
async def test_notify_dunning_failure_sends_locale_matched_copy_per_recipient(monkeypatch):
    import app.services.billing_scheduler as sched

    sent = []

    def _fake_send_email(to, subject, html):
        sent.append({"to": to, "subject": subject, "html": html})
        return True

    monkeypatch.setattr(sched, "send_email", _fake_send_email)

    result = MagicMock()
    result.all.return_value = [("ko@example.com", "ko"), ("en@example.com", "en")]
    session = AsyncMock()
    session.execute = AsyncMock(return_value=result)

    await sched._notify_dunning_failure(session, uuid.uuid4(), tier="team", grace_expires_at=date(2026, 9, 1))

    assert len(sent) == 2
    ko_sent = next(s for s in sent if s["to"] == "ko@example.com")
    en_sent = next(s for s in sent if s["to"] == "en@example.com")
    assert "결제가 처리되지 않았습니다" in ko_sent["subject"]
    assert "couldn't be processed" in en_sent["subject"]


@pytest.mark.anyio
async def test_notify_downgrade_auto_cancelled_sends_locale_matched_copy_per_recipient(monkeypatch):
    import app.services.org_subscription_downgrade as mod

    sent = []

    def _fake_send_email(to, subject, html):
        sent.append({"to": to, "subject": subject, "html": html})
        return True

    monkeypatch.setattr(mod, "send_email", _fake_send_email)

    result = MagicMock()
    result.all.return_value = [("ko@example.com", "ko"), ("en@example.com", None)]
    session = AsyncMock()
    session.execute = AsyncMock(return_value=result)

    await mod._notify_downgrade_auto_cancelled(
        session, org_id=uuid.uuid4(), tier="team", seat_count=12, included_seats=10,
    )

    assert len(sent) == 2
    ko_sent = next(s for s in sent if s["to"] == "ko@example.com")
    en_sent = next(s for s in sent if s["to"] == "en@example.com")
    # locale=None → resolve_locale이 DEFAULT_LOCALE(ko)로 폴백.
    assert "취소되었습니다" in ko_sent["subject"]
    assert "취소되었습니다" in en_sent["subject"]
    assert "주식회사 뭉클랩" in ko_sent["html"]
