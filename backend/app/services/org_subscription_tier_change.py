"""story #2880(결제 트랙 갭①) — 월납 유료→유료 상향의 단계 함수들. doc
`billing-policy-scenario-audit-20260821` 1번 갭: `checkout_subscription()`은 신규 결제
전용이라 활성 유료 org에 다시 부르면 신규 티어 전액을 이중청구한다. 이 모듈이 그 전용
경로(change-tier)를 연다.

**산식 확定(선생님 최종 결정, 2026-08-21 — 페드루 릴레이)**: 「신 요금 전액 결제 후,
기존 플랜 남은 기간의 일할 «부분취소»」— 크레딧 차감이 아니다(크레딧 잔액 인프라 자체가
부재, doc 11번 갭). Toss 부분취소(cancel)로 실 정산한다.

**상태기계**:
①청구 = 신 offering 월 전액(`compute_full_charge_for_new_offering` — 좌석초과·팩 포함,
  구 tier와 무관하게 신 tier 정가) — 기존 active billing_key로 `charge_org()` 즉시
  호출(checkout과 달리 신규 billing key 발급/authKey 재인증 불요, 이미 유료 구독 中인
  org는 유효한 키가 있다는 전제).
②환급 = 직전 confirmed 결제 건(billing_orders, 이 org의 가장 최근 confirmed row)의
  payment_key에 `cancelAmount = floor(구 offering 월요금 × 잔여일/전체일)` 부분취소
  (`refund_org` 재사용 — TossAdapter.refund 경로, C4/story #2495가 이미 세운 메커니즘
  그대로 재사용, 재구현 0).
③period 리셋 — 업그레이드 시점=새 current_period_start, +1개월=새 current_period_end
  (`billing_period.new_subscription_period` 재사용). 구 period는 끝났다는 뜻(과금일
  자체가 바뀐다 — 선생님 확定 핵심 전제).
④**시퀀싱**(#2892 시퀀싱 원칙 연장) — 신 전액 charge가 confirmed **後**에만 tier
  전이+period 리셋+부분취소를 실행한다. 부분취소가 실패해도 이미 confirmed된 신규
  charge는 되돌리지 않는다(선생님 지시) — 실패는 `billing_orders.refund_status='failed'`
  로 명시 기록하고 재시도/스윕 대상으로 남긴다(이 스토리는 스윕 자체는 짓지 않는다 —
  기록만 남겨 향후 스윕이 찾을 수 있게 한다).
⑤스코프: billing_cycle='monthly' 3경로만(Starter→Team·Starter→Biz·Team→Biz) — annual·
  하향은 이 함수가 명시 거부(각각 공식 문서 확定 선행·story #2881).
ⓐ동시성 — checkout_subscription과 **같은** `org_subscriptions.checkout_claimed_at`
  필드를 claim으로 재사용한다(같은 org에 checkout과 change-tier가 동시에 들어오면 안
  되는 것도 이 필드 하나가 막는다 — org당 "진행 中인 결제 작업" 슬롯은 하나뿐).

story #4344 — 위 단계를 한 호출 안에서 잇던 동기 판 `change_tier()`(와 그 전용 부분취소 · 거절 예외)는 결제 시도(story #4335
`billing_payment_attempt`) 뒤 운영 호출처 0이라 걷었다 — 돈 기록 하나에 주인 하나(결제 시도 행) 규칙 밖에서 청구 · 환불이 나갈
자리였다. 이 모듈에 남은 것은 결제 시도가 부르는 단계 함수(검증 · claim · 전이 · 일할액 · 환불 대상 선택 · 주문명)뿐이다. 청구 ·
환불은 결제 시도만 한다(`test_4344_no_direct_money_path.py`가 고정).
"""
from __future__ import annotations

import uuid
from datetime import datetime

from sqlalchemy import or_, select, update
from sqlalchemy.ext.asyncio import AsyncSession

from app.models.billing_order import BillingOrder
from app.models.offering_version import OfferingVersion
from app.models.org_subscription import OrgSubscription
from app.services.billing_charge_amount import apply_vat_minor, prorate_minor
from app.services.billing_period import new_subscription_period
from app.services.platform_settings import get_platform_settings
from app.services.org_subscription_checkout import STALE_CLAIM_WINDOW

PAID_TIERS = frozenset({"starter", "team", "business"})
_TIER_RANK = {"starter": 1, "team": 2, "business": 3}


class TierChangeError(Exception):
    """상향을 진행할 수 없는 상태(정책 위반·데이터 갭) — 명시 실패, 호출부가 400으로 번역."""


class TierChangeInProgress(Exception):
    """같은 org에 다른 결제 작업(checkout·change-tier)이 진행 中 — 409, 재시도 가능."""


async def latest_confirmed_subscription_order(session: AsyncSession, org_id: uuid.UUID) -> BillingOrder | None:
    """⛔카디르 CRITICAL(2026-08-21, PR#3306 리뷰) — 이전 버전은 org_id+status='confirmed'
    로만 걸러 pack 구매 order를 «직전 구독 결제»로 오인했다(billing_pack.py도 같은
    billing_orders 테이블에 confirmed row를 남긴다 — 실PG 2시나리오 재현 확定: pack금액<
    prorate액이면 refund_org 자체 방어로 실패만 남고 진짜 구독 결제는 영원히 미환급,
    pack금액>prorate액이면 방어선 없이 «조용히 성공»해 무관한 pack 구매가 실제로
    취소됨). `purpose='charge'`(0268)로 구독 charge만 명시 필터 — pack_purchase는
    구조적으로 대상에서 빠진다."""
    return (
        await session.execute(
            select(BillingOrder)
            .where(BillingOrder.org_id == org_id, BillingOrder.status == "confirmed", BillingOrder.purpose == "charge")
            .order_by(BillingOrder.created_at.desc())
            .limit(1)
        )
    ).scalar_one_or_none()


async def validate_change_tier(
    session: AsyncSession, *, org_id: uuid.UUID, new_tier: str,
) -> tuple[OrgSubscription, OfferingVersion, OfferingVersion]:
    """상향 진입 가드(Toss · 쓰기 0) → (지금 구독, 옛 offering, 새 offering). 결제 시도(story #4335)의 요금제 변경이 부른다."""
    if new_tier not in PAID_TIERS:
        raise TierChangeError(f"new_tier={new_tier!r}는 유료 티어만(starter/team/business)")

    sub = (
        await session.execute(select(OrgSubscription).where(OrgSubscription.org_id == org_id))
    ).scalar_one_or_none()
    if sub is None or sub.status != "active" or sub.tier not in PAID_TIERS:
        raise TierChangeError(
            f"org_id={org_id} 활성 유료 구독이 아님 — 상향 엔진(change-tier)이 아니라 "
            "신규 결제(checkout)로 진입해야 함"
        )
    if sub.billing_cycle != "monthly":
        raise TierChangeError(
            f"billing_cycle={sub.billing_cycle!r} — 연납 중 상향은 이 스토리 범위 밖"
            "(공식 문서 확定 선행, doc billing-policy-scenario-audit-20260821 §3)"
        )
    if sub.current_period_start is None or sub.current_period_end is None:
        raise TierChangeError(f"org_id={org_id} current_period_start/end 없음 — 일할 부분취소 계산 불가")
    if _TIER_RANK.get(new_tier, 0) <= _TIER_RANK.get(sub.tier, 0):
        raise TierChangeError(
            f"{sub.tier!r}→{new_tier!r}는 상향이 아님(하향/동일) — 하향은 story #2881(예약+좌석 게이트)"
        )
    if sub.offering_version_id is None:
        raise TierChangeError(f"org_subscription(org_id={org_id})에 offering_version_id가 바인딩되지 않음")

    old_offering = await session.get(OfferingVersion, sub.offering_version_id)
    if old_offering is None:
        raise TierChangeError(f"offering_version {sub.offering_version_id}를 찾을 수 없음")

    new_offering = (
        await session.execute(
            select(OfferingVersion).where(
                OfferingVersion.tier == new_tier,
                OfferingVersion.currency == "krw",
                OfferingVersion.effective_to.is_(None),
            )
        )
    ).scalar_one_or_none()
    if new_offering is None:
        raise TierChangeError(f"tier={new_tier!r}의 활성 offering_version(krw)을 찾을 수 없음")
    if new_offering.monthly_price_minor <= old_offering.monthly_price_minor:
        # ⓓ(페드루 지시) — rank 비교(위)로 대부분 걸리지만, 데이터 이상(같은 rank인데 가격
        # 역전 등)까지 마지막 방어선으로 한 번 더 잰다. 정가가 실제로 안 오르는데 "상향"으로
        # 진입하면 부분취소가 charge보다 커지는 회계 모순이 생긴다.
        raise TierChangeError(
            f"new_offering.monthly_price_minor({new_offering.monthly_price_minor}) <= "
            f"old_offering.monthly_price_minor({old_offering.monthly_price_minor}) — 상향 아님"
        )
    return sub, old_offering, new_offering


async def claim_tier_change_slot(session: AsyncSession, *, org_id: uuid.UUID, now: datetime, commit: bool = True) -> bool:
    """ⓐ claim — checkout과 같은 필드 · 같은 WHERE 가드(org당 진행 中 결제 작업 슬롯은 하나). True = 이 호출이 쥠.
    False면 이미 다른 checkout/change-tier가 이 org를 쥐고 있다(이중 클릭 · 동시 호출 모두 여기서 막힌다)."""
    claim_result = await session.execute(
        update(OrgSubscription)
        .where(
            OrgSubscription.org_id == org_id,
            or_(
                OrgSubscription.checkout_claimed_at.is_(None),
                OrgSubscription.checkout_claimed_at < now - STALE_CLAIM_WINDOW,
            ),
        )
        .values(checkout_claimed_at=now)
    )
    if commit:
        await session.commit()
    return claim_result.rowcount == 1


async def apply_tier_change(
    session: AsyncSession, *, org_id: uuid.UUID, claim_value: datetime, new_tier: str, new_offering_id: uuid.UUID,
) -> int:
    """④권리 — 신 전액 confirmed 뒤 tier · offering · period 리셋(과금일 = claim 시각). claim 값 CAS · 커밋은 호출자."""
    new_period_start, new_period_end = new_subscription_period(now=claim_value, billing_cycle="monthly")
    result = await session.execute(
        update(OrgSubscription)
        .where(OrgSubscription.org_id == org_id, OrgSubscription.checkout_claimed_at == claim_value)
        .values(
            tier=new_tier, offering_version_id=new_offering_id,
            current_period_start=new_period_start, current_period_end=new_period_end,
        )
    )
    return result.rowcount


async def prorated_refund_amount(
    session: AsyncSession, *, old_offering: OfferingVersion, old_period_start: datetime, old_period_end: datetime,
    now: datetime,
) -> int:
    """옛 tier 잔여기간 일할 환불액(VAT 포함 실 청구액 기준).

    story #3097(선생님 결정 2026-08-26) — 옛 청구액은 원래 청구 시점에 이미 VAT 가산된 값이다(compute_full_charge_for_new_offering
    경로가 그렇게 청구한다) — 부분취소도 그 실제로 걷은 금액 기준으로 일할해야 한다. raw monthly_price_minor(공급가)로
    그대로 일할하면 환불액이 VAT분만큼 과소산정된다(실 청구액보다 덜 돌려줌)."""
    settings = await get_platform_settings(session)
    taxed_old_monthly = apply_vat_minor(old_offering.monthly_price_minor, settings.vat_rate_bp)
    return prorate_minor(taxed_old_monthly, now=now, period_start=old_period_start, period_end=old_period_end)


def tier_change_order_name(from_tier: str, to_tier: str) -> str:
    """Toss 주문명(영수증에 보임) — 결제 시도(story #4335)의 요금제 변경 청구."""
    return f"Sprintable {from_tier}→{to_tier} 상향"


def tier_change_ledger_metadata(from_tier: str, to_tier: str) -> dict:
    return {"kind": "tier_change", "from_tier": from_tier, "to_tier": to_tier}

