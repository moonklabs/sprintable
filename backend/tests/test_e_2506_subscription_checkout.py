"""#2502+#2506 — 구독 체크아웃 상태기계. PO 확定(2026-08-07, "돈이 걸린 판단"):
①빌링키 발급 ②구독 pending 생성 ③즉시 1차 청구 ④청구 성공 時에만 active."""
from __future__ import annotations

import uuid
from datetime import datetime, timezone
from unittest.mock import AsyncMock, MagicMock, patch

import pytest


def _offering(*, tier="team", offering_id=None):
    o = MagicMock()
    o.id = offering_id or uuid.uuid4()
    o.tier = tier
    o.currency = "krw"
    return o


def _sub(*, org_id, status="pending", tier="team", billing_cycle="monthly"):
    s = MagicMock()
    s.org_id = org_id
    s.status = status
    s.tier = tier
    s.billing_cycle = billing_cycle
    s.current_period_start = datetime(2026, 8, 7, tzinfo=timezone.utc)
    s.current_period_end = datetime(2026, 9, 7, tzinfo=timezone.utc)
    return s


def _exec_result(scalar_value):
    r = MagicMock()
    r.scalar_one_or_none.return_value = scalar_value
    r.scalar_one.return_value = scalar_value
    return r


# ─── checkout_subscription — 입력 검증 ──────────────────────────────────────

@pytest.mark.anyio
async def test_checkout_rejects_free_tier():
    from app.services.org_subscription_checkout import CheckoutError, checkout_subscription

    session = AsyncMock()
    with pytest.raises(CheckoutError, match="free"):
        await checkout_subscription(
            session, org_id=uuid.uuid4(), auth_key="ak", tier="free", billing_cycle="monthly",
        )
    session.execute.assert_not_awaited()


@pytest.mark.anyio
async def test_checkout_rejects_invalid_billing_cycle():
    from app.services.org_subscription_checkout import CheckoutError, checkout_subscription

    session = AsyncMock()
    with pytest.raises(CheckoutError, match="billing_cycle"):
        await checkout_subscription(
            session, org_id=uuid.uuid4(), auth_key="ak", tier="team", billing_cycle="weekly",
        )


@pytest.mark.anyio
async def test_checkout_raises_when_offering_not_found():
    from app.services.org_subscription_checkout import CheckoutError, checkout_subscription

    session = AsyncMock()
    session.execute = AsyncMock(return_value=_exec_result(None))
    with pytest.raises(CheckoutError, match="offering_version"):
        await checkout_subscription(
            session, org_id=uuid.uuid4(), auth_key="ak", tier="team", billing_cycle="monthly",
        )


# ─── checkout_subscription — 상태기계 happy path ────────────────────────────

def _claim_result(rowcount=1):
    r = MagicMock()
    r.rowcount = rowcount
    return r


@pytest.mark.anyio
async def test_checkout_activates_subscription_when_charge_confirmed():
    from app.services.org_subscription_checkout import checkout_subscription

    org_id = uuid.uuid4()
    offering = _offering(tier="team")
    active_sub = _sub(org_id=org_id, status="active")

    session = AsyncMock()
    session.execute = AsyncMock(side_effect=[
        _exec_result(offering),   # ① offering lookup
        _claim_result(1),         # #2511 claim(=구독 pending 전이 겸함) — 성공
        MagicMock(),              # ④ update active
        _exec_result(active_sub), # 최종 refetch
        MagicMock(),              # #2511 finally — claim 해제
    ])

    confirmed_order = MagicMock()
    confirmed_order.status = "confirmed"

    with patch("app.services.org_subscription_checkout.issue_billing_key", new=AsyncMock()) as mock_issue, \
         patch("app.services.org_subscription_checkout.compute_charge_amount", new=AsyncMock(return_value=(59_000, "krw"))), \
         patch("app.services.org_subscription_checkout.charge_org", new=AsyncMock(return_value=confirmed_order)) as mock_charge:
        result = await checkout_subscription(
            session, org_id=org_id, auth_key="ak-1", tier="team", billing_cycle="monthly",
        )

    assert result.status == "active"
    mock_issue.assert_awaited_once_with(session, org_id=org_id, auth_key="ak-1")
    mock_charge.assert_awaited_once()
    charge_kwargs = mock_charge.await_args.kwargs
    assert charge_kwargs["amount_minor"] == 59_000
    assert charge_kwargs["currency"] == "krw"

    # claim(=구독 pending 전이 겸함) 확認 — 두 번째 execute 호출.
    claim_call = session.execute.call_args_list[1]
    compiled = claim_call.args[0].compile().params
    assert compiled["status"] == "pending"
    assert compiled["tier"] == "team"
    assert compiled["billing_cycle"] == "monthly"

    # 카디르 CRITICAL fix(codex, #2896 리뷰) — ④ activate UPDATE도 release와 동일한
    # CAS(checkout_claimed_at==이 호출이 claim한 값)가 걸려 있어야 한다. 세 번째 execute
    # 호출(claim 다음).
    activate_call = session.execute.call_args_list[2]
    activate_where_literal = str(activate_call.args[0].whereclause)
    assert "checkout_claimed_at" in activate_where_literal


@pytest.mark.anyio
async def test_checkout_rejects_when_another_checkout_already_in_progress():
    """#2511 — claim UPSERT의 WHERE 가드에 걸려 rowcount=0(다른 checkout이 이미
    checkout_claimed_at을 쥐고 있음) — Toss를 한 번도 부르지 않고(issue_billing_key조차)
    즉시 CheckoutInProgress로 거부돼야 한다."""
    from app.services.org_subscription_checkout import CheckoutInProgress, checkout_subscription

    org_id = uuid.uuid4()
    offering = _offering(tier="team")

    session = AsyncMock()
    session.execute = AsyncMock(side_effect=[
        _exec_result(offering),  # ① offering lookup
        _claim_result(0),        # #2511 claim 실패 — 다른 요청이 진행 中
    ])

    with patch("app.services.org_subscription_checkout.issue_billing_key", new=AsyncMock()) as mock_issue, \
         patch("app.services.org_subscription_checkout.charge_org", new=AsyncMock()) as mock_charge:
        with pytest.raises(CheckoutInProgress, match="진행"):
            await checkout_subscription(
                session, org_id=org_id, auth_key="ak-x", tier="team", billing_cycle="monthly",
            )

    mock_issue.assert_not_awaited()
    mock_charge.assert_not_awaited()
    assert session.execute.await_count == 2  # offering + claim뿐, finally release도 없음(claim 자체가 실패)


@pytest.mark.anyio
async def test_checkout_order_id_is_deterministic_per_org_offering_day():
    from app.services.org_subscription_checkout import _checkout_order_id

    org_id = uuid.uuid4()
    offering_id = uuid.uuid4()
    today = datetime(2026, 8, 7, 9, 0, tzinfo=timezone.utc)
    later_same_day = datetime(2026, 8, 7, 23, 0, tzinfo=timezone.utc)
    next_day = datetime(2026, 8, 8, 0, 0, tzinfo=timezone.utc)

    id1 = _checkout_order_id(org_id, offering_id, today)
    id2 = _checkout_order_id(org_id, offering_id, later_same_day)
    id3 = _checkout_order_id(org_id, offering_id, next_day)

    assert id1 == id2  # 같은 날 재시도(더블클릭 등) → 같은 orderId → charge_org 원자적 claim이 흡수
    assert id1 != id3  # 다른 날 재구독 → 다른 orderId(옛 confirmed order와 충돌 안 함)


@pytest.mark.anyio
async def test_checkout_declined_leaves_subscription_pending_not_active():
    """카드 거절(TossApiError) — 시스템 오류 아님. 구독은 pending인 채 남는다."""
    from app.services.org_subscription_checkout import CheckoutDeclined, checkout_subscription
    from app.services.payment.toss_adapter import TossApiError

    org_id = uuid.uuid4()
    offering = _offering(tier="team")
    pending_sub = _sub(org_id=org_id, status="pending")

    session = AsyncMock()
    session.execute = AsyncMock(side_effect=[
        _exec_result(offering),    # ① offering lookup
        _claim_result(1),          # #2511 claim 성공
        _exec_result(pending_sub), # except 블록 안 refetch
        MagicMock(),               # #2511 finally — claim 해제(CheckoutDeclined도 거친다)
    ])

    with patch("app.services.org_subscription_checkout.issue_billing_key", new=AsyncMock()), \
         patch("app.services.org_subscription_checkout.compute_charge_amount", new=AsyncMock(return_value=(59_000, "krw"))), \
         patch(
             "app.services.org_subscription_checkout.charge_org",
             new=AsyncMock(side_effect=TossApiError("CARD_DECLINED", "카드 거절", status_code=400)),
         ):
        with pytest.raises(CheckoutDeclined) as exc_info:
            await checkout_subscription(
                session, org_id=org_id, auth_key="ak-2", tier="team", billing_cycle="monthly",
            )

    assert exc_info.value.subscription.status == "pending"
    # 4번째(active로 올리는) execute가 없어야 — offering+claim+refetch+release 딱 4번.
    assert session.execute.await_count == 4


@pytest.mark.anyio
async def test_checkout_does_not_activate_when_order_not_confirmed_race_loss():
    """charge_org가 예외 없이 반환했지만 status가 'confirmed'가 아닌 경우(다른 호출이
    이미 처리 중인 race) — active로 올리지 않는다."""
    from app.services.org_subscription_checkout import checkout_subscription

    org_id = uuid.uuid4()
    offering = _offering(tier="team")
    pending_sub = _sub(org_id=org_id, status="pending")

    session = AsyncMock()
    session.execute = AsyncMock(side_effect=[
        _exec_result(offering),
        _claim_result(1),
        _exec_result(pending_sub),  # 최종 refetch(active-update 없음)
        MagicMock(),                # #2511 finally — claim 해제
    ])

    racing_order = MagicMock()
    racing_order.status = "pending"

    with patch("app.services.org_subscription_checkout.issue_billing_key", new=AsyncMock()), \
         patch("app.services.org_subscription_checkout.compute_charge_amount", new=AsyncMock(return_value=(59_000, "krw"))), \
         patch("app.services.org_subscription_checkout.charge_org", new=AsyncMock(return_value=racing_order)):
        result = await checkout_subscription(
            session, org_id=org_id, auth_key="ak-3", tier="team", billing_cycle="monthly",
        )

    assert result.status == "pending"
    assert session.execute.await_count == 4
