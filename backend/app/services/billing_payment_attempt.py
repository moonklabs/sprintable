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

**종결 규칙**(PO 04:08Z — «Toss 쪽 결과를 모르는 상태는 종결 상태가 아니다»). 시도를 끝내는 자리는 아래뿐이고, 칸마다 근거가 있다:
- succeeded = Toss DONE + 권리 적용(의도 유효 · CAS 이김).
- declined = 청구 4xx + 확인 조회가 «결제 없음(NOT_FOUND)» 또는 ABORTED/EXPIRED/CANCELED.
- failed = 청구 전 단계(행) · 시한 넘어 안 보냄(우리가 안 부름) · 조회 ABORTED/EXPIRED/CANCELED · 조회 NOT_FOUND(청구 시작 +
  `NOT_FOUND_FAIL_AFTER` 뒤).
- voided = Toss DONE인데 권리를 줄 수 없음(의도 무효 · 슬롯 바쁨 · CAS 잃음) → 제 청구 전액 환불(`refund_status`) + 운영자 알림.
그 밖(5xx · 네트워크 · 조회 4xx · `ALREADY_PROCESSED_PAYMENT` · `DUPLICATED_ORDER_ID`)은 전부 진행 중 그대로 — 쓸기가 `next_check_at`으로
간격을 늘려 가며 order_id로 다시 조회한다. 청구 시작 흔적이 있는 failed/declined는 종결 뒤에도 `RECHECK_WINDOW` 동안 다시 조회해
Toss가 뒤늦게 DONE이면 늦은 성공 길(`_late_confirmed`)로 보낸다.
"""
from __future__ import annotations

import logging
import time
import uuid
from collections.abc import Callable
from datetime import datetime, timedelta, timezone

from sqlalchemy import or_, select, update
from sqlalchemy.dialects.postgresql import insert as pg_insert
from sqlalchemy.ext.asyncio import AsyncSession

from app.models.billing_order import BillingOrder
from app.models.billing_payment_attempt import BillingPaymentAttempt
from app.models.offering_version import OfferingVersion
from app.models.org_subscription import OrgSubscription
from app.services import org_subscription_checkout as checkout_svc
from app.services import org_subscription_tier_change as tier_svc
from app.services.billing_charge import ChargeSendDeadlinePassed, _confirm_with_ledger, charge_org
from app.services.billing_refund import RefundError, RefundResponseMalformed, refund_org
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

# 종결된 시도(청구 시작 흔적 있음)를 다시 조회하는 기간 — 이 뒤엔 멈추고 운영자 알림(마지막 조회가 확정 답이 아니었으면).
RECHECK_WINDOW = timedelta(hours=24)
# 결과 모름이 이만큼 이어지면 조회할 때마다 운영자 알림(상태는 비종결 그대로).
ESCALATE_AFTER = timedelta(minutes=30)
# 다시 조회 간격 = 경과 시간의 1/4, 이 사이로.
CHECK_INTERVAL_MIN = timedelta(seconds=10)
CHECK_INTERVAL_MAX = timedelta(hours=1)
# 환불 한 건을 쥐는 기한 — Toss 취소 호출 한도(15초) + 원장 쓰기 여유.
REFUND_LEASE = timedelta(seconds=90)

REASON_INTERRUPTED_BEFORE_CHARGE = "interrupted_before_charge"
REASON_SEND_DEADLINE = "charge_not_sent_deadline_passed"
REASON_NOT_FOUND_AT_TOSS = "charge_not_found_at_toss"


# 청구 응답이 4xx여도 «거절»이 아닌 코드 — Toss가 이 order를 이미 처리했거나(멱등) 중복 조회가 답을 못 준 경우. 결과 모름.
UNKNOWN_OUTCOME_CODES = frozenset({"ALREADY_PROCESSED_PAYMENT", "DUPLICATED_ORDER_ID", "NOT_FOUND_PAYMENT"})
# 요청이 처리됐는지 알려 주지 않는 상태 코드(시간 초과 · 충돌 · 한도) — 결과 모름.
UNKNOWN_OUTCOME_STATUSES = frozenset({408, 409, 429})
TOSS_ENDED_STATUSES = frozenset({"ABORTED", "EXPIRED", "CANCELED"})


class AttemptNotFound(Exception):
    """이 org의 시도가 아니거나 없는 id — 라우터가 404."""


def _now() -> datetime:
    return datetime.now(timezone.utc)


def _next_check(now: datetime, since: datetime | None) -> datetime:
    """다음 조회 시각 — 결과 모름이 길어질수록 간격을 늘린다(5분 틱이 전부를 매번 부르지 않게)."""
    age = now - (since or now)
    return now + min(max(age / 4, CHECK_INTERVAL_MIN), CHECK_INTERVAL_MAX)


async def notify_operator(event: str, attempt_id: uuid.UUID, detail: str) -> bool:
    """운영자 알림 한 자리(PO 04:13Z) — 사람이 받는 곳에 **전달됐으면** True. 지금은 수신처가 없어(PO가 따로 카드) 로그 + False.
    결제 쪽 «운영자 몫» 알림은 전부 여기로 모은다: 늦은 청구 · 권리 못 줌(voided) · 결과 모름 지속 · 환불 실패/지연 · 재조회 종료."""
    logger.error("OPERATOR ALERT [%s] payment attempt %s — %s", event, attempt_id, detail)
    return False


async def _alert(event: str, attempt_id: uuid.UUID, detail: str) -> None:
    try:
        await notify_operator(event, attempt_id, detail)
    except Exception:
        logger.exception("payment attempt %s: operator alert %s failed", attempt_id, event)


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
    base_offering_id = (
        await session.execute(select(OrgSubscription.offering_version_id).where(OrgSubscription.org_id == org_id))
    ).scalar_one_or_none()
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
        base_offering_version_id=base_offering_id,
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

    sub, _old_offering, new_offering = await tier_svc.validate_change_tier(session, org_id=org_id, new_tier=new_tier)
    base_offering_id = sub.offering_version_id
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
        base_offering_version_id=base_offering_id,
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
    base_offering_version_id: uuid.UUID | None = None,
) -> bool:
    result = await session.execute(
        pg_insert(BillingPaymentAttempt).values(
            id=attempt_id, org_id=org_id, requested_by=requested_by, kind=kind, tier=tier, billing_cycle=billing_cycle,
            status="processing", stage="received", order_id=order_id, lease_token=token,
            lease_expires_at=now + WORKER_LEASE, claim_value=now, new_offering_id=new_offering_id,
            refund_target_order_id=refund_target_order_id, base_offering_version_id=base_offering_version_id,
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


def _outcome_unknown(exc: TossApiError) -> bool:
    """이 Toss 오류가 «처리됐는지 모름»인지 — 5xx · 408/409/429 · 멱등 · 중복 조회 코드. 그 밖 4xx만 거절 후보."""
    return exc.status_code >= 500 or exc.status_code in UNKNOWN_OUTCOME_STATUSES or exc.code in UNKNOWN_OUTCOME_CODES


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
            if _outcome_unknown(exc):
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
            payment_attempt_id=attempt.id,
        )
    except ChargeSendDeadlinePassed:
        # 이 작업이 보내지 않았고, 대사는 청구를 부르지 않는다 — 이 order_id로 Toss를 부를 수 있는 쪽은 이제 없다.
        await _finish(session, attempt_id, lease_token, status="failed", reason=REASON_SEND_DEADLINE)
        return
    except TossApiError as exc:
        if _outcome_unknown(exc):
            # 5xx · 멱등(`ALREADY_PROCESSED_PAYMENT`) · 중복(`DUPLICATED_ORDER_ID`) 뒤 조회 실패 — 승인됐을 수도. 진행 중 그대로.
            logger.warning("payment attempt %s: charge got Toss %s %s — outcome unknown, leaving for reconcile",
                           attempt_id, exc.status_code, exc.code)
            return
        await _confirm_decline(session, attempt_id, lease_token, exc)
        return
    except RuntimeError:
        # Toss 도달 실패 · 응답 대기 중 끊김 — 청구가 됐는지 모른다. 대사가 order_id 조회로 가린다.
        logger.warning("payment attempt %s: charge outcome unknown — leaving for reconcile", attempt_id)
        return

    if order.status == "confirmed":
        if not await _finalize(session, attempt_id, lease_token):
            # 늦게 돌아온 작업: 그 사이 대사가 이 시도를 가져가 끝냈다. Toss DONE이 진실 — 늦은 성공 길(권리 또는 voided).
            await _late_confirmed(session, attempt_id)


async def _confirm_decline(session: AsyncSession, attempt_id: uuid.UUID, token: uuid.UUID, exc: TossApiError) -> None:
    """청구가 거절 코드(4xx)를 받았다 — Toss 조회가 «결제 없음» 또는 끝난 결제(ABORTED/EXPIRED/CANCELED)를 확정할 때만 declined.
    조회가 DONE · 진행 중 · 오류면 결정하지 않는다(진행 중 그대로 → 대사가 조회로 확정)."""
    attempt = await get_attempt(session, attempt_id)
    try:
        lookup = await TossAdapter().get_payment_by_order_id(
            order_id=attempt.order_id, quiet_codes=frozenset({"NOT_FOUND_PAYMENT"}),
        )
    except TossApiError as lookup_exc:
        if lookup_exc.code == "NOT_FOUND_PAYMENT":
            await _finish(session, attempt_id, token, status="declined", reason=str(exc))
            return
        logger.warning("payment attempt %s: decline %s not confirmed (lookup %s) — still checking", attempt_id, exc.code, lookup_exc.code)
        return
    except Exception:
        logger.warning("payment attempt %s: decline %s not confirmed (lookup unreachable) — still checking", attempt_id, exc.code)
        return
    if lookup.get("status") in TOSS_ENDED_STATUSES:
        await _finish(session, attempt_id, token, status="declined", reason=str(exc))
        return
    logger.warning("payment attempt %s: charge said %s but Toss lookup says %s — still checking",
                   attempt_id, exc.code, lookup.get("status"))


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
    """청구 없이 끝냄(declined · failed) — 시도 전이 + 슬롯 해제를 한 커밋으로. 청구 시작 흔적이 있으면 종결 뒤에도
    `RECHECK_WINDOW` 동안 다시 조회하도록 `next_check_at`을 건다(Toss가 뒤늦게 DONE이면 늦은 성공 길)."""
    attempt = await _lock_owned(session, attempt_id, token)
    if attempt is None:
        return False
    now = _now()
    attempt.status = status
    attempt.reason = (reason or "")[:500] or None
    attempt.reauth_required = reauth
    attempt.finished_at = now
    attempt.lease_token = None
    attempt.next_check_at = _next_check(now, now) if attempt.charge_started_at is not None else None
    if attempt.claim_value is not None:
        await checkout_svc.release_claim(session, org_id=attempt.org_id, claim_value=attempt.claim_value, commit=False)
    await session.commit()
    return True


async def _stale_intent(session: AsyncSession, attempt: BillingPaymentAttempt) -> str | None:
    """이 시도의 의도가 지금도 유효한지 — 아니면 그 이유(권리를 주는 대신 청구를 환불한다). 지금 상태를 덮어쓰지 않기 위한 확인:
    이 시도 뒤에 만들어진 다른 시도가 이미 성공했거나, change-tier인데 구독 요금제 판이 시작 때와 달라졌다."""
    later = (
        await session.execute(
            select(BillingPaymentAttempt.id).where(
                BillingPaymentAttempt.org_id == attempt.org_id,
                BillingPaymentAttempt.id != attempt.id,
                BillingPaymentAttempt.status == "succeeded",
                BillingPaymentAttempt.created_at > attempt.created_at,
            ).limit(1)
        )
    ).first()
    if later is not None:
        return "a later payment change already succeeded"
    if attempt.kind == "change_tier":
        current = (
            await session.execute(
                select(OrgSubscription.offering_version_id)
                .where(OrgSubscription.org_id == attempt.org_id)
                .execution_options(populate_existing=True)
            )
        ).scalar_one_or_none()
        if current != attempt.base_offering_version_id:
            return "subscription plan changed since the attempt started"
    return None


async def _finalize(session: AsyncSession, attempt_id: uuid.UUID, token: uuid.UUID) -> bool:
    """청구 confirmed 뒤 권리 전이 — 구독 전이 · 시도 succeeded · 슬롯 해제를 한 커밋으로. change-tier 부분취소는 그 뒤.
    의도가 무효이거나 CAS를 잃으면 succeeded를 적지 않는다 — voided + 제 청구 전액 환불."""
    attempt = await _lock_owned(session, attempt_id, token)
    if attempt is None:
        return False
    stale = await _stale_intent(session, attempt)
    if stale is None:
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
            stale = "subscription claim lost before rights were applied"
    if stale is not None:
        await _void_locked(session, attempt, stale)
        return True
    attempt.status = "succeeded"
    attempt.stage = "charged"
    attempt.finished_at = _now()
    attempt.lease_token = None
    attempt.next_check_at = None
    if attempt.claim_value is not None:
        await checkout_svc.release_claim(session, org_id=attempt.org_id, claim_value=attempt.claim_value, commit=False)
    await session.commit()

    if attempt.refund_status == "pending":
        await run_pending_refund(session, attempt_id)
    return True


async def _void_locked(session: AsyncSession, attempt: BillingPaymentAttempt, reason: str) -> None:
    """Toss DONE인데 권리를 줄 수 없다 — 잠근 시도 행을 voided로 끝내고 제 청구 전액 환불 의도를 같은 커밋에 적는다(change-tier의
    옛 결제 부분 환불 의도는 버린다: 권리가 안 바뀌었으니 옛 요금제가 그대로다). 커밋 뒤 운영자 알림 · 환불."""
    order = (
        await session.execute(select(BillingOrder).where(BillingOrder.order_id == attempt.order_id))
    ).scalar_one_or_none()
    attempt.status = "voided"
    attempt.stage = "charged"
    attempt.reason = f"charge confirmed; rights not applied: {reason}"[:500]
    attempt.finished_at = _now()
    attempt.lease_token = None
    attempt.next_check_at = None
    attempt.refund_target_order_id = attempt.order_id
    attempt.refund_amount_minor = order.amount_minor if order is not None else None
    # 청구 행이 없으면 자동 환불할 대상이 없다 — 확정 실패로 두고 알림(운영자 몫).
    attempt.refund_status = "pending" if order is not None else "failed"
    attempt.refund_lease_until = None
    if attempt.claim_value is not None:
        await checkout_svc.release_claim(session, org_id=attempt.org_id, claim_value=attempt.claim_value, commit=False)
    await session.commit()
    await _alert("payment_voided", attempt.id, f"order {attempt.order_id} charged but not applied ({reason}) — refunding in full")
    if attempt.refund_status == "pending":
        await run_pending_refund(session, attempt.id)


async def _void_ended(session: AsyncSession, attempt_id: uuid.UUID, reason: str) -> None:
    attempt = (
        await session.execute(
            select(BillingPaymentAttempt)
            .where(BillingPaymentAttempt.id == attempt_id, BillingPaymentAttempt.status.in_(("failed", "declined")))
            .with_for_update()
            .execution_options(populate_existing=True)
        )
    ).scalar_one_or_none()
    if attempt is None:
        await session.rollback()
        return
    await _void_locked(session, attempt, reason)


async def _late_confirmed(session: AsyncSession, attempt_id: uuid.UUID) -> None:
    """까디르 ④ · P1 — Toss가 DONE인데 시도는 이미 failed/declined로 끝남. **지금 상태를 덮어쓰지 않는다**: 이 시도의 의도가 아직
    유효하고(뒤에 성공한 변경 없음 · 요금제 판 그대로 · 시작 때와 같은 검증 통과) 슬롯을 새로 쥘 때만 되살려 권리를 준다(그 CAS도
    잃으면 `_finalize`가 voided). 그 밖(의도 무효 · 슬롯 바쁨)은 voided + 전액 환불. «이유만 남기고 권리 0 · 재시도 0» 길은 없다."""
    attempt = await get_attempt(session, attempt_id)
    if attempt.status not in ("failed", "declined"):
        return  # succeeded · voided = 이미 끝남 · processing = 모는 쪽이 조회로 확정한다.
    await _alert("late_charge", attempt_id, f"Toss confirmed order {attempt.order_id} after the attempt ended {attempt.status}")
    now = _now()
    token = uuid.uuid4()
    reason = await _stale_intent(session, attempt)
    if reason is None:
        try:
            if attempt.kind == "checkout":
                offering = await checkout_svc.validate_checkout(
                    session, org_id=attempt.org_id, tier=attempt.tier, billing_cycle=attempt.billing_cycle or "monthly",
                    allow_same_active=False,
                )
                claimed = await checkout_svc.claim_checkout_slot(
                    session, org_id=attempt.org_id, tier=attempt.tier, billing_cycle=attempt.billing_cycle or "monthly",
                    offering=offering, now=now, commit=False,
                )
            else:
                await tier_svc.validate_change_tier(session, org_id=attempt.org_id, new_tier=attempt.tier)
                claimed = await tier_svc.claim_tier_change_slot(session, org_id=attempt.org_id, now=now, commit=False)
        except (checkout_svc.CheckoutError, tier_svc.TierChangeError, tier_svc.TierChangeInProgress) as exc:
            await session.rollback()
            reason = f"attempt no longer valid: {exc}"
        else:
            if not claimed:
                await session.rollback()
                reason = "org payment slot busy"
    if reason is not None:
        await _void_ended(session, attempt_id, reason)
        return
    revived = await session.execute(
        update(BillingPaymentAttempt)
        .where(BillingPaymentAttempt.id == attempt_id, BillingPaymentAttempt.status.in_(("failed", "declined")))
        .values(status="processing", lease_token=token, lease_expires_at=now + RECONCILE_LEASE, claim_value=now,
                reason="late charge confirmed after the attempt ended", reauth_required=False, finished_at=None,
                next_check_at=None)
    )
    if revived.rowcount == 0:
        await session.rollback()  # 다른 쪽이 먼저 되살렸거나 끝냈다 — 슬롯 claim도 함께 되돌린다.
        return
    await session.commit()
    await _finalize(session, attempt_id, token)


# ── 환불(change-tier 옛 결제 부분 환불 · voided 전액 환불) ─────────────────────────────────────────────────────

async def run_pending_refund(session: AsyncSession, attempt_id: uuid.UUID) -> str | None:
    """환불 대기(pending)를 보낸다 — 한 건 한 몰이꾼: 행을 `FOR UPDATE SKIP LOCKED`로 집으며 `refund_lease_until`을 같은 커밋에 적는다
    (환불 호출 중 원장 커밋이 있어 잠금만으로는 못 지킨다). 멱등키는 시도마다 하나라 다시 보내도 환불은 1.
    결과: 확정 → confirmed · 확정 4xx/사전 검사 실패 → failed + 운영자 알림 · 5xx/네트워크/200 뒤 응답 깨짐 → pending 그대로(다음 쓸기)."""
    now = _now()
    attempt = (
        await session.execute(
            select(BillingPaymentAttempt)
            .where(
                BillingPaymentAttempt.id == attempt_id,
                BillingPaymentAttempt.refund_status == "pending",
                or_(BillingPaymentAttempt.refund_lease_until.is_(None), BillingPaymentAttempt.refund_lease_until <= now),
            )
            .with_for_update(skip_locked=True)
            .execution_options(populate_existing=True)
        )
    ).scalar_one_or_none()
    if attempt is None:
        await session.rollback()
        return (await get_attempt(session, attempt_id)).refund_status
    voided = attempt.status == "voided"
    target, amount, org_id, finished_at = (
        attempt.refund_target_order_id, attempt.refund_amount_minor, attempt.org_id, attempt.finished_at,
    )
    my_lease = now + REFUND_LEASE
    attempt.refund_lease_until = my_lease
    await session.commit()

    order = (
        await session.execute(select(BillingOrder).where(BillingOrder.order_id == target))
    ).scalar_one_or_none() if target else None
    detail = ""
    if order is None or not amount:
        result, detail = "failed", f"refund target {target!r} / amount {amount!r} missing"
    else:
        try:
            await refund_org(
                session, org_id=org_id, order_id=target,
                cancel_reason="payment attempt voided: rights not applied" if voided else f"tier change -> {attempt.tier}: prorated remainder",
                cancel_amount_minor=amount,
                idempotency_key=f"attempt-void-refund-{attempt_id.hex}" if voided else f"tierchange-refund-{attempt_id.hex}",
            )
            result = "confirmed"
        except RefundResponseMalformed as exc:
            result, detail = "pending", str(exc)
        except RefundError as exc:
            result, detail = "failed", str(exc)
        except TossApiError as exc:
            result, detail = ("pending" if _outcome_unknown(exc) else "failed"), str(exc)
        except Exception as exc:  # 네트워크 · 원장 쓰기 실패 — Toss가 환불했을 수 있다. 같은 키로 다시.
            await session.rollback()
            result, detail = "pending", f"{type(exc).__name__}: {exc}"

    done = result != "pending"
    await session.execute(
        update(BillingPaymentAttempt)
        # 까디르 P2 — 결과는 기한의 주인만 적는다(기한이 지나 다른 몰이꾼이 다시 집었으면 이 결과는 버린다 · 그쪽이 적는다).
        .where(
            BillingPaymentAttempt.id == attempt_id, BillingPaymentAttempt.refund_status == "pending",
            BillingPaymentAttempt.refund_lease_until == my_lease,
        )
        .values(
            refund_status=result, refund_lease_until=None,
            next_check_at=None if done else _next_check(_now(), finished_at),
        )
    )
    if done and order is not None:
        await session.execute(update(BillingOrder).where(BillingOrder.id == order.id).values(refund_status=result))
    await session.commit()
    if result == "failed":
        await _alert("refund_failed", attempt_id, f"refund of {target} ({amount}) failed: {detail}")
    elif result == "pending" and finished_at is not None and _now() - finished_at >= ESCALATE_AFTER:
        await _alert("refund_unconfirmed", attempt_id, f"refund of {target} ({amount}) still unconfirmed: {detail}")
    return result


# ── 조회 대사 ───────────────────────────────────────────────────────────────────────────────────────

async def reconcile_attempt(session: AsyncSession, attempt_id: uuid.UUID) -> BillingPaymentAttempt:
    """상태 조회 · 쓸기 · 새 시도 시작이 부른다. 진행 중인데 모는 쪽 기한과 다음 조회 시각이 지났으면 이어받아 조회한다(Toss는 조회만)."""
    attempt = await get_attempt(session, attempt_id)
    now = _now()
    if (
        attempt.status != "processing"
        or (attempt.lease_expires_at is not None and attempt.lease_expires_at > now)
        or (attempt.next_check_at is not None and attempt.next_check_at > now)
    ):
        return attempt

    token = uuid.uuid4()
    stolen = await session.execute(
        update(BillingPaymentAttempt)
        .where(
            BillingPaymentAttempt.id == attempt_id,
            BillingPaymentAttempt.status == "processing",
            (BillingPaymentAttempt.lease_expires_at.is_(None)) | (BillingPaymentAttempt.lease_expires_at <= now),
            (BillingPaymentAttempt.next_check_at.is_(None)) | (BillingPaymentAttempt.next_check_at <= now),
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


async def _lookup(attempt: BillingPaymentAttempt) -> tuple[dict | None, bool]:
    """(조회 결과, Toss가 «결제 없음»을 답함). 조회 결과가 None이고 없음도 아니면 = 답 없음(오류 · 도달 실패)."""
    try:
        return await TossAdapter().get_payment_by_order_id(
            order_id=attempt.order_id, quiet_codes=frozenset({"NOT_FOUND_PAYMENT"}),
        ), False
    except TossApiError as exc:
        if exc.code == "NOT_FOUND_PAYMENT":
            return None, True
        logger.warning("payment attempt %s: Toss lookup error %s — no answer", attempt.id, exc.code)
    except Exception:
        logger.warning("payment attempt %s: Toss lookup unreachable — no answer", attempt.id, exc_info=True)
    return None, False


async def _record_done(session: AsyncSession, attempt: BillingPaymentAttempt, lookup: dict) -> bool:
    """조회가 DONE — 청구 행을 confirmed + 원장으로. 반환 = 로컬 청구 행이 **없었는지**(까디르 P2): 돈은 나갔는데 우리 기록이 없다 —
    Toss 조회 값(금액 · paymentKey)으로 행을 만들어 확정한 뒤, 호출부가 권리를 주지 않고 환불 규칙(voided)으로 보낸다."""
    order = (await session.execute(select(BillingOrder).where(BillingOrder.order_id == attempt.order_id))).scalar_one_or_none()
    missing = order is None
    if missing:
        logger.error("payment attempt %s: Toss DONE but no billing_orders row for %s — recording it from Toss and refunding", attempt.id, attempt.order_id)
        await session.execute(
            pg_insert(BillingOrder).values(
                id=uuid.uuid4(), org_id=attempt.org_id, order_id=attempt.order_id,
                amount_minor=int(lookup.get("totalAmount") or 0), currency="krw", status="pending",
                purpose="charge", payment_attempt_id=attempt.id,
            ).on_conflict_do_nothing(index_elements=["order_id"])
        )
        await session.commit()
        order = (await session.execute(select(BillingOrder).where(BillingOrder.order_id == attempt.order_id))).scalar_one()
    ledger_metadata = None
    if attempt.kind == "change_tier":
        sub = (await session.execute(select(OrgSubscription).where(OrgSubscription.org_id == attempt.org_id))).scalar_one()
        ledger_metadata = tier_svc.tier_change_ledger_metadata(sub.tier, attempt.tier)
    await _confirm_with_ledger(
        session, org_id=attempt.org_id, order_id=attempt.order_id, amount_minor=order.amount_minor, currency=order.currency,
        payment_key=lookup["paymentKey"], ledger_metadata=ledger_metadata,
        receipt_url=(lookup.get("receipt") or {}).get("url"),
    )
    return missing


async def _reconcile_charge(session: AsyncSession, attempt: BillingPaymentAttempt, token: uuid.UUID, now: datetime) -> None:
    lookup, not_found = await _lookup(attempt)
    if not_found:
        if attempt.charge_started_at is not None and attempt.charge_started_at <= now - NOT_FOUND_FAIL_AFTER:
            # Toss가 «이 주문 없음»을 답했고, 그 뒤엔 누구도 이 order_id로 청구를 보낼 수 없다 — 청구 0 확정.
            await _mark_order_failed(session, attempt.order_id, REASON_NOT_FOUND_AT_TOSS)
            await _finish(session, attempt.id, token, status="failed", reason=REASON_NOT_FOUND_AT_TOSS)
        else:
            await _hand_back(session, attempt, token)
        return
    if lookup is None:
        await _hand_back(session, attempt, token)
        return
    status = lookup.get("status")
    if status == "DONE" and lookup.get("paymentKey"):
        if await _record_done(session, attempt, lookup):
            locked = await _lock_owned(session, attempt.id, token)
            if locked is not None:
                await _void_locked(session, locked, "Toss DONE but no local order record")
            return
        await _finalize(session, attempt.id, token)
        return
    if status in TOSS_ENDED_STATUSES:
        await _mark_order_failed(session, attempt.order_id, f"toss status={status}")
        await _finish(session, attempt.id, token, status="failed", reason=f"toss status={status}")
        return
    await _hand_back(session, attempt, token)  # 진행 중(IN_PROGRESS · WAITING_FOR_DEPOSIT 등) — 다음 조회가 다시 본다.


async def _mark_order_failed(session: AsyncSession, order_id: str, reason: str) -> None:
    from app.services.billing_charge import _mark_failed_if_not_confirmed

    await _mark_failed_if_not_confirmed(session, order_id, reason)


async def _hand_back(session: AsyncSession, attempt: BillingPaymentAttempt, token: uuid.UUID) -> None:
    """결론 없이 돌려놓음(비종결) — 기한은 지금으로 당기고, 다음 조회는 경과 시간에 비례해 늦춘다. 결과 모름이 `ESCALATE_AFTER`를
    넘으면 조회할 때마다 운영자 알림(간격이 늘어나 알림도 드물어진다)."""
    now = _now()
    await session.execute(
        update(BillingPaymentAttempt)
        .where(BillingPaymentAttempt.id == attempt.id, BillingPaymentAttempt.lease_token == token)
        .values(lease_expires_at=now, next_check_at=_next_check(now, attempt.charge_started_at or attempt.created_at))
    )
    await session.commit()
    if now - (attempt.created_at or now) >= ESCALATE_AFTER:
        await _alert("outcome_unknown", attempt.id, f"order {attempt.order_id} outcome still unknown at Toss")


async def recheck_ended_attempt(session: AsyncSession, attempt_id: uuid.UUID) -> str:
    """종결(failed · declined)됐지만 청구 시작 흔적이 있는 시도를 다시 조회한다(까디르 ① 안전망). Toss가 DONE이면 늦은 성공 길.
    `RECHECK_WINDOW`가 끝나면 조회를 멈춘다 — 상태는 끝난 그대로(마지막 답이 확정이 아니었으면 운영자 알림).
    반환: 'late' · 'still_ended' · 'skipped'."""
    now = _now()
    attempt = (
        await session.execute(
            select(BillingPaymentAttempt)
            .where(
                BillingPaymentAttempt.id == attempt_id,
                BillingPaymentAttempt.status.in_(("failed", "declined")),
                BillingPaymentAttempt.next_check_at.is_not(None),
                BillingPaymentAttempt.next_check_at <= now,
            )
            .with_for_update(skip_locked=True)
            .execution_options(populate_existing=True)
        )
    ).scalar_one_or_none()
    if attempt is None:
        await session.rollback()
        return "skipped"
    ended_at = attempt.finished_at or now
    nxt = _next_check(now, ended_at)
    attempt.next_check_at = nxt if nxt <= ended_at + RECHECK_WINDOW else None
    closing = attempt.next_check_at is None
    await session.commit()

    lookup, not_found = await _lookup(attempt)
    if lookup is not None and lookup.get("status") == "DONE" and lookup.get("paymentKey"):
        if await _record_done(session, attempt, lookup):
            await _void_ended(session, attempt_id, "Toss DONE but no local order record")
        else:
            await _late_confirmed(session, attempt_id)
        return "late"
    answered = not_found or (lookup is not None and lookup.get("status") in TOSS_ENDED_STATUSES)
    if closing and not answered:
        await _alert("recheck_window_closed", attempt_id, f"order {attempt.order_id}: no definite Toss answer within {RECHECK_WINDOW}")
    return "still_ended"


# ── 쓸기(`billing-payment-attempts` 크론, 5분) ─────────────────────────────────────────────────────────

# 한 틱 예산 — 크론 attempt_deadline(300초)보다 짧게. 한 건 최악(조회 15 + 권리 전이 · 환불 취소 15 + DB) 앞에서 멈춘다.
SWEEP_BUDGET_SECONDS = 240
SWEEP_ITEM_WORST_SECONDS = 45
SWEEP_BATCH = 200
_monotonic = time.monotonic


async def sweep_processing_attempts(session: AsyncSession, *, budget_seconds: float = SWEEP_BUDGET_SECONDS) -> dict:
    """다음 조회 시각이 된 것만 — ① 진행 중 시도 대사 ② 청구 시작 흔적이 있는 종결 시도 재조회 ③ 환불 대기. 남은 예산이 한 건 최악보다
    작으면 새 건을 집지 않는다(남은 건은 다음 틱 — 시각이 그대로라 다시 대상이다). 한 건 한 몰이꾼: ①은 기한 CAS로 빼앗고, ②③은
    `FOR UPDATE SKIP LOCKED`로 집는다."""
    started = _monotonic()
    outcome: dict[str, int] = {}

    def bump(key: str) -> None:
        outcome[key] = outcome.get(key, 0) + 1

    def room() -> bool:
        if budget_seconds - (_monotonic() - started) >= SWEEP_ITEM_WORST_SECONDS:
            return True
        bump("deferred")
        return False

    now = _now()
    due = (BillingPaymentAttempt.next_check_at.is_(None)) | (BillingPaymentAttempt.next_check_at <= now)
    processing = (
        await session.execute(
            select(BillingPaymentAttempt.id).where(
                BillingPaymentAttempt.status == "processing",
                (BillingPaymentAttempt.lease_expires_at.is_(None)) | (BillingPaymentAttempt.lease_expires_at <= now),
                due,
            ).order_by(BillingPaymentAttempt.next_check_at.asc().nulls_first()).limit(SWEEP_BATCH)
        )
    ).scalars().all()
    ended = (
        await session.execute(
            select(BillingPaymentAttempt.id).where(
                BillingPaymentAttempt.status.in_(("failed", "declined")),
                BillingPaymentAttempt.next_check_at.is_not(None),
                BillingPaymentAttempt.next_check_at <= now,
            ).order_by(BillingPaymentAttempt.next_check_at.asc()).limit(SWEEP_BATCH)
        )
    ).scalars().all()
    refunds = (
        await session.execute(
            select(BillingPaymentAttempt.id).where(
                BillingPaymentAttempt.refund_status == "pending",
                BillingPaymentAttempt.status.in_(("succeeded", "voided")),
                or_(BillingPaymentAttempt.refund_lease_until.is_(None), BillingPaymentAttempt.refund_lease_until <= now),
                due,
            ).limit(SWEEP_BATCH)
        )
    ).scalars().all()
    await session.commit()

    for attempt_id in processing:
        if not room():
            break
        try:
            attempt = await reconcile_attempt(session, attempt_id)
        except Exception:
            logger.exception("payment attempt %s: sweep reconcile failed", attempt_id)
            await session.rollback()
            bump("error")
            continue
        bump(attempt.status)
    for attempt_id in ended:
        if not room():
            break
        try:
            bump(f"recheck_{await recheck_ended_attempt(session, attempt_id)}")
        except Exception:
            logger.exception("payment attempt %s: sweep recheck failed", attempt_id)
            await session.rollback()
            bump("error")
    for attempt_id in refunds:
        if not room():
            break
        try:
            result = await run_pending_refund(session, attempt_id)
        except Exception:
            logger.exception("payment attempt %s: sweep refund failed", attempt_id)
            await session.rollback()
            result = "error"
        bump(f"refund_{result}")
    return outcome
