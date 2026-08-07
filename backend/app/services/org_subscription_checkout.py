"""결제②-D선행(story #2502+#2506, PO 확定 2026-08-07) — Toss 구독 체크아웃. org가 Toss
위젯으로 카드 인증을 마친 뒤 도달하는 진입점 — 결제②의 "실 진입점"이 없었던 마지막 갭을
채운다(TossAdapter 호출부 전수 grep으로 확認했던 그 자리).

**상태기계**(PO 확定, "돈이 걸린 판단"으로 명시 승인받은 설계):
1. `issue_billing_key`(C1) — 카드 인증 완료 → 실 빌링키 발급.
2. org_subscription을 status='pending'으로 생성/전이(tier·billing_cycle·offering_version_id·
   current_period 세팅) — **아직 active 아님**.
3. `compute_charge_amount`(#2500) + `charge_org`(C2) — **즉시 1차 청구**(PG 관례상 구독
   시작=즉시 결제·프로레이션 없음·pricing-policy-v2-3에 트라이얼 규정 없음, PO 확定).
4. 청구 **성공 時에만** status='active' 전이. 실패 시 active 세팅 안 함(pending인 채로
   남아 재시도 가능) — "부분실패가 어디서 나도 유료 권리 없음"이 안전한 방향.

⚠️issue_billing_key가 내부에서 자체 commit하는 기존 코드(C1, 이미 리뷰 통과)를 이 스토리
때문에 리팩터하지 않는다(PO 확定) — ①②가 별도 커밋되는 2단계지만, ③에서 구독 active
게이트가 걸려 있어 그 사이 크래시나도 유료 권리가 새지 않는다(무해 — issue_billing_key
자체도 재호출 시 기존 customer_key 재사용이라 안전하게 재시도됨)."""
from __future__ import annotations

import uuid
from datetime import datetime, timezone

from sqlalchemy import select, update
from sqlalchemy.dialects.postgresql import insert as pg_insert
from sqlalchemy.ext.asyncio import AsyncSession

from app.models.offering_version import OfferingVersion
from app.models.org_subscription import OrgSubscription
from app.services.billing_charge import charge_org
from app.services.billing_charge_amount import compute_charge_amount
from app.services.billing_period import new_subscription_period
from app.services.org_billing_key import issue_billing_key
from app.services.payment.toss_adapter import TossApiError

PAID_TIERS = frozenset({"starter", "team", "business"})
BILLING_CYCLES = frozenset({"monthly", "annual"})


class CheckoutError(Exception):
    """체크아웃을 진행할 수 없는 상태 — 명시 실패."""


class CheckoutDeclined(Exception):
    """카드 인증·구독 레코드까지는 성립했으나 즉시 1차 청구가 Toss에 의해 거절됨(카드
    한도·정지 등 비즈니스 사유) — 시스템 오류가 아니다. 구독은 status='pending'으로
    남아(active 아님) 재시도 가능."""

    def __init__(self, message: str, *, subscription: OrgSubscription):
        self.subscription = subscription
        super().__init__(message)


def _checkout_order_id(org_id: uuid.UUID, offering_version_id: uuid.UUID, today: datetime) -> str:
    """결정적 orderId — 같은 org가 같은 offering으로 같은 날 여러 번 요청(더블클릭·FE
    재시도)해도 charge_org의 원자적 claim(#2493)이 같은 order_id로 수렴시켜 중복 Toss
    호출을 막는다. 날짜를 넣는 이유: 순수 (org_id, offering_version_id)만 쓰면 다운그레이드
    後 몇 달 뒤 재구독 시 옛(이미 confirmed) order와 충돌해 새 청구 없이 옛 결과를 그대로
    반환해버린다 — 그건 실 결제 누락이라 날짜로 그 함정을 피한다."""
    return f"checkout:{org_id}:{offering_version_id}:{today.date().isoformat()}"


async def checkout_subscription(
    session: AsyncSession,
    *,
    org_id: uuid.UUID,
    auth_key: str,
    tier: str,
    billing_cycle: str,
) -> OrgSubscription:
    if tier not in PAID_TIERS:
        raise CheckoutError(f"tier={tier!r}는 체크아웃 대상이 아님(free 제외, {sorted(PAID_TIERS)}만)")
    if billing_cycle not in BILLING_CYCLES:
        raise CheckoutError(f"billing_cycle={billing_cycle!r}는 'monthly'/'annual'만 허용")

    offering = (
        await session.execute(
            select(OfferingVersion).where(
                OfferingVersion.tier == tier,
                OfferingVersion.currency == "krw",
                OfferingVersion.effective_to.is_(None),
            )
        )
    ).scalar_one_or_none()
    if offering is None:
        raise CheckoutError(f"tier={tier!r}의 활성 offering_version(krw)을 찾을 수 없음")

    # ① 빌링키 발급(C1 재사용) — 카드 인증 완료.
    await issue_billing_key(session, org_id=org_id, auth_key=auth_key)

    # ② 구독을 'pending'으로 생성/전이 — 아직 active 아님.
    now = datetime.now(timezone.utc)
    period_start, period_end = new_subscription_period(now=now, billing_cycle=billing_cycle)
    stmt = pg_insert(OrgSubscription).values(
        id=uuid.uuid4(), org_id=org_id, tier=tier, billing_cycle=billing_cycle, status="pending",
        provider="toss", currency="krw", offering_version_id=offering.id,
        current_period_start=period_start, current_period_end=period_end,
    ).on_conflict_do_update(
        index_elements=["org_id"],
        set_={
            "tier": tier, "billing_cycle": billing_cycle, "status": "pending",
            "provider": "toss", "currency": "krw", "offering_version_id": offering.id,
            "current_period_start": period_start, "current_period_end": period_end,
        },
    )
    await session.execute(stmt)
    await session.commit()

    # ③ 즉시 1차 청구(#2500 계산 + C2 집행) — 전액·프로레이션 없음(PO 확定).
    amount_minor, currency = await compute_charge_amount(session, org_id=org_id)
    order_id = _checkout_order_id(org_id, offering.id, now)

    try:
        order = await charge_org(
            session, org_id=org_id, order_id=order_id, amount_minor=amount_minor,
            currency=currency, order_name=f"Sprintable {tier} 구독 시작",
        )
    except TossApiError as exc:
        # 카드 거절 등 비즈니스 사유 — 시스템 오류 아님. 구독은 pending인 채(재시도 가능).
        sub = await _refetch_subscription(session, org_id)
        raise CheckoutDeclined(str(exc), subscription=sub) from exc

    # ④ 청구 성공 時에만 active — 그 외(pending=경쟁 중·failed 도달 안 함, 위에서 잡힘)는
    # active로 안 올린다.
    if order.status == "confirmed":
        await session.execute(
            update(OrgSubscription).where(OrgSubscription.org_id == org_id).values(status="active")
        )
        await session.commit()

    return await _refetch_subscription(session, org_id)


async def _refetch_subscription(session: AsyncSession, org_id: uuid.UUID) -> OrgSubscription:
    return (
        await session.execute(select(OrgSubscription).where(OrgSubscription.org_id == org_id))
    ).scalar_one()
