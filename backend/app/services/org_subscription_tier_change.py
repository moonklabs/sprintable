"""story #2880(결제 트랙 갭①) — 월납 유료→유료 상향 엔진. doc
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
"""
from __future__ import annotations

import logging
import uuid
from datetime import datetime, timezone

from sqlalchemy import or_, select, update
from sqlalchemy.ext.asyncio import AsyncSession

from app.models.billing_order import BillingOrder
from app.models.offering_version import OfferingVersion
from app.models.org_subscription import OrgSubscription
from app.services.billing_charge import charge_org
from app.services.billing_charge_amount import (
    ChargeAmountError,
    apply_vat_minor,
    compute_full_charge_for_new_offering,
    prorate_minor,
)
from app.services.billing_period import new_subscription_period
from app.services.billing_refund import refund_org
from app.services.platform_settings import get_platform_settings
from app.services.org_subscription_checkout import STALE_CLAIM_WINDOW
from app.services.payment.toss_adapter import TossApiError

logger = logging.getLogger(__name__)

PAID_TIERS = frozenset({"starter", "team", "business"})
_TIER_RANK = {"starter": 1, "team": 2, "business": 3}


class TierChangeError(Exception):
    """상향을 진행할 수 없는 상태(정책 위반·데이터 갭) — 명시 실패, 호출부가 400으로 번역."""


class TierChangeDeclined(Exception):
    """Toss 카드 거절 등 비즈니스 사유 — 시스템 오류 아님. 구독은 원 tier인 채(재시도 가능)."""

    def __init__(self, message: str, *, subscription: OrgSubscription):
        self.subscription = subscription
        super().__init__(message)


class TierChangeInProgress(Exception):
    """같은 org에 다른 결제 작업(checkout·change-tier)이 진행 中 — 409, 재시도 가능."""


async def _refetch_subscription(session: AsyncSession, org_id: uuid.UUID) -> OrgSubscription:
    """⛔같은 클래스 latent 버그 방어(org_subscription_checkout.py::_refetch_subscription
    참고, 2026-08-21 P0 작업 中 실증) — 이 함수 진입 前에 이미 이 org_id 행을 SELECT한
    적이 있으면(이 함수 자체가 change_tier() 첫 줄의 `sub` 조회 이후에 불린다)
    SQLAlchemy identity map이 캐시된 인스턴스를 돌려줄 위험이 있다.
    `populate_existing()`으로 항상 강제 재조회한다.

    카디르군 관찰(2907 PR 리뷰, 2026-08-21) — 이 모듈의 write 3곳(claim·tier리셋·claim
    해제)이 전부 순수 `update(OrgSubscription)` Core구문이라 SQLAlchemy의
    synchronize_session='auto'가 identity map을 이미 자동 동기화한다 — 실측(populate_existing
    임시제거+test_2880 9건 재실행) 결과 현재 코드경로 기준으로는 inert(어느 테스트도 못
    잡음, checkout.py의 `pg_insert().on_conflict_do_update()`와 달리 이쪽은 INSERT
    구문이 아님). 그래도 걷어내지 않는다 — 이 write 중 하나가 훗날 upsert류로 바뀌면
    (예: claim을 pg_insert 기반으로 바꾸는 리팩터) 같은 staleness 클래스가 조용히
    재발할 수 있는 방어선이라, 인위적으로 조작한 테스트로 "증명"하는 대신 이 주석으로
    위험을 명시해둔다."""
    return (
        await session.execute(
            select(OrgSubscription).where(OrgSubscription.org_id == org_id).execution_options(populate_existing=True)
        )
    ).scalar_one()


async def _latest_confirmed_subscription_order(session: AsyncSession, org_id: uuid.UUID) -> BillingOrder | None:
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


async def change_tier(session: AsyncSession, *, org_id: uuid.UUID, new_tier: str) -> OrgSubscription:
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

    # ⓐ claim — checkout_subscription()과 동형(같은 필드, 같은 WHERE 가드 — org당 진행 中
    # 결제 작업 슬롯은 하나). rowcount==0이면 이미 다른 checkout/change-tier가 이 org를
    # 쥐고 있다는 뜻(이중 클릭·동시 호출 모두 여기서 막힌다).
    now = datetime.now(timezone.utc)
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
    await session.commit()
    if claim_result.rowcount == 0:
        raise TierChangeInProgress(f"org_id={org_id}에 다른 결제 작업이 이미 진행 중 — 완료 후 재시도")

    try:
        # ⛔카디르 MEDIUM(2026-08-21, PR#3306 리뷰) — 이전 버전은 이 조회가 try 밖이라
        # 조회 자체가 실패하면 finally(claim 해제)를 못 타 stale window 동안 org가
        # 잠겼다. claim commit 직후를 try 시작점으로 당겨 이 조회도 finally 보호 안에
        # 넣는다. claim이 이 시점부터 이 org의 결제 작업을 배타적으로 쥐므로, 이 조회와
        # 아래 charge_org 사이에 다른 호출이 새 order를 confirmed로 만들 여지가 없다
        # (레이스 없음 — 스냅샷 의미는 그대로).
        old_confirmed_order = await _latest_confirmed_subscription_order(session, org_id)

        try:
            amount_minor, currency = await compute_full_charge_for_new_offering(
                session, org_id=org_id, new_offering=new_offering,
            )
        except ChargeAmountError as exc:
            raise TierChangeError(str(exc)) from exc

        order_id = f"tierchange-{org_id}-{new_offering.id}-{uuid.uuid4().hex[:12]}"
        try:
            # ① 신 offering 전액 즉시 청구. 감사 기록(billing_orders+billing_ledger_entries,
            # entry_type="charge" 기본값)은 charge_org 자체가 진다 — 별도 entry_type 신설
            # 불요(이건 실제로 청구되는 돈이라 "charge" 분류가 맞다).
            order = await charge_org(
                session, org_id=org_id, order_id=order_id, amount_minor=amount_minor,
                currency=currency, order_name=f"Sprintable {sub.tier}→{new_tier} 상향",
                ledger_metadata={"kind": "tier_change", "from_tier": sub.tier, "to_tier": new_tier},
            )
        except TossApiError as exc:
            refreshed = await _refetch_subscription(session, org_id)
            raise TierChangeDeclined(str(exc), subscription=refreshed) from exc

        # ④권리는 confirmed 後에만. 실패(pending/failed)면 tier/period 그대로 — 신 전액이
        # 승인 안 됐는데 구 결제를 부분취소하면 이중 손실이 난다.
        if order.status != "confirmed":
            return await _refetch_subscription(session, org_id)

        old_period_start, old_period_end = sub.current_period_start, sub.current_period_end
        new_period_start, new_period_end = new_subscription_period(now=now, billing_cycle="monthly")
        await session.execute(
            update(OrgSubscription)
            .where(OrgSubscription.org_id == org_id, OrgSubscription.checkout_claimed_at == now)
            .values(
                tier=new_tier, offering_version_id=new_offering.id,
                current_period_start=new_period_start, current_period_end=new_period_end,
            )
        )
        await session.commit()

        # ②③ 구 tier 잔여분 부분취소. old_confirmed_order가 없으면(예: 최초 체크아웃
        # 직후 잔여 팩분 정산 등 예외 상태) 부분취소할 대상 자체가 없다는 뜻 — charge는
        # 이미 confirmed로 완결됐으니 여기서 실패로 되돌리지 않고 조용히 skip(로그만).
        if old_confirmed_order is not None:
            # story #3097(선생님 결정 2026-08-26) — old_confirmed_order.amount_minor는
            # 원래 청구 시점에 이미 VAT 가산된 값이다(compute_full_charge_for_new_offering
            # 경로가 이 fix로 그렇게 청구한다) — 부분취소도 그 실제로 걷은 금액 기준으로
            # 일할해야 한다. raw monthly_price_minor(공급가)로 그대로 일할하면 환불액이
            # VAT분만큼 과소산정된다(실 청구액보다 덜 돌려줌).
            settings = await get_platform_settings(session)
            taxed_old_monthly = apply_vat_minor(old_offering.monthly_price_minor, settings.vat_rate_bp)
            refund_amount = prorate_minor(
                taxed_old_monthly, now=now,
                period_start=old_period_start, period_end=old_period_end,
            )
            if refund_amount > 0:
                await _attempt_partial_refund(
                    session, org_id=org_id, order=old_confirmed_order, refund_amount=refund_amount,
                    from_tier=sub.tier, to_tier=new_tier,
                )
        else:
            logger.warning(
                "tier change org_id=%s: no prior confirmed billing_order to partially refund "
                "(charge already confirmed, tier/period already advanced — skipping refund step)",
                org_id,
            )

        return await _refetch_subscription(session, org_id)
    finally:
        await session.execute(
            update(OrgSubscription)
            .where(OrgSubscription.org_id == org_id, OrgSubscription.checkout_claimed_at == now)
            .values(checkout_claimed_at=None)
        )
        await session.commit()


async def _attempt_partial_refund(
    session: AsyncSession, *, org_id: uuid.UUID, order: BillingOrder, refund_amount: int,
    from_tier: str, to_tier: str,
) -> None:
    """구 결제 건에 잔여기간 일할 부분취소 — 실패해도 예외를 전파하지 않는다(④, 선생님
    지시: 이미 confirmed된 신규 charge를 되돌리지 않는다). 결과는 billing_orders.
    refund_status에 명시 기록(0267) — 향후 재시도/스윕이 이 필드로 찾는다(이 스토리는
    스윕 자체는 안 짓는다)."""
    try:
        await refund_org(
            session, org_id=org_id, order_id=order.order_id,
            cancel_reason=f"tier change {from_tier}->{to_tier} — prorated remainder",
            cancel_amount_minor=refund_amount,
        )
        refund_status = "confirmed"
    except Exception as exc:
        # 카디르 MEDIUM(2026-08-21, PR#3306 리뷰) — 이전엔 (RefundError, TossApiError)만
        # 좁게 잡아, 그 외 예외(예: Toss 취소는 성공했는데 record_ledger_entry의 DB write가
        # 실패)는 refund_status가 NULL로 남아 스윕이 못 찾는 사각지대였다. 이 함수의 계약
        # 자체가 "실패해도 절대 전파 안 함"이라(④) — 예외 종류를 좁혀 잡을 이유가 없다,
        # 전부 잡아 반드시 'failed'를 남긴다.
        logger.error(
            "tier change org_id=%s order_id=%s: partial refund FAILED(amount=%d) — %s. "
            "charge already confirmed, NOT rolled back — needs retry/sweep.",
            org_id, order.order_id, refund_amount, exc,
        )
        refund_status = "failed"

    await session.execute(
        update(BillingOrder).where(BillingOrder.id == order.id).values(refund_status=refund_status)
    )
    await session.commit()
