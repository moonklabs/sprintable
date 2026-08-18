"""story #2777(E-ADMIN-REDESIGN·결제 운영) — 어드민 처리 액션(빌링 재시도·사용권 부여).

두 "부품은 있는데 조립 안 됨" 재료를 조립한다(그라운딩 2026-08-18):
- 재시도: `charge_org`(#2493, sweep_dunning_retries가 이미 쓰는 그 함수) 그대로 재사용
  — cron 케이던스(day+1/3/5) 게이트는 걸지 않는다(자동 스윕만의 비즈니스 리듬이지, 수동
  트리거의 안전조건이 아니다 — charge_org 자체가 idempotent/claim을 이미 지킨다). 유일한
  게이트는 "지금 이 order가 정말 failed인가"뿐.
- 사용권: `billing_ledger.record_ledger_entry(entry_type='credit_grant')`만으로는 아무것도
  안 풀린다(org_ledger_balances 소비처 0, 그라운딩 확認) — 실제 gating이 읽는 유일한 값은
  `org_subscriptions.tier`뿐이라, 원장기록 + tier 세팅 두 쓰기를 **같은 세션·같은 트랜잭션**
  으로 묶는다(`record_ledger_entry`가 내부에서 commit하므로, tier 갱신을 그보다 먼저
  flush만 해두면 그 commit이 둘 다 함께 확정한다 — 별도 트랜잭션 관리 불요).

PR2(sweep_expired_grants, 후속 별도 PR)가 되돌릴 재료를 여기서 심는다 — ledger entry의
entry_metadata에 kind/target_tier/prev_tier/grant_expires_at을 남긴다(신규 컬럼 0)."""
from __future__ import annotations

import uuid
from datetime import datetime, timezone
from typing import Literal

from sqlalchemy import select
from sqlalchemy.ext.asyncio import AsyncSession

from app.models.billing_ledger_entry import BillingLedgerEntry
from app.models.billing_order import BillingOrder
from app.models.org_subscription import OrgSubscription
from app.services.billing_charge import charge_org
from app.services.billing_ledger import record_ledger_entry
from app.services.billing_period import _add_months

GrantTier = Literal["starter", "team", "business"]
# grant는 오직 유료 tier로만 — free/overage는 "부여" 대상이 아니다(overage=사용량과금,
# 구독 tier 서열 밖 — PO 판정 2026-08-18).
_TIER_RANK: dict[str, int] = {"free": 0, "starter": 1, "team": 2, "business": 3}


class AdminBillingError(Exception):
    """라우터가 status_code로 매핑. code는 FE가 분기하는 안정 식별자(HTTP status만으론
    "왜"가 안 잡히므로 — retry의 409 ALREADY_HANDLED가 그 예)."""

    def __init__(self, status_code: int, code: str, message: str) -> None:
        self.status_code = status_code
        self.code = code
        self.message = message
        super().__init__(message)


async def retry_billing_order(
    session: AsyncSession, *, org_id: uuid.UUID, order_id: str,
) -> BillingOrder:
    order = (
        await session.execute(
            select(BillingOrder).where(BillingOrder.order_id == order_id, BillingOrder.org_id == org_id)
        )
    ).scalar_one_or_none()
    if order is None:
        raise AdminBillingError(404, "ORDER_NOT_FOUND", f"order {order_id} not found for this org")
    if order.status != "failed":
        # PO 지적(부수 1건) — FE가 "실패"로 오인해 잘못된 복구 행동(예: 재재시도 반복)을
        # 유도하지 않도록 사람이 읽을 사유를 명시한다.
        raise AdminBillingError(
            409, "ALREADY_HANDLED",
            f"이미 처리됨 — 현재 상태: {order.status}(재시도 불필요)",
        )

    await charge_org(
        session, org_id=org_id, order_id=order.order_id,
        amount_minor=order.amount_minor, currency=order.currency,
    )
    return (
        await session.execute(select(BillingOrder).where(BillingOrder.order_id == order_id))
    ).scalar_one()


async def grant_credit(
    session: AsyncSession,
    *,
    org_id: uuid.UUID,
    target_tier: GrantTier,
    months: int,
    reason: str,
    amount_minor: int,
    currency: str,
    idempotency_key: str,
    actor_email: str,
    now: datetime | None = None,
) -> BillingLedgerEntry:
    now = now or datetime.now(timezone.utc)

    sub = (
        await session.execute(select(OrgSubscription).where(OrgSubscription.org_id == org_id))
    ).scalar_one_or_none()
    current_tier = sub.tier if sub is not None else "free"
    if _TIER_RANK[target_tier] < _TIER_RANK.get(current_tier, 0):
        raise AdminBillingError(
            422, "GRANT_WOULD_DOWNGRADE",
            f"target_tier({target_tier})가 현재 tier({current_tier})보다 낮음 — grant는 강등을 하지 않는다",
        )

    period_end = _add_months(now, months)
    metadata = {
        "kind": "tier_grant",
        "target_tier": target_tier,
        "prev_tier": current_tier,
        "grant_expires_at": period_end.isoformat(),
        "months": months,
        "granted_by": actor_email,
        "reason": reason,
    }

    # tier bump — flush만(commit은 record_ledger_entry가 아래서 함께 확정, 모듈 docstring 참고).
    if sub is None:
        sub = OrgSubscription(
            id=uuid.uuid4(), org_id=org_id, tier=target_tier, status="active",
            currency=currency, current_period_start=now, current_period_end=period_end,
        )
        session.add(sub)
    else:
        sub.tier = target_tier
        sub.status = "active"
        sub.current_period_start = now
        sub.current_period_end = period_end
    await session.flush()

    return await record_ledger_entry(
        session, org_id=org_id, entry_type="credit_grant",
        amount_minor=amount_minor, currency=currency, direction="credit",
        provider_ref=idempotency_key, metadata=metadata,
    )
