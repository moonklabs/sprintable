"""결제②-C2(story #2493) — charge 오케스트레이션: orderId-먼저-기록 → TossAdapter.charge →
billing_ledger_entries 원장 기입. PO 계약(2026-08-07, `toss-adapter-c-plan-v0-1` §8 C2):
**메커니즘만** — amount/currency/order_id는 파라미터로 받는다(「얼마 청구할지」 계산은
별도 pricing-calc 스토리, offering_version×좌석×팩이 아직 배선 안 됨).

PO 정밀 리뷰(#2882, 2026-08-07) — 「돈 움직이는」 스토리가 지켜야 할 crash/동시성
무결성 불변식 둘을 여기서 강제한다:
⛔블로커1(레이스) — confirmed를 failed가 절대 덮어쓰지 않는다. `_mark_failed_if_not_confirmed`
   가 모든 실패 경로의 유일한 실패-기록 통로(status!='confirmed' 가드). 근본은 그 위:
   pending을 **원자적으로 claim**(INSERT..ON CONFLICT DO NOTHING)해 애초에 같은 order_id를
   두 세션이 동시에 Toss로 보내는 상황 자체를 구조적으로 차단한다 — advisory lock 불요,
   UNIQUE 제약 자체가 락이다.
⛔블로커2(비원자 saga) — confirmed ⟹ 원장 존재 불변식. 원장 기입을 confirmed-update
   **前**에 먼저 한다(record_ledger_entry는 provider_ref UNIQUE로 그 자체가 멱등이라
   먼저 해도 안전). 크래시가 원장-기입과 confirmed-update 사이에 나도, 재시도는 Toss의
   DUPLICATED_ORDER_ID를 통해 이 함수로 다시 들어와 `_reconcile_duplicated_order`가
   같은 provider_ref로 no-op 기입 후 confirmed로 정합시킨다.
⚠️DUPLICATED_ORDER_ID(재시도가 이미 성공한 charge를 다시 침) — 진짜 실패가 아니라
   "이미 성공"이라는 신호다. Toss 에러 응답엔 원 paymentKey가 없어(공식 문서 확認)
   `get_payment_by_order_id` 조회로 확인 후 confirmed+원장으로 매핑한다.
"""
from __future__ import annotations

import uuid

from sqlalchemy import func, select, update
from sqlalchemy.dialects.postgresql import insert as pg_insert
from sqlalchemy.ext.asyncio import AsyncSession

from app.models.billing_order import BillingOrder
from app.models.org_billing_key import OrgBillingKey
from app.services.billing_key_crypto import decrypt_billing_key, ensure_configured
from app.services.billing_ledger import record_ledger_entry
from app.services.payment.toss_adapter import DUPLICATED_ORDER_ID, TossAdapter, TossApiError


async def _mark_failed_if_not_confirmed(session: AsyncSession, order_id: str, reason: str) -> None:
    """⛔블로커1 최소-fix 가드(근본은 claim — 아래) — 이미 confirmed인 order를 failed가
    절대 덮어쓰지 못한다."""
    await session.execute(
        update(BillingOrder)
        .where(BillingOrder.order_id == order_id, BillingOrder.status != "confirmed")
        .values(status="failed", failure_reason=reason[:500], updated_at=func.now())
    )
    await session.commit()


async def _refetch(session: AsyncSession, order_id: str) -> BillingOrder:
    return (
        await session.execute(select(BillingOrder).where(BillingOrder.order_id == order_id))
    ).scalar_one()


async def _confirm_with_ledger(
    session: AsyncSession, *, org_id: uuid.UUID, order_id: str,
    amount_minor: int, currency: str, payment_key: str,
    entry_type: str = "charge", ledger_metadata: dict | None = None,
) -> BillingOrder:
    """⛔블로커2 fix — 원장을 confirmed-update **前**에 먼저(멱등 provider_ref).

    entry_type(#2505, story 확장): 기본 "charge"(정기결제)지만 팩 구매처럼 별개
    entry_type으로 원장에 남겨야 하는 호출자를 위해 파라미터화 — direction은 여전히
    "credit"(돈이 들어옴)로 고정, 팩/정기결제 둘 다 매출이라 방향은 같다."""
    await record_ledger_entry(
        session, org_id=org_id, entry_type=entry_type, amount_minor=amount_minor,
        currency=currency, direction="credit", provider="toss", provider_ref=payment_key,
        metadata=ledger_metadata,
    )
    await session.execute(
        update(BillingOrder)
        .where(BillingOrder.order_id == order_id, BillingOrder.status != "confirmed")
        .values(status="confirmed", payment_key=payment_key, updated_at=func.now())
    )
    await session.commit()
    return await _refetch(session, order_id)


async def _reconcile_duplicated_order(
    session: AsyncSession, *, org_id: uuid.UUID, order_id: str, amount_minor: int, currency: str,
    entry_type: str = "charge", ledger_metadata: dict | None = None,
) -> BillingOrder:
    """Toss가 DUPLICATED_ORDER_ID를 낸 경우 — 실 상태를 조회해 정합시킨다. DONE이면
    "이미 성공"이었던 것(진짜 실패 아님) — confirmed+원장. 그 외(취소 등)면 failed."""
    lookup = await TossAdapter().get_payment_by_order_id(order_id=order_id)
    if lookup.get("status") != "DONE":
        await _mark_failed_if_not_confirmed(
            session, order_id, f"duplicated order lookup status={lookup.get('status')}"
        )
        return await _refetch(session, order_id)

    payment_key = lookup.get("paymentKey")
    if not payment_key:
        await _mark_failed_if_not_confirmed(session, order_id, "duplicated order lookup missing paymentKey")
        return await _refetch(session, order_id)

    return await _confirm_with_ledger(
        session, org_id=org_id, order_id=order_id, amount_minor=amount_minor,
        currency=currency, payment_key=payment_key, entry_type=entry_type, ledger_metadata=ledger_metadata,
    )


async def charge_org(
    session: AsyncSession,
    *,
    org_id: uuid.UUID,
    order_id: str,
    amount_minor: int,
    currency: str,
    order_name: str = "Sprintable 정기결제",
    entry_type: str = "charge",
    ledger_metadata: dict | None = None,
) -> BillingOrder:
    """org의 활성 빌링키로 결제를 승인한다. 호출자(story C3 스케줄러·#2506 체크아웃·#2505
    팩 구매)가 amount/currency/order_id를 이미 계산해 넘긴다 — 여기는 그 값을 안전하게
    집행하는 메커니즘만 진다.

    entry_type/ledger_metadata(#2505 확장): 원장에 남길 entry_type을 파라미터화 — 정기
    결제는 기본값 "charge" 그대로, 팩 구매 같은 별개 매출 종류는 호출자가 지정한다
    (예: "pack_purchase" + metadata={"resource":..., "quantity":...})."""
    if amount_minor <= 0:
        raise ValueError(f"amount_minor must be positive: {amount_minor!r}")

    # ⭐블로커1 근본fix — 원자적 claim. ON CONFLICT DO NOTHING이 성공(rowcount==1)한
    # 호출만 이 order_id의 charge 시도를 "소유"한다.
    claim_stmt = pg_insert(BillingOrder).values(
        id=uuid.uuid4(), org_id=org_id, order_id=order_id,
        amount_minor=amount_minor, currency=currency, status="pending",
    ).on_conflict_do_nothing(index_elements=["order_id"])
    claim_result = await session.execute(claim_stmt)
    await session.commit()
    owns_attempt = claim_result.rowcount == 1

    if not owns_attempt:
        existing = await _refetch(session, order_id)
        if existing.status in ("confirmed", "pending"):
            # confirmed = 진짜 멱등(Toss 재호출 없이 반환). pending = 다른 호출이 지금
            # 처리 중이거나 이전 크래시로 멈춘 것 — 이 호출은 소유권이 없으니 끼어들어
            # 동시 Toss 호출을 만들지 않는다(재시도/대사는 C3/C4 스케줄러 몫).
            return existing
        # status == "failed" — 재시도 허용. CAS(failed→pending)에 성공한 호출만 소유한다.
        reclaim = await session.execute(
            update(BillingOrder)
            .where(BillingOrder.order_id == order_id, BillingOrder.status == "failed")
            .values(status="pending", updated_at=func.now())
        )
        await session.commit()
        if reclaim.rowcount == 0:
            return await _refetch(session, order_id)  # 레이스 패배 — 다른 호출이 이미 처리 중.

    # PO nit①과 동일 규율(C1 리뷰, #2880) — 되돌릴 수 없는 Toss charge 前에 암호화 키
    # 가용성부터 확認(malformed 키까지 실제 구성해 검증).
    ensure_configured()

    billing_key_row = (
        await session.execute(
            select(OrgBillingKey).where(
                OrgBillingKey.org_id == org_id, OrgBillingKey.status == "active"
            )
        )
    ).scalar_one_or_none()
    if billing_key_row is None:
        await _mark_failed_if_not_confirmed(session, order_id, f"no active billing key for org {org_id}")
        raise RuntimeError(f"no active billing key for org {org_id}")

    billing_key_plaintext = decrypt_billing_key(billing_key_row.encrypted_billing_key)
    try:
        result = await TossAdapter().charge(
            billing_key=billing_key_plaintext,
            customer_key=billing_key_row.customer_key,
            order_id=order_id,
            amount_minor=amount_minor,
            order_name=order_name,
        )
    except TossApiError as exc:
        if exc.code == DUPLICATED_ORDER_ID:
            # ⚠️진짜 실패 아님 — 이 orderId는 이미 처리된 적 있다는 뜻(Toss orderId 멱등).
            return await _reconcile_duplicated_order(
                session, org_id=org_id, order_id=order_id,
                amount_minor=amount_minor, currency=currency,
                entry_type=entry_type, ledger_metadata=ledger_metadata,
            )
        await _mark_failed_if_not_confirmed(session, order_id, str(exc)[:500])
        raise
    except RuntimeError as exc:  # 네트워크 등 Toss API 도달 자체 실패
        await _mark_failed_if_not_confirmed(session, order_id, str(exc)[:500])
        raise
    finally:
        # ⛔PO guard② — 평문 스코프 최소화(best-effort, 이 함수 프레임을 벗어나지 않는다).
        billing_key_plaintext = None  # noqa: F841

    payment_key = result.get("paymentKey")
    if not payment_key:
        await _mark_failed_if_not_confirmed(session, order_id, "Toss charge response missing paymentKey")
        raise RuntimeError("Toss charge response missing paymentKey")

    return await _confirm_with_ledger(
        session, org_id=org_id, order_id=order_id, amount_minor=amount_minor,
        currency=currency, payment_key=payment_key, entry_type=entry_type, ledger_metadata=ledger_metadata,
    )
