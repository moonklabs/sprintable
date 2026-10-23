"""[SID:4728] 조직이 사라졌을 때 그 조직의 결제 상태를 끝낸다.

org_billing_keys / org_subscriptions / billing_orders 는 org_id 에 외래키가 없어, organizations 행이 지워져도 그대로 남는다.
남은 failed 주문은 dunning 스윕(`sweep_dunning_retries`)이 계속 골라 `charge_org` 로 다시 청구하고, 활성 빌링키는 그 청구를 통과시킨다.

두 곳이 같은 문장을 쓴다 — 조직 삭제 트랜잭션(`OrganizationRepository.delete_by_user`)과, 이 PR 이전에 이미 지워진 조직의 잔여 주문을
만났을 때의 `charge_org` 가드. 커밋은 호출자가 한다."""
from __future__ import annotations

import uuid

from sqlalchemy import text
from sqlalchemy.ext.asyncio import AsyncSession

_END_ORG_BILLING_SQL = (
    # failed 주문 → 종결 상태('downgraded': 스윕 대상에서 영구히 빠진다 — downgrade_to_free 와 같은 종결값).
    "UPDATE billing_orders SET status = 'downgraded', updated_at = now() WHERE org_id = :o AND status = 'failed'",
    # 빌링키 폐기 — 암호문까지 비운다.
    (
        "UPDATE org_billing_keys SET status = 'deleted', encrypted_billing_key = NULL"
        " WHERE org_id = :o AND (status <> 'deleted' OR encrypted_billing_key IS NOT NULL)"
    ),
    # 구독 행이 active / past_due 로 남지 않게 — 갱신 cron 은 status = 'active' 만, dunning 은 past_due 를 본다.
    # story #4753: a 'pending' row is a checkout claim — one old enough to be stale (STALE_CLAIM_WINDOW) does not stop the closing, and the late confirmed charge would then turn it 'active' on a
    # closed organization (its CAS is «claim value still mine»). The claim is cleared with the row ended, so that CAS fails and the payment attempt takes its existing «claim lost → voided + refund» road.
    "UPDATE org_subscriptions SET status = 'canceled', checkout_claimed_at = NULL, updated_at = now() WHERE org_id = :o AND status IN ('active', 'past_due', 'pending')",
)


async def end_org_billing(session: AsyncSession, org_id: uuid.UUID) -> None:
    for stmt in _END_ORG_BILLING_SQL:
        await session.execute(text(stmt), {"o": org_id})
