"""결제②-C3(story #2494) — 정기결제 재시도 상태기계 + 대사(reconciliation) 골격.

PO 계약(2026-08-07, this thread) — **(b)-narrowed**: "오늘 누구를 얼마 청구할지"(신규
결제 주기 도래 판정)는 이 스토리 밖이다. 그라운딩 결과 `org_subscriptions.
current_period_start/end`가 Toss 구독에는 애초에 채워지는 경로가 없다는 걸 확認했고
(Polar 웹훅 경로에서만 쓰임) — 그 갭은 별도 스토리([#2502](entity:story:089a6cc5-fd10-47a1-8322-cac89b1359d9))로 적어뒀다.
`trigger_due_charges()`가 그 훅 자리(NotImplementedError로 명시 — PolarAdapter/TossAdapter
의 미구현 메서드 관례와 동형).

이 스토리가 실제로 구현하는 것 — 데이터 소스가 **이미 있는** 두 축:
1. **dunning 재시도**: C2(#2493)가 만든 `billing_orders`의 `failed` 행을 스윕. 케이던스는
   지어내지 않고 정책 문서에서 짚었다(PO 가드①) — `pricing-policy-proposal-v1` §12.1을
   2026-08-07 직접 재확認: 최초실패(과금 유지)→+1일 1차 재결제→+3일 2차→+5일 3차→
   +7일 유예종료알림(재시도 아님)→+8일 Free 강제전환.
2. **대사(reconciliation)**: `pending`으로 너무 오래 멈춘 order(C2가 크래시/타임아웃
   대비로 만든 그 상태) — Toss 조회(`get_payment_by_order_id`)로 실 상태를 확認해 정합.
   C2가 "스코프 밖"으로 남긴 그 자리(§2 step8 "일일 대사").
"""
from __future__ import annotations

import logging
import uuid
from datetime import datetime, timedelta, timezone

from sqlalchemy import select
from sqlalchemy.dialects.postgresql import insert as pg_insert
from sqlalchemy.ext.asyncio import AsyncSession

from app.models.billing_order import BillingOrder
from app.models.offering_version import OfferingVersion
from app.models.org_subscription import OrgSubscription
from app.services.billing_charge import (
    _confirm_with_ledger,
    _mark_failed_if_not_confirmed,
    charge_org,
)
from app.services.payment.toss_adapter import TossAdapter

logger = logging.getLogger(__name__)

# pricing-policy-proposal-v1 §12.1(2026-08-07 재확認) — 지어내지 않음, 문서 원문 그대로.
_DUNNING_RETRY_DAYS = frozenset({1, 3, 5})
_DUNNING_DOWNGRADE_DAY = 8

# Toss charge는 최대 60초(공식 문서) — 그보다 넉넉히 오래 pending이면 크래시/타임아웃으로
# 간주해 대사 대상.
PENDING_STALE_AFTER = timedelta(minutes=5)


def next_dunning_action(order: BillingOrder, *, now: datetime) -> str:
    """failed order 하나에 대해 지금 뭘 해야 하는지 — 순수 함수(DB/네트워크 접촉 없음).
    "wait" | "retry" | "downgrade_to_free" 중 하나.

    같은 날 중복 재시도 방지: `updated_at`이 오늘 이미 갱신됐으면(=오늘 이미 시도함) 또
    재시도하지 않는다 — cron이 하루에 여러 번 돌아도(예: */10분) 하루 1회만 재결제한다."""
    if order.status != "failed":
        return "wait"
    age_days = (now.date() - order.created_at.date()).days
    if age_days >= _DUNNING_DOWNGRADE_DAY:
        return "downgrade_to_free"
    already_attempted_today = order.updated_at.date() >= now.date()
    if age_days in _DUNNING_RETRY_DAYS and not already_attempted_today:
        return "retry"
    return "wait"


async def downgrade_to_free(session: AsyncSession, org_id: uuid.UUID) -> None:
    """§12.1 +8일 — Free 권리로 전환. 기존 데이터는 절대 지우지 않는다(정책 명시) — 이
    함수는 구독 tier만 되돌린다, 데이터 삭제/에이전트 강제해제는 정책상 없음(§12.1 원문:
    "이미 등록된 에이전트를 강제 해제하지 않는다")."""
    free_offering = (
        await session.execute(
            select(OfferingVersion).where(
                OfferingVersion.tier == "free",
                OfferingVersion.currency == "krw",
                OfferingVersion.effective_to.is_(None),
            )
        )
    ).scalar_one_or_none()

    stmt = pg_insert(OrgSubscription).values(
        id=uuid.uuid4(), org_id=org_id, tier="free", status="active",
        provider="toss", currency="krw", billing_cycle=None,
        offering_version_id=free_offering.id if free_offering else None,
    ).on_conflict_do_update(
        index_elements=["org_id"],
        set_={
            "tier": "free", "status": "active",
            "offering_version_id": free_offering.id if free_offering else None,
        },
    )
    await session.execute(stmt)
    await session.commit()


async def sweep_dunning_retries(session: AsyncSession, *, now: datetime | None = None) -> dict:
    """failed billing_orders를 스윕 — §12.1 케이던스대로 재시도하거나 Free로 전환."""
    now = now or datetime.now(timezone.utc)
    failed_orders = (
        await session.execute(select(BillingOrder).where(BillingOrder.status == "failed"))
    ).scalars().all()

    retried = downgraded = 0
    for order in failed_orders:
        action = next_dunning_action(order, now=now)
        if action == "retry":
            try:
                # charge_org 자체가 이미 claim/멱등/원장 불변식을 다 지킨다(#2493) — 여기서는
                # 그냥 같은 order_id/amount로 재호출만 한다. 실패해도 charge_org 내부에서
                # 이미 failed로 재기록됐으니 여기선 로깅만(다음 스윕이 또 판단).
                await charge_org(
                    session, org_id=order.org_id, order_id=order.order_id,
                    amount_minor=order.amount_minor, currency=order.currency,
                )
            except Exception:
                logger.exception("dunning retry failed for order_id=%s", order.order_id)
            retried += 1
        elif action == "downgrade_to_free":
            await downgrade_to_free(session, order.org_id)
            downgraded += 1

    return {"failed_orders_seen": len(failed_orders), "retried": retried, "downgraded": downgraded}


async def sweep_stale_pending_orders(session: AsyncSession, *, now: datetime | None = None) -> dict:
    """PENDING_STALE_AFTER보다 오래 pending인 order를 Toss 조회로 대사한다 — C2가 "일일
    대사" 스코프 밖으로 남긴 그 자리(orderId-먼저-기록 설계의 짝: 기록은 됐는데 Toss 응답을
    못 받은 채 죽은 프로세스를 여기서 회수한다)."""
    now = now or datetime.now(timezone.utc)
    cutoff = now - PENDING_STALE_AFTER
    stale_orders = (
        await session.execute(
            select(BillingOrder).where(BillingOrder.status == "pending", BillingOrder.created_at < cutoff)
        )
    ).scalars().all()

    confirmed = failed = 0
    for order in stale_orders:
        try:
            lookup = await TossAdapter().get_payment_by_order_id(order_id=order.order_id)
        except Exception:
            logger.exception("stale pending reconciliation lookup failed for order_id=%s", order.order_id)
            await _mark_failed_if_not_confirmed(session, order.order_id, "reconciliation lookup failed")
            failed += 1
            continue

        if lookup.get("status") == "DONE" and lookup.get("paymentKey"):
            await _confirm_with_ledger(
                session, org_id=order.org_id, order_id=order.order_id,
                amount_minor=order.amount_minor, currency=order.currency,
                payment_key=lookup["paymentKey"],
            )
            confirmed += 1
        else:
            await _mark_failed_if_not_confirmed(
                session, order.order_id, f"stale pending — lookup status={lookup.get('status')}"
            )
            failed += 1

    return {"stale_pending_seen": len(stale_orders), "confirmed": confirmed, "failed": failed}


async def trigger_due_charges(session: AsyncSession) -> dict:
    """오늘 신규 결제 주기가 도래한 org를 찾아 charge_org를 트리거하는 자리 — 이 스토리
    스코프 밖(PO 확認, 2026-08-07). `org_subscriptions.current_period_start/end`가 Toss
    구독에 세팅되는 경로 자체가 아직 없다(story #2502가 그 전제를 채운다). #2502 완료
    후 이 함수를 채운다."""
    raise NotImplementedError(
        "trigger_due_charges — blocked on story #2502(Toss 구독 주기 확定). "
        "org_subscriptions.current_period_start/end가 Toss 경로에 세팅되지 않아 "
        "\"누가 오늘 청구 대상인지\" 판단할 데이터 소스가 없다."
    )
