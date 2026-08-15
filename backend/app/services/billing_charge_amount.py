"""결제②(story #2500) — 청구액 계산 엔진. offering_version(불변 가격표) × «사람 좌석» ×
명시적으로 산 팩 → org의 이번 결제 주기 청구액. C3(#2494) trigger_due_charges가 이 값을
얻어 C2(#2493) charge_org에 amount로 넘길 소스가 된다(C2/C3와 마찬가지로 "메커니즘만" —
"누가 오늘 청구대상인지" 판정은 여기 책임이 아니다, #2502).

⛔순수 read-only 계산 — Toss를 호출하지도 원장에 기입하지도 않는다.

좌석 = «사람(human) 멤버»만(org_members, PO 확認 2026-08-07·pricing-policy-v2-3) —
등록 에이전트는 별개 축(feature-gate)이라 좌석 계산에 넣지 않는다.

팩분은 billing_ledger_entries(entry_type='pack_purchase') 기간집계로 읽는다 — "팩 구매
트리거"(관리자 명시 확認 후 원장 기입) 자체는 아직 코드 어디에도 없어(그라운딩 grep 0건,
story #2505로 별도 추적) 지금은 항상 0을 반환한다. current_period_start/end가 없는 org
(Toss 신규 유료 전환 진입점이 아직 없다 — #2502)는 팩분을 0으로 취급(기간을 특정할 수
없으니 집계 자체를 건너뛴다)."""
from __future__ import annotations

import uuid

from sqlalchemy import func, select
from sqlalchemy.ext.asyncio import AsyncSession

from app.models.billing_ledger_entry import BillingLedgerEntry
from app.models.offering_version import OfferingVersion
from app.models.org_subscription import OrgSubscription
from app.models.project import OrgMember


class ChargeAmountError(Exception):
    """청구액을 계산할 수 없는 상태(구독/카탈로그 불변식 위반) — 잘못된 금액으로 조용히
    진행하는 대신 명시적으로 실패한다."""


async def count_human_seats(session: AsyncSession, org_id: uuid.UUID) -> int:
    """이 org의 현재 실 «사람» 좌석 수. org_subscriptions에는 이 값을 담는 컬럼이 없다
    (그라운딩 확認) — org_members에서 매번 파생한다(get_impact/check_member_invite_limit과
    동일 쿼리 — SSOT 재사용, 새 카운팅 개념 발명 아님)."""
    return (
        await session.execute(
            select(func.count()).select_from(OrgMember).where(
                OrgMember.org_id == org_id,
                OrgMember.deleted_at.is_(None),
            )
        )
    ).scalar_one()


async def compute_pack_charge_minor(
    session: AsyncSession,
    *,
    org_id: uuid.UUID,
    subscription_id: uuid.UUID,
    period_start,
    period_end,
) -> int:
    """이번 결제 주기 동안 명시적으로 구매된 팩의 합계(minor unit). 주기 경계가 없으면
    (current_period_start/end 미세팅 — #2502 갭) 집계 범위를 특정할 수 없으니 0."""
    if period_start is None or period_end is None:
        return 0
    return (
        await session.execute(
            select(func.coalesce(func.sum(BillingLedgerEntry.amount_minor), 0)).where(
                BillingLedgerEntry.org_id == org_id,
                BillingLedgerEntry.subscription_id == subscription_id,
                BillingLedgerEntry.entry_type == "pack_purchase",
                BillingLedgerEntry.ts >= period_start,
                BillingLedgerEntry.ts < period_end,
            )
        )
    ).scalar_one()


async def compute_charge_amount(session: AsyncSession, *, org_id: uuid.UUID) -> tuple[int, str]:
    """(amount_minor, currency) 반환. 기저가(월/연) + 좌석초과분 + 팩분."""
    sub = (
        await session.execute(select(OrgSubscription).where(OrgSubscription.org_id == org_id))
    ).scalar_one_or_none()
    if sub is None:
        raise ChargeAmountError(f"no org_subscription row for org_id={org_id}")
    if sub.offering_version_id is None:
        raise ChargeAmountError(
            f"org_subscription(org_id={org_id})에 offering_version_id가 바인딩되지 않음"
        )

    offering = await session.get(OfferingVersion, sub.offering_version_id)
    if offering is None:
        raise ChargeAmountError(f"offering_version {sub.offering_version_id}를 찾을 수 없음")

    # 카디르 결함사냥(#2509, 2026-08-07) — org_subscriptions.billing_cycle에 DB CHECK가
    # 없어(Text nullable) NULL·'Annual'·'yearly'·오타가 조용히 monthly로 폴백해 annual
    # 구독을 10배 저청구할 수 있었다. "annual 아니면 monthly=안전한 기본값"이라는 판단
    # 자체가 틀렸다 — 불명확한 값은 명시 실패로.
    if sub.billing_cycle not in ("monthly", "annual"):
        raise ChargeAmountError(
            f"org_subscription(org_id={org_id}).billing_cycle={sub.billing_cycle!r}이 "
            "'monthly'/'annual' 둘 다 아님 — monthly로 조용히 폴백하지 않는다"
        )
    base_amount = (
        offering.annual_price_minor if sub.billing_cycle == "annual" else offering.monthly_price_minor
    )

    seat_count = await count_human_seats(session, org_id)
    seat_overage = max(0, seat_count - offering.included_seats)
    if seat_overage > 0:
        if offering.extra_seat_price_minor is None:
            raise ChargeAmountError(
                f"org_id={org_id} tier={offering.tier!r}가 included_seats를 {seat_overage}석 "
                "초과했으나 이 offering은 추가좌석을 팔지 않음(정책상 상위 티어 전환 후에만 "
                "가능한 상태 — 초과 상태로 청구를 계산하면 안 됨)"
            )
        seat_amount = seat_overage * offering.extra_seat_price_minor
    else:
        seat_amount = 0

    pack_amount = await compute_pack_charge_minor(
        session,
        org_id=org_id,
        subscription_id=sub.id,
        period_start=sub.current_period_start,
        period_end=sub.current_period_end,
    )

    # 카디르 결함사냥(#2509) — offering.currency와 sub.currency 사이엔 FK만 있고 값 일치
    # 제약이 없다(구조적 갭). 반환 직전 대조해 불일치를 명시 실패로 잡는다(예: USD
    # offering이 KRW sub에 잘못 바인딩된 상태로 조용히 금액만 나가는 것 방지).
    if offering.currency != sub.currency:
        raise ChargeAmountError(
            f"offering_version.currency={offering.currency!r} != "
            f"org_subscription.currency={sub.currency!r} for org_id={org_id}"
        )

    return base_amount + seat_amount + pack_amount, offering.currency
