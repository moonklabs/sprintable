"""story #3212 — 구독 취소/하향 «예약 확인»+«적용 완료» 메일. #3207(dunning/auto-cancel
locale)과 동형 mocking 관례 — 무효 오라클 방지 위해 ko/en 수신자를 실제로 다른 값으로 넣는다."""
from __future__ import annotations

import uuid
from datetime import datetime, timezone
from unittest.mock import AsyncMock, MagicMock

import pytest


def _locale_result(rows: list[tuple[str, str | None]]) -> MagicMock:
    r = MagicMock()
    r.all.return_value = rows
    return r


# ── _notify_downgrade_reserved — 카피/locale 내용 ────────────────────────────

@pytest.mark.anyio
async def test_notify_downgrade_reserved_downgrade_variant_locale_matched(monkeypatch):
    import app.services.org_subscription_downgrade as mod

    sent = []
    monkeypatch.setattr(mod, "send_email", lambda to, subject, html: sent.append({"to": to, "subject": subject, "html": html}))

    session = AsyncMock()
    session.execute = AsyncMock(return_value=_locale_result([("ko@example.com", "ko"), ("en@example.com", "en")]))

    await mod._notify_downgrade_reserved(
        session, org_id=uuid.uuid4(), new_tier="starter",
        apply_at=datetime(2026, 9, 29, tzinfo=timezone.utc), is_cancellation=False,
    )

    assert len(sent) == 2
    ko_sent = next(s for s in sent if s["to"] == "ko@example.com")
    en_sent = next(s for s in sent if s["to"] == "en@example.com")
    assert ko_sent["subject"] == "[Sprintable] Starter 플랜으로 변경이 예약됐습니다"
    assert "2026-09-29" in ko_sent["html"]
    assert "plan change to Starter is scheduled" in en_sent["subject"]
    # CTA(철회 링크)가 빌링 설정 페이지를 가리킨다 — 새 원클릭 엔드포인트 발명 없음.
    assert "/settings?tab=billing" in ko_sent["html"]


@pytest.mark.anyio
async def test_notify_downgrade_reserved_cancellation_variant_uses_cancel_copy(monkeypatch):
    import app.services.org_subscription_downgrade as mod

    sent = []
    monkeypatch.setattr(mod, "send_email", lambda to, subject, html: sent.append({"to": to, "subject": subject, "html": html}))

    session = AsyncMock()
    session.execute = AsyncMock(return_value=_locale_result([("owner@example.com", "ko")]))

    await mod._notify_downgrade_reserved(
        session, org_id=uuid.uuid4(), new_tier="free",
        apply_at=datetime(2026, 9, 29, tzinfo=timezone.utc), is_cancellation=True,
    )

    assert len(sent) == 1
    assert sent[0]["subject"] == "[Sprintable] 구독 해지가 예약됐습니다"
    assert "Free 플랜으로 전환됩니다" in sent[0]["html"]


@pytest.mark.anyio
async def test_notify_downgrade_reserved_one_recipient_failure_does_not_block_others(monkeypatch):
    import app.services.org_subscription_downgrade as mod

    sent = []

    def _send(to, subject, html):
        if to == "fails@example.com":
            raise RuntimeError("smtp down")
        sent.append(to)

    monkeypatch.setattr(mod, "send_email", _send)
    session = AsyncMock()
    session.execute = AsyncMock(return_value=_locale_result([("fails@example.com", "ko"), ("ok@example.com", "ko")]))

    await mod._notify_downgrade_reserved(
        session, org_id=uuid.uuid4(), new_tier="starter",
        apply_at=datetime(2026, 9, 29, tzinfo=timezone.utc), is_cancellation=False,
    )

    assert sent == ["ok@example.com"]


# ── _notify_downgrade_applied — 카피/locale 내용 ─────────────────────────────

@pytest.mark.anyio
async def test_notify_downgrade_applied_downgrade_variant(monkeypatch):
    import app.services.org_subscription_downgrade as mod

    sent = []
    monkeypatch.setattr(mod, "send_email", lambda to, subject, html: sent.append({"to": to, "subject": subject, "html": html}))
    session = AsyncMock()
    session.execute = AsyncMock(return_value=_locale_result([("en@example.com", "en")]))

    await mod._notify_downgrade_applied(session, org_id=uuid.uuid4(), new_tier="starter", is_cancellation=False)

    assert len(sent) == 1
    assert "plan change to Starter is complete" in sent[0]["subject"]
    assert "hasn't been deleted" in sent[0]["html"]


@pytest.mark.anyio
async def test_notify_downgrade_applied_cancellation_variant(monkeypatch):
    import app.services.org_subscription_downgrade as mod

    sent = []
    monkeypatch.setattr(mod, "send_email", lambda to, subject, html: sent.append({"to": to, "subject": subject, "html": html}))
    session = AsyncMock()
    session.execute = AsyncMock(return_value=_locale_result([("ko@example.com", "ko")]))

    await mod._notify_downgrade_applied(session, org_id=uuid.uuid4(), new_tier="free", is_cancellation=True)

    assert len(sent) == 1
    assert sent[0]["subject"] == "[Sprintable] 구독이 해지되어 Free 플랜으로 전환됐습니다"
    assert "삭제되지 않고 그대로 보존" in sent[0]["html"]


# ── SSOT 배선 — _reserve_pending_change ──────────────────────────────────────

@pytest.mark.anyio
async def test_reserve_pending_change_dispatches_reserved_email_with_correct_flags(monkeypatch):
    """reserve_downgrade/cancel_subscription 공통 단일 지점 — is_cancellation과 apply_at이
    정확히 넘어가는지 고정(호출자별 개별 배선 불요 원칙의 실제 증거)."""
    import app.services.org_subscription_downgrade as mod
    from app.models.org_subscription import OrgSubscription

    sub = MagicMock(spec=OrgSubscription)
    sub.org_id = uuid.uuid4()
    sub.current_period_end = datetime(2026, 9, 29, tzinfo=timezone.utc)
    refetched = MagicMock()

    session = AsyncMock()
    session.execute = AsyncMock(return_value=MagicMock(scalar_one=MagicMock(return_value=refetched)))

    notify_mock = AsyncMock()
    monkeypatch.setattr(mod, "_notify_downgrade_reserved", notify_mock)

    result = await mod._reserve_pending_change(session, sub=sub, new_tier="starter", offering_id=uuid.uuid4())

    assert result is refetched
    notify_mock.assert_awaited_once_with(
        session, org_id=sub.org_id, new_tier="starter",
        apply_at=sub.current_period_end, is_cancellation=False,
    )


@pytest.mark.anyio
async def test_reserve_pending_change_cancellation_sets_is_cancellation_true(monkeypatch):
    import app.services.org_subscription_downgrade as mod
    from app.models.org_subscription import OrgSubscription

    sub = MagicMock(spec=OrgSubscription)
    sub.org_id = uuid.uuid4()
    sub.current_period_end = datetime(2026, 9, 29, tzinfo=timezone.utc)

    session = AsyncMock()
    session.execute = AsyncMock(return_value=MagicMock(scalar_one=MagicMock(return_value=MagicMock())))

    notify_mock = AsyncMock()
    monkeypatch.setattr(mod, "_notify_downgrade_reserved", notify_mock)

    await mod._reserve_pending_change(session, sub=sub, new_tier="free", offering_id=uuid.uuid4())

    notify_mock.assert_awaited_once_with(
        session, org_id=sub.org_id, new_tier="free",
        apply_at=sub.current_period_end, is_cancellation=True,
    )


@pytest.mark.anyio
async def test_reserve_pending_change_notify_failure_does_not_break_reservation(monkeypatch):
    import app.services.org_subscription_downgrade as mod
    from app.models.org_subscription import OrgSubscription

    sub = MagicMock(spec=OrgSubscription)
    sub.org_id = uuid.uuid4()
    sub.current_period_end = datetime(2026, 9, 29, tzinfo=timezone.utc)
    refetched = MagicMock()

    session = AsyncMock()
    session.execute = AsyncMock(return_value=MagicMock(scalar_one=MagicMock(return_value=refetched)))
    monkeypatch.setattr(mod, "_notify_downgrade_reserved", AsyncMock(side_effect=RuntimeError("smtp down")))

    result = await mod._reserve_pending_change(session, sub=sub, new_tier="starter", offering_id=uuid.uuid4())

    assert result is refetched


# ── SSOT 배선 — sweep_pending_tier_downgrades(적용 시점) ─────────────────────

@pytest.mark.anyio
async def test_sweep_applied_downgrade_notifies_with_pre_update_tier_snapshot(monkeypatch):
    """카디르 확定 버그(PR#3308 QA)와 동일 함정 — UPDATE 後 sub.pending_tier를 그대로
    넘기면 identity-map evaluate 동기화로 이미 None이라 메일에 None이 실린다(#3207/§③
    seat-overage 분기가 이미 스냅샷으로 막은 것과 동일 클래스). ②(적용) 경로도 스냅샷
    으로 막혔는지 고정."""
    import app.services.org_subscription_downgrade as mod
    from app.models.org_subscription import OrgSubscription
    from app.models.offering_version import OfferingVersion

    now = datetime(2026, 9, 29, tzinfo=timezone.utc)
    sub = MagicMock(spec=OrgSubscription)
    sub.id = uuid.uuid4()
    sub.org_id = uuid.uuid4()
    sub.pending_tier = "starter"
    sub.pending_offering_version_id = uuid.uuid4()
    sub.billing_cycle = "monthly"

    pending_result = MagicMock()
    pending_result.scalars.return_value.all.return_value = [sub]
    session = AsyncMock()

    offering = MagicMock(spec=OfferingVersion)
    offering.included_seats = 100
    session.get = AsyncMock(return_value=offering)

    monkeypatch.setattr(mod, "count_human_seats", AsyncMock(return_value=3))
    monkeypatch.setattr(mod, "compute_period_end", MagicMock(return_value=now))
    notify_mock = AsyncMock()
    monkeypatch.setattr(mod, "_notify_downgrade_applied", notify_mock)

    # UPDATE 호출 시점에 evaluate 동기화를 흉내내 pending_tier를 None으로 되돌린다 —
    # 스냅샷 없이 넘겼다면 아래 assert가 new_tier=None으로 실패한다.
    async def _execute_side_effect(*a, **kw):
        if not hasattr(_execute_side_effect, "called"):
            _execute_side_effect.called = True
            return pending_result
        sub.pending_tier = None
        return MagicMock()
    session.execute = AsyncMock(side_effect=_execute_side_effect)

    await mod.sweep_pending_tier_downgrades(session, now=now)

    notify_mock.assert_awaited_once_with(session, org_id=sub.org_id, new_tier="starter", is_cancellation=False)


@pytest.mark.anyio
async def test_sweep_applied_cancellation_notifies_with_free_tier(monkeypatch):
    import app.services.org_subscription_downgrade as mod
    from app.models.org_subscription import OrgSubscription
    from app.models.offering_version import OfferingVersion

    now = datetime(2026, 9, 29, tzinfo=timezone.utc)
    sub = MagicMock(spec=OrgSubscription)
    sub.id = uuid.uuid4()
    sub.org_id = uuid.uuid4()
    sub.pending_tier = "free"
    sub.pending_offering_version_id = uuid.uuid4()
    sub.billing_cycle = "monthly"

    pending_result = MagicMock()
    pending_result.scalars.return_value.all.return_value = [sub]
    session = AsyncMock()
    session.execute = AsyncMock(side_effect=[pending_result, MagicMock()])

    offering = MagicMock(spec=OfferingVersion)
    offering.included_seats = 100
    session.get = AsyncMock(return_value=offering)

    notify_mock = AsyncMock()
    monkeypatch.setattr(mod, "_notify_downgrade_applied", notify_mock)

    await mod.sweep_pending_tier_downgrades(session, now=now)

    notify_mock.assert_awaited_once_with(session, org_id=sub.org_id, new_tier="free", is_cancellation=True)
