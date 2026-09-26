"""story #4335 — 결제 시도(checkout · change-tier): 요청은 시도를 만들고 곧바로 돌려주고, 결과는 시도 행으로 확정한다.

왜: 한 요청이 Toss 왕복(빌링키 15초 + 옛 키 삭제 15초 + 청구 65초 …)을 다 기다리면 최악 95~110초라, 브라우저(30초) ·
프런트 Cloud Run(60초)이 먼저 끊는다 — 사용자는 실패를 보는데 청구는 끝날 수 있고, 다시 누르면 새 요청이 됐다.

**실행 자리**(PO 01:27Z 확인): 백엔드는 요청 처리 중에만 CPU(cpu-throttling 기본) · 작업 실행 기반(Cloud Tasks) 없음. 그래서
응답 뒤 작업(BackgroundTasks)이 느려지거나 인스턴스와 함께 사라져도 **결과가 틀리면 안 된다** — 진행과 확정은 «시도에 박힌
order_id + Toss orderId 멱등 + 이 행의 토큰 울타리»에 기댄다. 누가 몰고 가든(응답 뒤 작업 · 조회 대사 · 쓸기) 청구는 1.

**경합 규칙**(PR 본문 경합 표와 같은 내용):
1. 시작(`start_*_attempt`) — 같은 id가 이미 있으면 그 행을 돌려줄 뿐 새 작업 0. 새 시도는 org 결제 슬롯 claim과 시도 행 INSERT를
   한 트랜잭션으로 · 이 org에 진행 중 시도가 있으면(먼저 대사해 보고도 여전하면) 409.
2. 모는 쪽은 `lease_token`을 쥔다(시작이 응답 뒤 작업에 토큰을 건넴 · 조회 대사는 기한 지난 토큰만 원자적으로 빼앗음).
3. **청구 직전 울타리**(`_fence_charge_start`): 시도 행 `FOR UPDATE` → 진행 중 · 내 토큰 · 기한 안일 때만 `stage=charge_started` ·
   `charge_started_at` 커밋 → 그다음에만 Toss 청구. 울타리를 못 넘으면 Toss를 부르지 않는다.
4. 청구 호출 바로 앞 시한(`SEND_DEADLINE`) — 넘기면 부르지 않고 «청구 0»으로 끝낸다(`charge_org(send_deadline=)`).
5. 대사(`reconcile_attempt`)는 Toss를 **조회만** 한다(청구 호출 0). `charge_started` 전 단계 = 청구 0이 행으로 증명 → failed.
   `charge_started`면 order_id로 조회 → DONE이면 확정 · Toss가 모른다(NOT_FOUND)면 `charge_started_at` + `NOT_FOUND_FAIL_AFTER`
   (시한 + Toss 한도보다 훨씬 긴 10분)가 지난 뒤에만 failed — 그전엔 «확인 중» 유지.
6. 끝내기(`_finish` · `_finalize`)는 시도 행 `FOR UPDATE` + 진행 중 + 내 토큰일 때만 · 구독 전이 · 시도 전이 · 슬롯 해제를 한 커밋으로.
"""
from __future__ import annotations

import logging
import uuid
from collections.abc import Callable
from datetime import datetime, timedelta, timezone

from sqlalchemy import select, update
from sqlalchemy.dialects.postgresql import insert as pg_insert
from sqlalchemy.ext.asyncio import AsyncSession

from app.models.billing_order import BillingOrder
from app.models.billing_payment_attempt import BillingPaymentAttempt
from app.models.offering_version import OfferingVersion
from app.models.org_subscription import OrgSubscription
from app.services import org_subscription_checkout as checkout_svc
from app.services import org_subscription_tier_change as tier_svc
from app.services.billing_charge import ChargeSendDeadlinePassed, _confirm_with_ledger, charge_org
from app.services.billing_charge_amount import ChargeAmountError, compute_charge_amount, compute_full_charge_for_new_offering
from app.services.org_billing_key import issue_billing_key
from app.services.payment.toss_adapter import TossAdapter, TossApiError

logger = logging.getLogger(__name__)

# 응답 뒤 작업이 한 시도를 쥐는 기한 — 정상 왕복(빌링키 15 + 옛 키 삭제 15 + 청구 65 + DB)보다 넉넉히.
WORKER_LEASE = timedelta(seconds=150)
# 청구 직전 울타리를 넘은 뒤 기한 — Toss 청구 한도(65초) + 여유.
CHARGE_LEASE = timedelta(seconds=120)
# 울타리 커밋 뒤 이 시간 안에 Toss 청구를 보내지 못하면 보내지 않는다(사이엔 빌링키 조회 · 복호화뿐).
SEND_DEADLINE = timedelta(seconds=20)
# 조회 대사가 쥐는 기한(조회 15초 + 확정 쓰기).
RECONCILE_LEASE = timedelta(seconds=60)
# «청구 시작» 뒤 Toss가 이 order를 모른다(NOT_FOUND)고 해도, 이만큼 지나기 전엔 «청구 0»으로 적지 않는다
# (SEND_DEADLINE + Toss 한도 65초보다 훨씬 김 — 그 뒤엔 누구도 이 order_id로 Toss를 부를 수 없다).
NOT_FOUND_FAIL_AFTER = timedelta(minutes=10)

REASON_INTERRUPTED_BEFORE_CHARGE = "interrupted_before_charge"
REASON_SEND_DEADLINE = "charge_not_sent_deadline_passed"
REASON_NOT_FOUND_AT_TOSS = "charge_not_found_at_toss"


class AttemptNotFound(Exception):
    """이 org의 시도가 아니거나 없는 id — 라우터가 404."""


def _now() -> datetime:
    return datetime.now(timezone.utc)


def checkout_order_id(attempt_id: uuid.UUID) -> str:
    # Toss orderId: 6~64자 · 영문 · 숫자 · '-' · '_' — `checkout-` + 32자.
    return f"checkout-{attempt_id.hex}"


def tier_change_order_id(attempt_id: uuid.UUID) -> str:
    return f"tierchange-{attempt_id.hex}"


async def get_attempt(session: AsyncSession, attempt_id: uuid.UUID, *, org_id: uuid.UUID | None = None) -> BillingPaymentAttempt:
    attempt = (
        await session.execute(
            select(BillingPaymentAttempt)
            .where(BillingPaymentAttempt.id == attempt_id)
            .execution_options(populate_existing=True)
        )
    ).scalar_one_or_none()
    if attempt is None or (org_id is not None and attempt.org_id != org_id):
        raise AttemptNotFound(str(attempt_id))
    return attempt


async def _existing_same_org(session: AsyncSession, attempt_id: uuid.UUID, org_id: uuid.UUID, kind: str) -> BillingPaymentAttempt | None:
    try:
        existing = await get_attempt(session, attempt_id)
    except AttemptNotFound:
        return None
    if existing.org_id != org_id or existing.kind != kind:
        raise AttemptNotFound(str(attempt_id))
    return existing


async def _settle_other_processing(session: AsyncSession, org_id: uuid.UUID, attempt_id: uuid.UUID) -> bool:
    """이 org에 다른 진행 중 시도가 있으면 먼저 대사해 본다 — 그래도 진행 중이면 True(새 시도는 409)."""
    others = (
        await session.execute(
            select(BillingPaymentAttempt.id).where(
                BillingPaymentAttempt.org_id == org_id,
                BillingPaymentAttempt.status == "processing",
                BillingPaymentAttempt.id != attempt_id,
            )
        )
    ).scalars().all()
    busy = False
    for other_id in others:
        other = await reconcile_attempt(session, other_id)
        busy = busy or other.status == "processing"
    return busy


async def start_checkout_attempt(
    session: AsyncSession, *, attempt_id: uuid.UUID, org_id: uuid.UUID, requested_by: uuid.UUID | None,
    tier: str, billing_cycle: str,
) -> tuple[BillingPaymentAttempt, uuid.UUID | None]:
    """(시도, 응답 뒤 작업에 건넬 토큰). 토큰이 None이면 이미 있던 시도 — 새 작업 0."""
    existing = await _existing_same_org(session, attempt_id, org_id, "checkout")
    if existing is not None:
        return existing, None

    offering = await checkout_svc.validate_checkout(
        session, org_id=org_id, tier=tier, billing_cycle=billing_cycle, allow_same_active=False,
    )
    if await _settle_other_processing(session, org_id, attempt_id):
        raise checkout_svc.CheckoutInProgress(f"org_id={org_id}: another payment is in progress — retry after it finishes")

    now = _now()
    token = uuid.uuid4()
    if not await checkout_svc.claim_checkout_slot(
        session, org_id=org_id, tier=tier, billing_cycle=billing_cycle, offering=offering, now=now, commit=False,
    ):
        await session.rollback()
        # 같은 id가 동시에 두 번 왔다면 먼저 온 쪽이 슬롯을 쥔 것 — 그 시도를 돌려준다.
        existing = await _existing_same_org(session, attempt_id, org_id, "checkout")
        if existing is not None:
            return existing, None
        raise checkout_svc.CheckoutInProgress(f"org_id={org_id}: another checkout is in progress — retry after it finishes")

    inserted = await _insert_attempt(
        session, attempt_id=attempt_id, org_id=org_id, requested_by=requested_by, kind="checkout", tier=tier,
        billing_cycle=billing_cycle, order_id=checkout_order_id(attempt_id), token=token, now=now,
    )
    if not inserted:
        await session.rollback()
        return await get_attempt(session, attempt_id, org_id=org_id), None
    await session.commit()
    return await get_attempt(session, attempt_id), token


async def start_change_tier_attempt(
    session: AsyncSession, *, attempt_id: uuid.UUID, org_id: uuid.UUID, requested_by: uuid.UUID | None, new_tier: str,
) -> tuple[BillingPaymentAttempt, uuid.UUID | None]:
    existing = await _existing_same_org(session, attempt_id, org_id, "change_tier")
    if existing is not None:
        return existing, None

    _sub, _old_offering, new_offering = await tier_svc.validate_change_tier(session, org_id=org_id, new_tier=new_tier)
    if await _settle_other_processing(session, org_id, attempt_id):
        raise tier_svc.TierChangeInProgress(f"org_id={org_id}: another payment is in progress — retry after it finishes")

    now = _now()
    token = uuid.uuid4()
    if not await tier_svc.claim_tier_change_slot(session, org_id=org_id, now=now, commit=False):
        await session.rollback()
        existing = await _existing_same_org(session, attempt_id, org_id, "change_tier")
        if existing is not None:
            return existing, None
        raise tier_svc.TierChangeInProgress(f"org_id={org_id}: another payment is in progress — retry after it finishes")

    # 부분취소 대상은 지금(새 청구 전) 고정 — 나중에 누가 확정하든 «새 청구 직전의 마지막 구독 결제»가 대상.
    refund_target = await tier_svc.latest_confirmed_subscription_order(session, org_id)
    inserted = await _insert_attempt(
        session, attempt_id=attempt_id, org_id=org_id, requested_by=requested_by, kind="change_tier", tier=new_tier,
        billing_cycle="monthly", order_id=tier_change_order_id(attempt_id), token=token, now=now,
        new_offering_id=new_offering.id, refund_target_order_id=refund_target.order_id if refund_target else None,
    )
    if not inserted:
        await session.rollback()
        return await get_attempt(session, attempt_id, org_id=org_id), None
    await session.commit()
    return await get_attempt(session, attempt_id), token


async def _insert_attempt(
    session: AsyncSession, *, attempt_id: uuid.UUID, org_id: uuid.UUID, requested_by: uuid.UUID | None, kind: str,
    tier: str, billing_cycle: str | None, order_id: str, token: uuid.UUID, now: datetime,
    new_offering_id: uuid.UUID | None = None, refund_target_order_id: str | None = None,
) -> bool:
    result = await session.execute(
        pg_insert(BillingPaymentAttempt).values(
            id=attempt_id, org_id=org_id, requested_by=requested_by, kind=kind, tier=tier, billing_cycle=billing_cycle,
            status="processing", stage="received", order_id=order_id, lease_token=token,
            lease_expires_at=now + WORKER_LEASE, claim_value=now, new_offering_id=new_offering_id,
            refund_target_order_id=refund_target_order_id,
        ).on_conflict_do_nothing(index_elements=["id"])
    )
    return result.rowcount == 1


# ── 모는 쪽(응답 뒤 작업) ──────────────────────────────────────────────────────────────────────────────

def _default_session_factory():
    from app.core.database import async_session_factory

    return async_session_factory


async def run_attempt(
    attempt_id: uuid.UUID, lease_token: uuid.UUID, *, auth_key: str | None = None,
    session_factory: Callable | None = None,
) -> None:
    """응답 뒤 작업 — 자기 세션으로 시도를 끝까지 몬다. 어디서 멈추든(예외 · 인스턴스 소멸) 조회 대사가 이어받는다."""
    factory = session_factory or _default_session_factory()
    try:
        async with factory() as session:
            await drive_attempt(session, attempt_id, lease_token, auth_key=auth_key)
    except Exception:
        logger.exception("payment attempt %s: background run stopped — reconcile will take over", attempt_id)


async def drive_attempt(
    session: AsyncSession, attempt_id: uuid.UUID, lease_token: uuid.UUID, *, auth_key: str | None = None,
) -> None:
    attempt = await get_attempt(session, attempt_id)
    if attempt.status != "processing" or attempt.lease_token != lease_token:
        return

    if attempt.kind == "checkout" and attempt.stage == "received":
        if auth_key is None:
            return  # authKey는 1회용이라 이 작업만 쥔다 — 없으면 대사가 «카드 인증부터 다시»로 끝낸다.
        try:
            await issue_billing_key(session, org_id=attempt.org_id, auth_key=auth_key)
        except TossApiError as exc:
            if exc.status_code >= 500:
                # 까디르 ① — Toss 쪽 오류(5xx)는 거절이 아니라 결과 불명. 청구 단계 전이라 청구 0은 행이 이미 증명 — 대사가 기한 뒤 끝낸다.
                logger.warning("payment attempt %s: billing key issue got Toss %s — leaving for reconcile", attempt_id, exc.status_code)
                return
            # 카드 인증 자체가 거절(4xx) — 청구 단계 전(행: stage=received)이라 청구 0.
            await _finish(session, attempt_id, lease_token, status="failed", reason=f"card auth failed: {exc}", reauth=True)
            return
        if not await _advance_stage(session, attempt_id, lease_token, from_stage="received", to_stage="key_issued"):
            return

    try:
        amount_minor, currency, order_name, ledger_metadata = await _charge_inputs(session, attempt)
    except (ChargeAmountError, tier_svc.TierChangeError) as exc:
        await _finish(session, attempt_id, lease_token, status="failed", reason=f"charge amount: {exc}")
        return

    started = await _fence_charge_start(session, attempt_id, lease_token)
    if started is None:
        return  # 울타리를 못 넘음(대사가 가져갔거나 이미 끝남) — Toss를 부르지 않는다.

    try:
        order = await charge_org(
            session, org_id=attempt.org_id, order_id=attempt.order_id, amount_minor=amount_minor, currency=currency,
            order_name=order_name, ledger_metadata=ledger_metadata, send_deadline=started + SEND_DEADLINE,
        )
    except ChargeSendDeadlinePassed:
        # 이 작업이 보내지 않았고, 대사는 청구를 부르지 않는다 — 이 order_id로 Toss를 부를 수 있는 쪽은 이제 없다.
        await _finish(session, attempt_id, lease_token, status="failed", reason=REASON_SEND_DEADLINE)
        return
    except TossApiError as exc:
        if exc.status_code >= 500:
            # 까디르 ① — Toss 5xx는 «거절»이 아니라 결과 불명(승인됐을 수도). 시도는 진행 중 그대로 · 대사가 order_id 조회로 가린다.
            logger.warning("payment attempt %s: charge got Toss %s — outcome unknown, leaving for reconcile", attempt_id, exc.status_code)
            return
        # Toss가 거절 코드를 준 4xx만 «거절 · 청구 0».
        await _finish(session, attempt_id, lease_token, status="declined", reason=str(exc))
        return
    except RuntimeError:
        # Toss 도달 실패 · 응답 대기 중 끊김 — 청구가 됐는지 모른다. 대사가 order_id 조회로 가린다.
        logger.warning("payment attempt %s: charge outcome unknown — leaving for reconcile", attempt_id)
        return

    if order.status == "confirmed":
        if not await _finalize(session, attempt_id, lease_token):
            # 늦게 돌아온 작업: 그 사이 대사가 이 시도를 가져가 끝냈다. Toss DONE이 진실 — 돈을 받았으면 서비스를 준다(까디르 ④).
            await _late_confirmed(session, attempt_id)


async def _charge_inputs(session: AsyncSession, attempt: BillingPaymentAttempt) -> tuple[int, str, str, dict | None]:
    if attempt.kind == "checkout":
        amount_minor, currency = await compute_charge_amount(session, org_id=attempt.org_id)
        return amount_minor, currency, checkout_svc.checkout_order_name(attempt.tier), None
    sub = (await session.execute(select(OrgSubscription).where(OrgSubscription.org_id == attempt.org_id))).scalar_one()
    new_offering = await session.get(OfferingVersion, attempt.new_offering_id)
    if new_offering is None:
        raise tier_svc.TierChangeError(f"offering_version {attempt.new_offering_id} not found")
    amount_minor, currency = await compute_full_charge_for_new_offering(session, org_id=attempt.org_id, new_offering=new_offering)
    return (
        amount_minor, currency, tier_svc.tier_change_order_name(sub.tier, attempt.tier),
        tier_svc.tier_change_ledger_metadata(sub.tier, attempt.tier),
    )


async def _lock_owned(session: AsyncSession, attempt_id: uuid.UUID, token: uuid.UUID) -> BillingPaymentAttempt | None:
    """시도 행 `FOR UPDATE` — 진행 중이고 토큰이 내 것일 때만 돌려준다(아니면 롤백하고 None)."""
    attempt = (
        await session.execute(
            select(BillingPaymentAttempt)
            .where(BillingPaymentAttempt.id == attempt_id)
            .with_for_update()
            .execution_options(populate_existing=True)
        )
    ).scalar_one()
    if attempt.status != "processing" or attempt.lease_token != token:
        await session.rollback()
        return None
    return attempt


async def _advance_stage(session: AsyncSession, attempt_id: uuid.UUID, token: uuid.UUID, *, from_stage: str, to_stage: str) -> bool:
    attempt = await _lock_owned(session, attempt_id, token)
    if attempt is None or attempt.stage != from_stage:
        await session.rollback()
        return False
    attempt.stage = to_stage
    await session.commit()
    return True


async def _fence_charge_start(session: AsyncSession, attempt_id: uuid.UUID, token: uuid.UUID) -> datetime | None:
    """청구 직전 울타리 — 진행 중 · 내 토큰 · 기한 안일 때만 «청구 시작» 표식을 커밋한다. 반환 = 표식 시각(못 넘으면 None)."""
    attempt = await _lock_owned(session, attempt_id, token)
    now = _now()
    if attempt is None:
        return None
    if attempt.lease_expires_at is None or attempt.lease_expires_at <= now or attempt.stage == "charge_started":
        # 기한이 지났으면 대사가 이미 가져갈 수 있는 상태 — 부르지 않는다. 이미 표식이 있으면(이 토큰이 전에 넘긴 것) 두 번 부르지 않는다.
        await session.rollback()
        return None
    expected = "key_issued" if attempt.kind == "checkout" else "received"
    if attempt.stage != expected:
        await session.rollback()
        return None
    attempt.stage = "charge_started"
    attempt.charge_started_at = now
    attempt.lease_expires_at = now + CHARGE_LEASE
    await session.commit()
    return now


async def _finish(
    session: AsyncSession, attempt_id: uuid.UUID, token: uuid.UUID, *, status: str, reason: str | None, reauth: bool = False,
) -> bool:
    """청구 없이 끝냄(declined · failed) — 시도 전이 + 슬롯 해제를 한 커밋으로."""
    attempt = await _lock_owned(session, attempt_id, token)
    if attempt is None:
        return False
    attempt.status = status
    attempt.reason = (reason or "")[:500] or None
    attempt.reauth_required = reauth
    attempt.finished_at = _now()
    attempt.lease_token = None
    if attempt.claim_value is not None:
        await checkout_svc.release_claim(session, org_id=attempt.org_id, claim_value=attempt.claim_value, commit=False)
    await session.commit()
    return True


async def _finalize(session: AsyncSession, attempt_id: uuid.UUID, token: uuid.UUID) -> bool:
    """청구 confirmed 뒤 권리 전이 — 구독 전이 · 시도 succeeded · 슬롯 해제를 한 커밋으로. change-tier 부분취소는 그 뒤."""
    attempt = await _lock_owned(session, attempt_id, token)
    if attempt is None:
        return False
    if attempt.kind == "checkout":
        changed = await checkout_svc.activate_claimed_subscription(session, org_id=attempt.org_id, claim_value=attempt.claim_value)
    else:
        sub = (
            await session.execute(
                select(OrgSubscription).where(OrgSubscription.org_id == attempt.org_id).execution_options(populate_existing=True)
            )
        ).scalar_one()
        old_offering = await session.get(OfferingVersion, sub.offering_version_id) if sub.offering_version_id else None
        # 까디르 ⑤ — 환불 의도(금액)를 **확정 커밋 전에** 행으로: 확정 뒤 환불 전에 죽어도 쓸기가 같은 멱등키로 이어 보낸다.
        if (
            attempt.refund_target_order_id and old_offering is not None
            and sub.current_period_start is not None and sub.current_period_end is not None
        ):
            amount = await tier_svc.prorated_refund_amount(
                session, old_offering=old_offering, old_period_start=sub.current_period_start,
                old_period_end=sub.current_period_end, now=attempt.claim_value,
            )
            if amount > 0:
                attempt.refund_status = "pending"
                attempt.refund_amount_minor = amount
        changed = await tier_svc.apply_tier_change(
            session, org_id=attempt.org_id, claim_value=attempt.claim_value, new_tier=attempt.tier,
            new_offering_id=attempt.new_offering_id,
        )
    if changed == 0:
        # 슬롯을 다른 작업에 뺏김 — 청구는 확정됐는데 권리 전이를 못 했다. 시도는 succeeded로 두되 사유로 남기고 크게 알린다.
        logger.error("payment attempt %s: charge confirmed but subscription claim lost — rights NOT applied", attempt_id)
        attempt.reason = "charge confirmed; subscription claim lost — rights not applied (needs operator)"
        attempt.refund_status = None
        attempt.refund_amount_minor = None
    attempt.status = "succeeded"
    attempt.stage = "charged"
    attempt.finished_at = _now()
    attempt.lease_token = None
    if attempt.claim_value is not None:
        await checkout_svc.release_claim(session, org_id=attempt.org_id, claim_value=attempt.claim_value, commit=False)
    await session.commit()

    if attempt.refund_status == "pending":
        await run_pending_refund(session, attempt_id)
    return True


async def run_pending_refund(session: AsyncSession, attempt_id: uuid.UUID) -> str | None:
    """change-tier 옛 결제 부분 환불 — 확정 때 적은 의도(pending · 금액)를 보낸다. 멱등키 = 시도 id(Toss `Idempotency-Key`)라 확정 직후
    작업 · 쓸기가 둘 다 보내도 환불은 1. 결과(confirmed/failed)를 시도 행과 옛 주문(refund_status)에 남긴다."""
    attempt = await get_attempt(session, attempt_id)
    if attempt.refund_status != "pending" or not attempt.refund_target_order_id or not attempt.refund_amount_minor:
        return attempt.refund_status
    order = (
        await session.execute(select(BillingOrder).where(BillingOrder.order_id == attempt.refund_target_order_id))
    ).scalar_one_or_none()
    if order is None:
        logger.error("payment attempt %s: refund target %s not found", attempt_id, attempt.refund_target_order_id)
        return attempt.refund_status
    result = await tier_svc._attempt_partial_refund(
        session, org_id=attempt.org_id, order=order, refund_amount=attempt.refund_amount_minor,
        from_tier="previous plan", to_tier=attempt.tier, idempotency_key=f"tierchange-refund-{attempt.id.hex}",
    )
    await session.execute(
        update(BillingPaymentAttempt)
        .where(BillingPaymentAttempt.id == attempt_id, BillingPaymentAttempt.refund_status == "pending")
        .values(refund_status=result)
    )
    await session.commit()
    return result


async def _late_confirmed(session: AsyncSession, attempt_id: uuid.UUID) -> None:
    """까디르 ④ — 늦게 돌아온 작업의 청구가 Toss에서 DONE인데 시도는 이미 대사가 끝냄. succeeded면 할 일 없음(대사가 확정).
    failed/declined로 끝났다면 돈은 받았는데 서비스가 없다 → 시도를 succeeded로 뒤집고 권리를 준다(org 슬롯을 새로 쥐고 확정).
    슬롯이 다른 결제 작업에 쥐여 있으면 권리는 못 주고 크게 알린다(운영자 몫)."""
    attempt = await get_attempt(session, attempt_id)
    if attempt.status == "succeeded":
        return
    logger.error(
        "payment attempt %s: LATE CHARGE — Toss confirmed order %s after the attempt ended %s; reviving to grant rights",
        attempt_id, attempt.order_id, attempt.status,
    )
    now = _now()
    token = uuid.uuid4()
    if not await tier_svc.claim_tier_change_slot(session, org_id=attempt.org_id, now=now, commit=False):
        await session.rollback()
        logger.error("payment attempt %s: LATE CHARGE — org payment slot busy, rights NOT applied (needs operator)", attempt_id)
        await session.execute(
            update(BillingPaymentAttempt).where(BillingPaymentAttempt.id == attempt_id)
            .values(reason="late charge confirmed; org slot busy — rights not applied (needs operator)")
        )
        await session.commit()
        return
    await session.execute(
        update(BillingPaymentAttempt)
        .where(BillingPaymentAttempt.id == attempt_id, BillingPaymentAttempt.status.in_(("failed", "declined")))
        .values(status="processing", lease_token=token, lease_expires_at=now + RECONCILE_LEASE, claim_value=now,
                reason="late charge confirmed after the attempt ended", reauth_required=False, finished_at=None)
    )
    await session.commit()
    await _finalize(session, attempt_id, token)


# ── 조회 대사 ───────────────────────────────────────────────────────────────────────────────────────

async def reconcile_attempt(session: AsyncSession, attempt_id: uuid.UUID) -> BillingPaymentAttempt:
    """상태 조회 · 쓸기 · 새 시도 시작이 부른다. 진행 중인데 모는 쪽 기한이 지났으면 이어받아 결론을 낸다(Toss는 조회만)."""
    attempt = await get_attempt(session, attempt_id)
    now = _now()
    if attempt.status != "processing" or (attempt.lease_expires_at is not None and attempt.lease_expires_at > now):
        return attempt

    token = uuid.uuid4()
    stolen = await session.execute(
        update(BillingPaymentAttempt)
        .where(
            BillingPaymentAttempt.id == attempt_id,
            BillingPaymentAttempt.status == "processing",
            (BillingPaymentAttempt.lease_expires_at.is_(None)) | (BillingPaymentAttempt.lease_expires_at <= now),
        )
        .values(lease_token=token, lease_expires_at=now + RECONCILE_LEASE)
    )
    await session.commit()
    if stolen.rowcount == 0:
        return await get_attempt(session, attempt_id)

    attempt = await get_attempt(session, attempt_id)
    if attempt.stage in ("received", "key_issued"):
        # 청구 단계에 들어가지 않았다는 행 기록 = 청구 0의 근거. checkout이 빌링키 전에 멈췄으면 authKey(1회용)를 다시 못 쓴다.
        await _finish(
            session, attempt_id, token, status="failed", reason=REASON_INTERRUPTED_BEFORE_CHARGE,
            reauth=attempt.kind == "checkout" and attempt.stage == "received",
        )
        return await get_attempt(session, attempt_id)

    if attempt.stage == "charge_started":
        await _reconcile_charge(session, attempt, token, now)
    return await get_attempt(session, attempt_id)


async def _reconcile_charge(session: AsyncSession, attempt: BillingPaymentAttempt, token: uuid.UUID, now: datetime) -> None:
    try:
        lookup = await TossAdapter().get_payment_by_order_id(
            order_id=attempt.order_id, quiet_codes=frozenset({"NOT_FOUND_PAYMENT"}),
        )
    except TossApiError as exc:
        if exc.code == "NOT_FOUND_PAYMENT":
            if attempt.charge_started_at is not None and attempt.charge_started_at <= now - NOT_FOUND_FAIL_AFTER:
                await _mark_order_failed(session, attempt.order_id, REASON_NOT_FOUND_AT_TOSS)
                await _finish(session, attempt.id, token, status="failed", reason=REASON_NOT_FOUND_AT_TOSS)
            else:
                await _hand_back(session, attempt.id, token)
            return
        logger.warning("payment attempt %s: Toss lookup error %s — still checking", attempt.id, exc.code)
        await _hand_back(session, attempt.id, token)
        return
    except Exception:
        logger.warning("payment attempt %s: Toss lookup unreachable — still checking", attempt.id, exc_info=True)
        await _hand_back(session, attempt.id, token)
        return

    status = lookup.get("status")
    if status == "DONE" and lookup.get("paymentKey"):
        order = (await session.execute(select(BillingOrder).where(BillingOrder.order_id == attempt.order_id))).scalar_one_or_none()
        amount_minor = order.amount_minor if order is not None else int(lookup.get("totalAmount") or 0)
        currency = order.currency if order is not None else "krw"
        if order is None:
            logger.error("payment attempt %s: Toss DONE but no billing_orders row for %s", attempt.id, attempt.order_id)
            await _hand_back(session, attempt.id, token)
            return
        ledger_metadata = None
        if attempt.kind == "change_tier":
            sub = (await session.execute(select(OrgSubscription).where(OrgSubscription.org_id == attempt.org_id))).scalar_one()
            ledger_metadata = tier_svc.tier_change_ledger_metadata(sub.tier, attempt.tier)
        await _confirm_with_ledger(
            session, org_id=attempt.org_id, order_id=attempt.order_id, amount_minor=amount_minor, currency=currency,
            payment_key=lookup["paymentKey"], ledger_metadata=ledger_metadata,
            receipt_url=(lookup.get("receipt") or {}).get("url"),
        )
        await _finalize(session, attempt.id, token)
        return
    if status in ("ABORTED", "EXPIRED", "CANCELED"):
        await _mark_order_failed(session, attempt.order_id, f"toss status={status}")
        await _finish(session, attempt.id, token, status="failed", reason=f"toss status={status}")
        return
    await _hand_back(session, attempt.id, token)  # 진행 중(IN_PROGRESS · WAITING_FOR_DEPOSIT 등) — 다음 조회가 다시 본다.


async def _mark_order_failed(session: AsyncSession, order_id: str, reason: str) -> None:
    from app.services.billing_charge import _mark_failed_if_not_confirmed

    await _mark_failed_if_not_confirmed(session, order_id, reason)


async def _hand_back(session: AsyncSession, attempt_id: uuid.UUID, token: uuid.UUID) -> None:
    """결론 없이 돌려놓음 — 기한을 지금으로 당겨 다음 조회가 곧바로 다시 대사할 수 있게."""
    await session.execute(
        update(BillingPaymentAttempt)
        .where(BillingPaymentAttempt.id == attempt_id, BillingPaymentAttempt.lease_token == token)
        .values(lease_expires_at=_now())
    )
    await session.commit()


async def sweep_processing_attempts(session: AsyncSession) -> dict:
    """아무도 조회하지 않은 진행 중 시도를 대사한다(`toss-billing-maintenance` 크론)."""
    now = _now()
    ids = (
        await session.execute(
            select(BillingPaymentAttempt.id).where(
                BillingPaymentAttempt.status == "processing",
                (BillingPaymentAttempt.lease_expires_at.is_(None)) | (BillingPaymentAttempt.lease_expires_at <= now),
            )
        )
    ).scalars().all()
    outcome: dict[str, int] = {"seen": len(ids)}
    for attempt_id in ids:
        try:
            attempt = await reconcile_attempt(session, attempt_id)
        except Exception:
            logger.exception("payment attempt %s: sweep reconcile failed", attempt_id)
            outcome["error"] = outcome.get("error", 0) + 1
            continue
        outcome[attempt.status] = outcome.get(attempt.status, 0) + 1
    # 까디르 ⑤ — 확정은 됐는데 환불을 못 보낸 채 멈춘 시도(환불 대기)를 이어서 보낸다(멱등키 = 시도 id).
    pending = (
        await session.execute(
            select(BillingPaymentAttempt.id).where(
                BillingPaymentAttempt.refund_status == "pending", BillingPaymentAttempt.status == "succeeded",
            )
        )
    ).scalars().all()
    for attempt_id in pending:
        try:
            result = await run_pending_refund(session, attempt_id)
        except Exception:
            logger.exception("payment attempt %s: sweep refund failed", attempt_id)
            result = "error"
        outcome[f"refund_{result}"] = outcome.get(f"refund_{result}", 0) + 1
    return outcome
