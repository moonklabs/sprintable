"""결제②-C1(story #2492) — org_billing_keys 오케스트레이션: customerKey 발급 + Toss
create_billing_key 호출 + 암호화 저장. `app/services/billing_ledger.py`(A2, ON CONFLICT
DO NOTHING 멱등 기입)와 다르게 이 테이블은 org당 1행을 **갱신**한다(카드 교체 = 재발급)이라
ON CONFLICT DO UPDATE를 쓴다 — org_billing_keys는 append-only가 아니다.
"""
from __future__ import annotations

import uuid
from datetime import datetime, timezone

from sqlalchemy import select
from sqlalchemy.dialects.postgresql import insert as pg_insert
from sqlalchemy.ext.asyncio import AsyncSession

from app.models.org_billing_key import OrgBillingKey
from app.services.billing_key_crypto import encrypt_billing_key
from app.services.payment.toss_adapter import TossAdapter


def generate_customer_key(org_id: uuid.UUID) -> str:
    """Toss 요구: 2~300자·특수문자(-_=.@) 최소 1개 포함·충분히 무작위. org_id를 그대로
    쓰지 않는다(순차 UUID라도 org_id는 여러 API 응답에 노출되는 값이라 「추측 불가능」 요건과
    별개 축 — 신규 랜덤 성분을 더한다)."""
    return f"org-{uuid.uuid4()}"


async def issue_billing_key(
    session: AsyncSession, *, org_id: uuid.UUID, auth_key: str
) -> OrgBillingKey:
    """FE 위젯 인증 완료 후 authKey로 실 빌링키를 발급받아 저장한다.

    기존 행이 있으면(재발급 = 카드 교체) 그 customer_key를 재사용 — Toss 쪽 고객 식별을
    유지한다. 새 billingKey로 UPDATE(이전 빌링키의 Toss측 폐기는 story C4 대상, 여기서는
    저장 갱신만)."""
    existing = (
        await session.execute(select(OrgBillingKey).where(OrgBillingKey.org_id == org_id))
    ).scalar_one_or_none()
    customer_key = existing.customer_key if existing is not None else generate_customer_key(org_id)

    result = await TossAdapter().create_billing_key(auth_key=auth_key, customer_key=customer_key)

    # ⛔PO guard② — 평문은 이 스코프를 벗어나지 않는다: 암호화해 encrypted 변수로 즉시 대체.
    encrypted = encrypt_billing_key(result["billingKey"])

    card = result.get("card") or {}
    authenticated_at_raw = result.get("authenticatedAt")
    issued_at = (
        datetime.fromisoformat(authenticated_at_raw) if authenticated_at_raw else datetime.now(timezone.utc)
    )

    values = dict(
        org_id=org_id,
        customer_key=customer_key,
        encrypted_billing_key=encrypted,
        card_issuer_code=card.get("issuerCode"),
        card_acquirer_code=card.get("acquirerCode"),
        card_number_masked=card.get("number"),
        card_type=card.get("cardType"),
        card_owner_type=card.get("ownerType"),
        status="active",
        issued_at=issued_at,
    )
    stmt = pg_insert(OrgBillingKey).values(id=uuid.uuid4(), **values)
    stmt = stmt.on_conflict_do_update(
        index_elements=["org_id"],
        set_={k: v for k, v in values.items() if k not in ("org_id", "customer_key")},
    )
    await session.execute(stmt)
    await session.commit()

    return (
        await session.execute(select(OrgBillingKey).where(OrgBillingKey.org_id == org_id))
    ).scalar_one()
