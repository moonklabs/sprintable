"""story #4335 — 결제 시도(checkout · change-tier) 실 DB 검증. Toss HTTP(`TossAdapter._post` · `_get`)만 가짜 — 가짜 Toss도
orderId 멱등(같은 orderId 두 번째 청구 = DUPLICATED_ORDER_ID)을 지켜, «청구 1»을 돈이 실제로 움직인 횟수(가짜 Toss의 승인 수)로 센다.

AC1: 같은 시도 id 연속 · 동시 → 청구 1 · 끊긴 뒤는 조회로 확정(대사가 order_id로 Toss 조회만).
AC2: 영수 메일 10초 지연 · 실패 → 결제 확정 시간 · 결과 무변.
경합 표(PR 본문)의 줄마다 한 테스트: 울타리 · 늦게 깨어난 작업 · 시한 · NOT_FOUND 대기 · 청구 전 멈춤(=청구 0 행 증명).
"""
from __future__ import annotations

import asyncio
import os
import time
import uuid
from datetime import datetime, timedelta, timezone
from unittest.mock import patch

import pytest
from sqlalchemy import text, update
from sqlalchemy.ext.asyncio import async_sessionmaker, create_async_engine

from tests.test_2880_tier_change_upgrade_proration_realdb import (
    _seed_active_billing_key,
    _seed_active_paid_subscription,
    _seed_org,
    _seed_prior_confirmed_order,
)

_RAW = os.environ.get("ALEMBIC_DATABASE_URL") or os.environ.get("PARITY_TEST_DATABASE_URL") or ""
_ASYNC = _RAW.replace("postgresql+psycopg2://", "postgresql+asyncpg://").replace("postgresql://", "postgresql+asyncpg://")

pytestmark = pytest.mark.skipif(not _RAW, reason="real-DB URL 미설정 — skip")


@pytest.fixture
def anyio_backend():
    return "asyncio"


@pytest.fixture(autouse=True)
def _crypto_key(monkeypatch):
    import app.core.config as config_module
    from app.services import billing_key_crypto

    monkeypatch.setattr(config_module.settings, "org_billing_key_encryption_key", "W3x6lXDky6UQE36FyRU_Snf9m7d73Aev59D4PvS4-N0=")
    billing_key_crypto._get_multi_fernet.cache_clear()
    yield
    billing_key_crypto._get_multi_fernet.cache_clear()


@pytest.fixture(autouse=True)
def _no_real_receipt_mail(monkeypatch):
    import app.services.billing_receipt_email as email_svc

    async def _noop(*_a, **_k):
        return None

    monkeypatch.setattr(email_svc, "send_payment_receipt_email", _noop)


@pytest.fixture
async def Session():
    engine = create_async_engine(_ASYNC)
    factory = async_sessionmaker(engine, expire_on_commit=False)
    yield factory
    from app.services.billing_charge import drain_receipt_emails

    await drain_receipt_emails()
    await engine.dispose()


class FakeToss:
    """가짜 Toss — orderId 멱등 · 승인 수 집계 · 조회. `charge_mode`: ok | decline | network | hang."""

    def __init__(self):
        self.charged: dict[str, str] = {}  # orderId → paymentKey (DONE)
        self.charge_calls: list[str] = []
        self.issue_calls = 0
        self.cancel_calls: list[tuple[str, int]] = []
        self.lookup_calls: list[str] = []
        self.charge_mode = "ok"
        self.issue_mode = "ok"
        self.hang_event: asyncio.Event | None = None
        self.lookup_status: str | None = None  # 강제 조회 결과(ABORTED 등) · "error"면 Toss 5xx
        # 4704(PO «결과 모름 = 비종결»): 청구 응답 코드 · 조회 4xx · 환불 모드(ok | 5xx | 5xx_done | decline | network | slow).
        self.charge_code: tuple[str, int] | None = None
        self.lookup_error: tuple[str, int] | None = None
        self.cancel_mode = "ok"
        self.cancel_keys: list[str | None] = []
        self.refunded: dict[str, dict] = {}  # 멱등키 → 첫 응답(Toss 멱등: 같은 키면 같은 응답 · 두 번째 환불 0)
        self.amounts: dict[str, int] = {}  # orderId → 청구 금액(조회의 totalAmount)

    @property
    def approvals(self) -> int:
        return len(self.charged)

    async def post(self, _self, path, *, json, timeout, op_label, idempotency_key=None):  # noqa: A002
        from app.services.payment.toss_adapter import DUPLICATED_ORDER_ID, TossApiError

        if path == "/v1/billing/authorizations/issue":
            self.issue_calls += 1
            if self.issue_mode == "decline":
                raise TossApiError("INVALID_CARD", "Toss issue failed", status_code=400)
            return {"billingKey": f"bk-{uuid.uuid4().hex[:8]}", "card": {}, "authenticatedAt": "2026-09-26T00:00:00+09:00"}
        if path.endswith("/cancel"):
            self.cancel_calls.append((path, json["cancelAmount"]))
            self.cancel_keys.append(idempotency_key)
            if self.cancel_mode == "slow":
                await asyncio.sleep(0.3)
            if idempotency_key in self.refunded:
                return self.refunded[idempotency_key]
            if self.cancel_mode == "decline":
                raise TossApiError("NOT_CANCELABLE_AMOUNT", "Toss refund failed", status_code=400)
            if self.cancel_mode == "network":
                raise RuntimeError("Cannot reach Toss API")
            response = {"paymentKey": path.split("/")[3], "status": "PARTIAL_CANCELED", "cancels": [{"cancelAmount": json["cancelAmount"], "transactionKey": f"tx-{uuid.uuid4().hex[:6]}"}]}
            if self.cancel_mode in ("5xx", "5xx_done"):
                if self.cancel_mode == "5xx_done":
                    self.refunded[idempotency_key] = response  # Toss는 환불했는데 응답만 잃음
                raise TossApiError("PROVIDER_ERROR", "Toss refund failed", status_code=500)
            self.refunded[idempotency_key] = response
            return response
        # 청구 /v1/billing/{billingKey}
        order_id = json["orderId"]
        self.charge_calls.append(order_id)
        self.amounts[order_id] = json.get("amount", 0)
        if self.charge_mode == "hang":
            assert self.hang_event is not None
            await self.hang_event.wait()
            raise RuntimeError("Cannot reach Toss API")  # 응답 전에 끊긴 판
        if self.charge_mode == "hang_then_ok":  # Toss는 승인했는데 응답이 늦게 돌아오는 판(작업이 오래 멈췄다 깨어남)
            assert self.hang_event is not None
            self.charged.setdefault(order_id, f"pay-{uuid.uuid4().hex[:10]}")
            await self.hang_event.wait()
            return {"paymentKey": self.charged[order_id], "orderId": order_id, "receipt": {"url": "https://r.example/late"}}
        if self.charge_mode in ("5xx", "5xx_charged"):  # 까디르 ① — Toss 5xx: 승인됐을 수도(5xx_charged) · 안 됐을 수도
            if self.charge_mode == "5xx_charged":
                self.charged.setdefault(order_id, f"pay-{uuid.uuid4().hex[:10]}")
            raise TossApiError("PROVIDER_ERROR", "Toss charge failed", status_code=500)
        if self.charge_mode == "network":
            self.charged.setdefault(order_id, f"pay-{uuid.uuid4().hex[:10]}")  # 도달은 했고 응답만 잃음
            raise RuntimeError("Cannot reach Toss API")
        if self.charge_mode == "decline":
            raise TossApiError("REJECT_CARD_COMPANY", "Toss charge failed", status_code=400)
        if self.charge_mode == "code":  # 4704 — 임의 코드 · 상태
            assert self.charge_code is not None
            raise TossApiError(self.charge_code[0], "Toss charge failed", status_code=self.charge_code[1])
        if order_id in self.charged:
            raise TossApiError(DUPLICATED_ORDER_ID, "Toss charge failed", status_code=400)
        payment_key = f"pay-{uuid.uuid4().hex[:10]}"
        self.charged[order_id] = payment_key
        return {"paymentKey": payment_key, "orderId": order_id, "receipt": {"url": f"https://r.example/{payment_key}"}}

    async def get(self, _self, path, *, timeout, op_label, quiet_codes=frozenset()):
        from app.services.payment.toss_adapter import TossApiError

        order_id = path.rsplit("/", 1)[-1]
        self.lookup_calls.append(order_id)
        if self.lookup_status == "error":
            raise TossApiError("PROVIDER_ERROR", "Toss payment lookup failed", status_code=500)
        if self.lookup_error is not None:
            raise TossApiError(self.lookup_error[0], "Toss payment lookup failed", status_code=self.lookup_error[1])
        if self.lookup_status is not None:
            return {"status": self.lookup_status, "orderId": order_id}
        if order_id not in self.charged:
            raise TossApiError("NOT_FOUND_PAYMENT", "Toss payment lookup failed", status_code=404)
        return {"status": "DONE", "paymentKey": self.charged[order_id], "orderId": order_id, "totalAmount": self.amounts.get(order_id, 0), "receipt": {"url": "https://r.example/x"}}

    async def delete(self, _self, path, *, timeout, op_label):
        return None


@pytest.fixture
def toss():
    fake = FakeToss()

    async def _post(self, path, **kw):
        return await fake.post(self, path, **kw)

    async def _get(self, path, **kw):
        return await fake.get(self, path, **kw)

    async def _delete(self, path, **kw):
        return await fake.delete(self, path, **kw)

    with patch("app.services.payment.toss_adapter.TossAdapter._post", new=_post), \
            patch("app.services.payment.toss_adapter.TossAdapter._get", new=_get), \
            patch("app.services.payment.toss_adapter.TossAdapter._delete", new=_delete):
        yield fake


async def _new_org(session, *, seats=5):
    org_id = await _seed_org(session)
    for _ in range(seats):
        await session.execute(
            text("INSERT INTO org_members (id, org_id, user_id, role) VALUES (:id, :org_id, :uid, 'member')"),
            {"id": uuid.uuid4(), "org_id": org_id, "uid": uuid.uuid4()},
        )
    await session.commit()
    return org_id


async def _row(session, sql, **params):
    return (await session.execute(text(sql), params)).first()


async def _expire_lease(session, attempt_id, *, charge_started_ago: timedelta | None = None):
    from app.models.billing_payment_attempt import BillingPaymentAttempt

    # 시간이 흐른 판 — 모는 쪽 기한도, 다음 조회 시각(`next_check_at`, 결과 모름의 간격)도 지났다.
    values = {"lease_expires_at": datetime.now(timezone.utc) - timedelta(seconds=1),
              "next_check_at": datetime.now(timezone.utc) - timedelta(seconds=1)}
    if charge_started_ago is not None:
        values["charge_started_at"] = datetime.now(timezone.utc) - charge_started_ago
    await session.execute(update(BillingPaymentAttempt).where(BillingPaymentAttempt.id == attempt_id).values(**values))
    await session.commit()


# ── AC1: 한 시도 = 청구 1 ─────────────────────────────────────────────────────────────────────────────

@pytest.mark.anyio
async def test_checkout_attempt_runs_to_active_with_one_approval(Session, toss):
    from app.services import billing_payment_attempt as svc

    async with Session() as s:
        org_id = await _new_org(s)
        attempt_id = uuid.uuid4()
        attempt, token = await svc.start_checkout_attempt(
            s, attempt_id=attempt_id, org_id=org_id, requested_by=None, tier="team", billing_cycle="monthly",
        )
        assert (attempt.status, attempt.stage, attempt.order_id) == ("processing", "received", f"checkout-{attempt_id.hex}")
        await svc.drive_attempt(s, attempt_id, token, auth_key="auth-1")

        done = await svc.get_attempt(s, attempt_id)
        assert (done.status, done.stage, done.lease_token) == ("succeeded", "charged", None)
        sub = await _row(s, "SELECT status, tier, checkout_claimed_at FROM org_subscriptions WHERE org_id=:o", o=org_id)
        assert (sub.status, sub.tier, sub.checkout_claimed_at) == ("active", "team", None)
        orders = (await s.execute(text("SELECT order_id, status FROM billing_orders WHERE org_id=:o"), {"o": org_id})).all()
        assert [(o.order_id, o.status) for o in orders] == [(f"checkout-{attempt_id.hex}", "confirmed")]
    assert toss.approvals == 1


@pytest.mark.anyio
async def test_same_attempt_id_again_returns_the_same_attempt_and_starts_no_work(Session, toss):
    """연속 2회(새로고침 · 끊긴 뒤 재요청) — 두 번째는 토큰 없음(응답 뒤 작업 0) · 끝난 뒤 다시 와도 같은 결과 · 청구 1.
    뮤테이션: 시작이 기존 id를 확인하지 않으면 두 번째 토큰이 생겨 두 작업이 돈다 → 아래 approvals/charge_calls가 RED."""
    from app.services import billing_payment_attempt as svc

    async with Session() as s:
        org_id = await _new_org(s)
        attempt_id = uuid.uuid4()
        _, token1 = await svc.start_checkout_attempt(s, attempt_id=attempt_id, org_id=org_id, requested_by=None, tier="team", billing_cycle="monthly")
        again, token2 = await svc.start_checkout_attempt(s, attempt_id=attempt_id, org_id=org_id, requested_by=None, tier="team", billing_cycle="monthly")
        assert token1 is not None and token2 is None and again.status == "processing"
        for token in (token1, token2):
            if token is not None:
                await svc.drive_attempt(s, attempt_id, token, auth_key="auth-1")
        after, token3 = await svc.start_checkout_attempt(s, attempt_id=attempt_id, org_id=org_id, requested_by=None, tier="team", billing_cycle="monthly")
        assert (after.status, token3) == ("succeeded", None)
    assert toss.approvals == 1 and toss.charge_calls == [f"checkout-{attempt_id.hex}"]


@pytest.mark.anyio
async def test_same_attempt_id_concurrently_charges_once(Session, toss):
    """동시 2회 — 두 세션이 같은 id로 동시에 시작 → 토큰은 하나 · 두 작업(같은 토큰으로 둘이 돌아도) → 울타리가 한 번만 통과 · 청구 1."""
    from app.services import billing_payment_attempt as svc

    async with Session() as s:
        org_id = await _new_org(s)
    attempt_id = uuid.uuid4()

    async def _start():
        async with Session() as s:
            return await svc.start_checkout_attempt(s, attempt_id=attempt_id, org_id=org_id, requested_by=None, tier="team", billing_cycle="monthly")

    results = await asyncio.gather(_start(), _start())
    tokens = [t for _, t in results if t is not None]
    assert len(tokens) == 1

    async def _drive():
        async with Session() as s:
            await svc.drive_attempt(s, attempt_id, tokens[0], auth_key="auth-1")

    await asyncio.gather(_drive(), _drive())
    async with Session() as s:
        assert (await svc.get_attempt(s, attempt_id)).status == "succeeded"
    assert toss.approvals == 1 and len(toss.charge_calls) == 1


@pytest.mark.anyio
async def test_other_attempt_for_the_same_org_while_one_is_processing_is_409(Session, toss):
    from app.services import billing_payment_attempt as svc
    from app.services.org_subscription_checkout import CheckoutInProgress

    async with Session() as s:
        org_id = await _new_org(s)
        await svc.start_checkout_attempt(s, attempt_id=uuid.uuid4(), org_id=org_id, requested_by=None, tier="team", billing_cycle="monthly")
        with pytest.raises(CheckoutInProgress):
            await svc.start_checkout_attempt(s, attempt_id=uuid.uuid4(), org_id=org_id, requested_by=None, tier="business", billing_cycle="monthly")
    assert toss.charge_calls == []


@pytest.mark.anyio
async def test_new_checkout_attempt_for_an_org_already_active_on_that_plan_is_refused(Session, toss):
    """시도 경로에선 새 시도 id = 정말 새 결제 — 이미 같은 플랜으로 active면 두 번째 청구를 만들지 않는다(400)."""
    from app.services import billing_payment_attempt as svc
    from app.services.org_subscription_checkout import ActivePaidSubscriptionExists

    async with Session() as s:
        org_id = await _new_org(s)
        a1 = uuid.uuid4()
        _, t1 = await svc.start_checkout_attempt(s, attempt_id=a1, org_id=org_id, requested_by=None, tier="team", billing_cycle="monthly")
        await svc.drive_attempt(s, a1, t1, auth_key="auth-1")
        with pytest.raises(ActivePaidSubscriptionExists):
            await svc.start_checkout_attempt(s, attempt_id=uuid.uuid4(), org_id=org_id, requested_by=None, tier="team", billing_cycle="monthly")
    assert toss.approvals == 1


@pytest.mark.anyio
async def test_change_tier_attempt_charges_once_moves_tier_and_refunds_the_captured_order(Session, toss):
    from app.services import billing_payment_attempt as svc

    async with Session() as s:
        org_id = await _new_org(s, seats=1)
        await _seed_active_paid_subscription(s, org_id, tier="starter")
        await _seed_active_billing_key(s, org_id)
        await _seed_prior_confirmed_order(s, org_id, amount_minor=32_890)
        attempt_id = uuid.uuid4()
        attempt, token = await svc.start_change_tier_attempt(s, attempt_id=attempt_id, org_id=org_id, requested_by=None, new_tier="team")
        assert attempt.refund_target_order_id is not None
        again, token2 = await svc.start_change_tier_attempt(s, attempt_id=attempt_id, org_id=org_id, requested_by=None, new_tier="team")
        assert token2 is None and again.id == attempt_id
        await svc.drive_attempt(s, attempt_id, token)

        assert (await svc.get_attempt(s, attempt_id)).status == "succeeded"
        sub = await _row(s, "SELECT tier, checkout_claimed_at FROM org_subscriptions WHERE org_id=:o", o=org_id)
        assert (sub.tier, sub.checkout_claimed_at) == ("team", None)
        refunded = await _row(s, "SELECT refund_status FROM billing_orders WHERE order_id=:oid", oid=attempt.refund_target_order_id)
        assert refunded.refund_status == "confirmed"
    assert toss.approvals == 1 and len(toss.cancel_calls) == 1


@pytest.mark.anyio
async def test_declined_charge_ends_declined_with_no_approval_and_releases_the_slot(Session, toss):
    from app.services import billing_payment_attempt as svc

    toss.charge_mode = "decline"
    async with Session() as s:
        org_id = await _new_org(s)
        attempt_id = uuid.uuid4()
        _, token = await svc.start_checkout_attempt(s, attempt_id=attempt_id, org_id=org_id, requested_by=None, tier="team", billing_cycle="monthly")
        await svc.drive_attempt(s, attempt_id, token, auth_key="auth-1")
        done = await svc.get_attempt(s, attempt_id)
        assert done.status == "declined" and "REJECT_CARD_COMPANY" in done.reason
        sub = await _row(s, "SELECT status, checkout_claimed_at FROM org_subscriptions WHERE org_id=:o", o=org_id)
        assert (sub.status, sub.checkout_claimed_at) == ("pending", None)
    assert toss.approvals == 0


# ── 경합 표: 대사 · 울타리 ─────────────────────────────────────────────────────────────────────────────

@pytest.mark.anyio
async def test_reconcile_before_charge_marks_failed_with_zero_charge_proven_by_the_row(Session, toss):
    """응답 뒤 작업이 빌링키 전에 사라짐(stage=received) → 대사: failed · 카드 인증부터 다시 · Toss 청구/조회 0 · 슬롯 해제."""
    from app.services import billing_payment_attempt as svc

    async with Session() as s:
        org_id = await _new_org(s)
        attempt_id = uuid.uuid4()
        await svc.start_checkout_attempt(s, attempt_id=attempt_id, org_id=org_id, requested_by=None, tier="team", billing_cycle="monthly")
        await _expire_lease(s, attempt_id)
        done = await svc.reconcile_attempt(s, attempt_id)
        assert (done.status, done.stage, done.reauth_required, done.reason) == ("failed", "received", True, svc.REASON_INTERRUPTED_BEFORE_CHARGE)
        assert (await _row(s, "SELECT checkout_claimed_at FROM org_subscriptions WHERE org_id=:o", o=org_id)).checkout_claimed_at is None
    assert toss.charge_calls == [] and toss.lookup_calls == []


@pytest.mark.anyio
async def test_worker_waking_after_reconcile_failed_it_never_calls_toss(Session, toss):
    """늦게 깨어난 작업(옛 토큰) — 대사가 이미 failed로 끝낸 뒤 울타리에서 막혀 Toss 청구 0.
    뮤테이션: 울타리가 토큰을 확인하지 않으면 여기서 청구가 나가 RED."""
    from app.services import billing_payment_attempt as svc

    async with Session() as s:
        org_id = await _new_org(s, seats=1)
        await _seed_active_paid_subscription(s, org_id, tier="starter")
        await _seed_active_billing_key(s, org_id)
        attempt_id = uuid.uuid4()
        _, stale_token = await svc.start_change_tier_attempt(s, attempt_id=attempt_id, org_id=org_id, requested_by=None, new_tier="team")
        await _expire_lease(s, attempt_id)
        assert (await svc.reconcile_attempt(s, attempt_id)).status == "failed"
        await svc.drive_attempt(s, attempt_id, stale_token)
        assert (await svc.get_attempt(s, attempt_id)).status == "failed"
    assert toss.charge_calls == []


@pytest.mark.anyio
async def test_fence_refuses_a_worker_whose_token_was_taken_while_the_new_holder_lease_is_live(Session, toss, monkeypatch):
    """작업이 시작 확인은 통과한 뒤(청구 금액 계산 중) 대사가 토큰을 빼앗아 아직 일하는 중(새 토큰 · 기한 살아 있음) → 울타리에서
    멈춤 · Toss 청구 0. 기한만으로는 못 가르는 자리(새 쪽 기한이 살아 있다) — 울타리의 토큰 확인이 유일한 방어.
    뮤테이션: 울타리(`_lock_owned`)의 토큰 확인을 빼면 청구가 나가 RED."""
    from app.models.billing_payment_attempt import BillingPaymentAttempt
    from app.services import billing_payment_attempt as svc

    real_inputs = svc._charge_inputs

    async def _inputs_then_token_taken(session, attempt):
        result = await real_inputs(session, attempt)
        async with Session() as other:  # 다른 연결(대사)이 토큰을 빼앗음
            await other.execute(
                update(BillingPaymentAttempt).where(BillingPaymentAttempt.id == attempt.id)
                .values(lease_token=uuid.uuid4(), lease_expires_at=datetime.now(timezone.utc) + timedelta(minutes=1))
            )
            await other.commit()
        return result

    monkeypatch.setattr(svc, "_charge_inputs", _inputs_then_token_taken)
    async with Session() as s:
        org_id = await _new_org(s, seats=1)
        await _seed_active_paid_subscription(s, org_id, tier="starter")
        await _seed_active_billing_key(s, org_id)
        attempt_id = uuid.uuid4()
        _, old_token = await svc.start_change_tier_attempt(s, attempt_id=attempt_id, org_id=org_id, requested_by=None, new_tier="team")
        await svc.drive_attempt(s, attempt_id, old_token)
        still = await svc.get_attempt(s, attempt_id)
        assert (still.status, still.stage) == ("processing", "received")
    assert toss.charge_calls == []


@pytest.mark.anyio
async def test_charge_started_then_worker_lost_reconcile_finds_done_and_finalizes(Session, toss):
    """청구는 Toss에 닿았는데 응답을 잃음(작업은 결론 못 냄) → 대사: order_id 조회 DONE → 확정 · active · 청구 1(재청구 0)."""
    from app.services import billing_payment_attempt as svc

    toss.charge_mode = "network"
    async with Session() as s:
        org_id = await _new_org(s)
        attempt_id = uuid.uuid4()
        _, token = await svc.start_checkout_attempt(s, attempt_id=attempt_id, org_id=org_id, requested_by=None, tier="team", billing_cycle="monthly")
        await svc.drive_attempt(s, attempt_id, token, auth_key="auth-1")
        mid = await svc.get_attempt(s, attempt_id)
        assert (mid.status, mid.stage) == ("processing", "charge_started")
        assert (await svc.reconcile_attempt(s, attempt_id)).status == "processing", "기한 전엔 대사가 끼어들지 않는다"
        await _expire_lease(s, attempt_id)
        done = await svc.reconcile_attempt(s, attempt_id)
        assert (done.status, done.stage) == ("succeeded", "charged")
        assert (await _row(s, "SELECT status FROM org_subscriptions WHERE org_id=:o", o=org_id)).status == "active"
        assert (await _row(s, "SELECT status FROM billing_orders WHERE order_id=:x", x=done.order_id)).status == "confirmed"
        ledger = (await s.execute(text("SELECT count(*) FROM billing_ledger_entries WHERE org_id=:o"), {"o": org_id})).scalar_one()
        assert ledger == 1
    assert toss.approvals == 1 and len(toss.charge_calls) == 1


@pytest.mark.anyio
async def test_not_found_at_toss_stays_checking_until_the_fence_window_then_fails(Session, toss):
    """청구 시작 표식은 있는데 Toss가 모른다 → 10분 전엔 «확인 중» 그대로 · 지난 뒤에만 failed(청구 0)."""
    from app.services import billing_payment_attempt as svc

    toss.charge_mode = "hang"
    toss.hang_event = asyncio.Event()
    async with Session() as s:
        org_id = await _new_org(s)
        attempt_id = uuid.uuid4()
        _, token = await svc.start_checkout_attempt(s, attempt_id=attempt_id, org_id=org_id, requested_by=None, tier="team", billing_cycle="monthly")

    async def _worker():
        async with Session() as ws:
            await svc.drive_attempt(ws, attempt_id, token, auth_key="auth-1")

    worker = asyncio.create_task(_worker())
    for _ in range(100):
        if toss.charge_calls:
            break
        await asyncio.sleep(0.05)
    toss.charged.clear()  # 가짜 Toss: 이 판에선 승인 기록이 없다(= NOT_FOUND)
    async with Session() as s:
        await _expire_lease(s, attempt_id, charge_started_ago=timedelta(minutes=1))
        assert (await svc.reconcile_attempt(s, attempt_id)).status == "processing"
        await _expire_lease(s, attempt_id, charge_started_ago=svc.NOT_FOUND_FAIL_AFTER + timedelta(seconds=1))
        done = await svc.reconcile_attempt(s, attempt_id)
        assert (done.status, done.reason) == ("failed", svc.REASON_NOT_FOUND_AT_TOSS)
    toss.hang_event.set()
    await worker
    async with Session() as s:
        assert (await svc.get_attempt(s, attempt_id)).status == "failed", "늦게 돌아온 작업이 결론을 뒤집지 않는다"


@pytest.mark.anyio
async def test_send_deadline_passed_means_toss_is_never_called(Session, toss, monkeypatch):
    from app.services import billing_payment_attempt as svc

    monkeypatch.setattr(svc, "SEND_DEADLINE", timedelta(seconds=-1))
    async with Session() as s:
        org_id = await _new_org(s)
        attempt_id = uuid.uuid4()
        _, token = await svc.start_checkout_attempt(s, attempt_id=attempt_id, org_id=org_id, requested_by=None, tier="team", billing_cycle="monthly")
        await svc.drive_attempt(s, attempt_id, token, auth_key="auth-1")
        done = await svc.get_attempt(s, attempt_id)
        assert (done.status, done.reason) == ("failed", svc.REASON_SEND_DEADLINE)
    assert toss.charge_calls == []


@pytest.mark.anyio
async def test_card_auth_declined_fails_before_charge_and_asks_for_reauth(Session, toss):
    from app.services import billing_payment_attempt as svc

    toss.issue_mode = "decline"
    async with Session() as s:
        org_id = await _new_org(s)
        attempt_id = uuid.uuid4()
        _, token = await svc.start_checkout_attempt(s, attempt_id=attempt_id, org_id=org_id, requested_by=None, tier="team", billing_cycle="monthly")
        await svc.drive_attempt(s, attempt_id, token, auth_key="auth-1")
        done = await svc.get_attempt(s, attempt_id)
        assert (done.status, done.stage, done.reauth_required) == ("failed", "received", True)
    assert toss.charge_calls == []


@pytest.mark.anyio
async def test_sweep_reconciles_attempts_nobody_polled(Session, toss):
    from app.services import billing_payment_attempt as svc

    async with Session() as s:
        org_id = await _new_org(s)
        attempt_id = uuid.uuid4()
        await svc.start_checkout_attempt(s, attempt_id=attempt_id, org_id=org_id, requested_by=None, tier="team", billing_cycle="monthly")
        await _expire_lease(s, attempt_id)
        result = await svc.sweep_processing_attempts(s)
        assert result.get("failed", 0) >= 1 and (await svc.get_attempt(s, attempt_id)).status == "failed"


# ── AC2: 영수 메일은 결제 확정 경로 밖 ─────────────────────────────────────────────────────────────────

@pytest.mark.anyio
@pytest.mark.parametrize("mail", ["slow", "broken"])
async def test_receipt_mail_delay_or_failure_does_not_change_payment_time_or_result(Session, toss, monkeypatch, mail):
    """메일 목 10초 지연 → 결제 확정(시도 succeeded)까지 2초 안 · 메일 실패 → 결과 그대로.
    뮤테이션: `_confirm_with_ledger`가 메일을 다시 await하면 slow 판이 10초 넘어 RED."""
    import app.services.billing_receipt_email as email_svc
    from app.services import billing_payment_attempt as svc

    sent = asyncio.Event()

    async def _mail(*_a, **_k):
        if mail == "broken":
            raise RuntimeError("smtp down")
        await asyncio.sleep(10)
        sent.set()

    monkeypatch.setattr(email_svc, "send_payment_receipt_email", _mail)
    async with Session() as s:
        org_id = await _new_org(s)
        attempt_id = uuid.uuid4()
        _, token = await svc.start_checkout_attempt(s, attempt_id=attempt_id, org_id=org_id, requested_by=None, tier="team", billing_cycle="monthly")
        started = time.monotonic()
        await svc.drive_attempt(s, attempt_id, token, auth_key="auth-1")
        elapsed = time.monotonic() - started
        assert (await svc.get_attempt(s, attempt_id)).status == "succeeded"
    assert elapsed < 2, elapsed
    from app.services.pg_pubsub import _background_tasks

    for task in list(_background_tasks):
        task.cancel()
    await asyncio.gather(*_background_tasks, return_exceptions=True)


# ── AC4 지연 주입(dev 전용) ─────────────────────────────────────────────────────────────────────────────

@pytest.mark.anyio
@pytest.mark.parametrize("deploy_env, expect_slept", [("dev", True), ("prod", False)])
async def test_charge_response_delay_is_injected_only_outside_prod(monkeypatch, deploy_env, expect_slept):
    """AC4 라이브 판을 만드는 스위치 — 청구 응답만 늦춘다(청구 자체는 이미 끝남). prod 배포에선 값이 있어도 무시.
    뮤테이션: prod 확인을 빼면 prod 판이 잠들어 RED."""
    import app.core.config as config_module
    from app.services.payment import toss_adapter

    monkeypatch.setattr(config_module.settings, "toss_test_charge_response_delay_seconds", 30.0)
    monkeypatch.setattr(config_module.settings, "deploy_env", deploy_env)
    slept: list[float] = []

    async def _sleep(seconds):
        slept.append(seconds)

    async def _post(self, path, **kw):
        return {"paymentKey": "pay-x", "orderId": kw["json"]["orderId"]}

    monkeypatch.setattr(toss_adapter.asyncio, "sleep", _sleep)
    monkeypatch.setattr(toss_adapter.TossAdapter, "_post", _post)
    result = await toss_adapter.TossAdapter().charge(
        billing_key="bk", customer_key="ck", order_id="checkout-x", amount_minor=1000, order_name="t",
    )
    assert result["paymentKey"] == "pay-x"
    assert slept == ([30.0] if expect_slept else [])


# ── 까디르 돈 렌즈(4704) — ① 5xx · ③ 멱등 헤더 · ④ 늦은 확정 · ⑤ 환불 대기 · 표 공백 ─────────────────────────────

async def _checkout_attempt(Session):
    from app.services import billing_payment_attempt as svc

    async with Session() as s:
        org_id = await _new_org(s)
        attempt_id = uuid.uuid4()
        _, token = await svc.start_checkout_attempt(s, attempt_id=attempt_id, org_id=org_id, requested_by=None, tier="team", billing_cycle="monthly")
    return org_id, attempt_id, token


async def _worker_until_charge_called(Session, toss, attempt_id, token, *, auth_key="auth-1"):
    from app.services import billing_payment_attempt as svc

    async def _run():
        async with Session() as ws:
            await svc.drive_attempt(ws, attempt_id, token, auth_key=auth_key)

    task = asyncio.create_task(_run())
    for _ in range(200):
        if toss.charge_calls:
            break
        await asyncio.sleep(0.05)
    return task


@pytest.mark.anyio
@pytest.mark.parametrize("mode", ["5xx", "5xx_charged"])
async def test_toss_5xx_on_charge_is_not_a_decline_and_reconcile_decides(Session, toss, mode):
    """① — Toss 5xx는 «거절 · 청구 0»이 아니라 결과 불명: 시도는 진행 중 그대로 · 대사가 order_id 조회로 가린다.
    승인됐으면(5xx_charged) 완료 · 안 됐으면 10분 창 뒤 실패. 뮤테이션: 5xx를 declined로 끝내면 RED."""
    from app.services import billing_payment_attempt as svc

    toss.charge_mode = mode
    org_id, attempt_id, token = await _checkout_attempt(Session)
    async with Session() as s:
        await svc.drive_attempt(s, attempt_id, token, auth_key="auth-1")
        mid = await svc.get_attempt(s, attempt_id)
        assert (mid.status, mid.stage) == ("processing", "charge_started")
        await _expire_lease(s, attempt_id, charge_started_ago=svc.NOT_FOUND_FAIL_AFTER + timedelta(seconds=1))
        done = await svc.reconcile_attempt(s, attempt_id)
    assert done.status == ("succeeded" if mode == "5xx_charged" else "failed")
    assert toss.approvals == (1 if mode == "5xx_charged" else 0)


@pytest.mark.anyio
async def test_toss_5xx_on_billing_key_issue_leaves_the_attempt_for_reconcile(Session, toss):
    from app.services import billing_payment_attempt as svc
    from app.services.payment.toss_adapter import TossApiError

    async def _issue_500(self, path, **kw):
        raise TossApiError("PROVIDER_ERROR", "Toss issue failed", status_code=500)

    org_id, attempt_id, token = await _checkout_attempt(Session)
    with patch("app.services.payment.toss_adapter.TossAdapter._post", new=_issue_500):
        async with Session() as s:
            await svc.drive_attempt(s, attempt_id, token, auth_key="auth-1")
            assert (await svc.get_attempt(s, attempt_id)).status == "processing"
    async with Session() as s:
        await _expire_lease(s, attempt_id)
        done = await svc.reconcile_attempt(s, attempt_id)
        assert (done.status, done.stage, done.reauth_required) == ("failed", "received", True)
    assert toss.charge_calls == []


@pytest.mark.anyio
async def test_idempotency_key_header_is_what_goes_on_the_wire(monkeypatch):
    """③ — 파이썬 인자가 아니라 실제로 나가는 HTTP 헤더 이름: `Idempotency-Key`(Toss 공식 문서). 예전 `Idempotent-Key`면 RED."""
    import httpx

    import app.core.config as config_module
    from app.services.payment import toss_adapter

    monkeypatch.setattr(config_module.settings, "toss_payments_secret_key", "test_sk")
    seen: list[httpx.Request] = []

    def handler(request: httpx.Request) -> httpx.Response:
        seen.append(request)
        return httpx.Response(200, json={"cancels": [{"transactionKey": "tx", "cancelAmount": 100}]})

    real_client = httpx.AsyncClient
    monkeypatch.setattr(toss_adapter.httpx, "AsyncClient", lambda **kw: real_client(transport=httpx.MockTransport(handler), **kw))
    await toss_adapter.TossAdapter().refund(payment_key="pk", cancel_reason="r", cancel_amount_minor=100, idempotency_key="tierchange-refund-abc")
    assert seen[0].headers.get("Idempotency-Key") == "tierchange-refund-abc"
    assert "Idempotent-Key" not in seen[0].headers


@pytest.mark.anyio
async def test_late_worker_charge_after_reconcile_failed_revives_and_grants_rights(Session, toss):
    """④ — 대사가 «Toss가 모름 · 10분»으로 failed를 적은 뒤, 오래 멈췄던 작업의 청구가 Toss DONE으로 돌아옴 → 돈을 받았으니 서비스를
    준다: 시도 succeeded · 구독 active · 청구 1. 뮤테이션: 늦은 확정 경로를 빼면 시도 failed · 구독 pending으로 남아 RED."""
    from app.services import billing_payment_attempt as svc

    toss.charge_mode = "hang_then_ok"
    toss.hang_event = asyncio.Event()
    org_id, attempt_id, token = await _checkout_attempt(Session)
    worker = await _worker_until_charge_called(Session, toss, attempt_id, token)
    saved = dict(toss.charged)
    toss.charged.clear()  # 조회 시점엔 Toss가 아직 모른다(NOT_FOUND)
    async with Session() as s:
        await _expire_lease(s, attempt_id, charge_started_ago=svc.NOT_FOUND_FAIL_AFTER + timedelta(seconds=1))
        assert (await svc.reconcile_attempt(s, attempt_id)).status == "failed"
    toss.charged.update(saved)
    toss.hang_event.set()
    await worker
    async with Session() as s:
        done = await svc.get_attempt(s, attempt_id)
        assert done.status == "succeeded" and "late charge" in (done.reason or "")
        assert (await _row(s, "SELECT status FROM org_subscriptions WHERE org_id=:o", o=org_id)).status == "active"
    assert toss.approvals == 1


@pytest.mark.anyio
async def test_late_worker_after_reconcile_succeeded_changes_nothing(Session, toss):
    """표: 대사 성공 뒤 늦은 워커 — 대사가 order_id 조회로 확정한 뒤 늦은 응답이 와도 두 번째 확정 · 원장 · 청구 0."""
    from app.services import billing_payment_attempt as svc

    toss.charge_mode = "hang_then_ok"
    toss.hang_event = asyncio.Event()
    org_id, attempt_id, token = await _checkout_attempt(Session)
    worker = await _worker_until_charge_called(Session, toss, attempt_id, token)
    async with Session() as s:
        await _expire_lease(s, attempt_id, charge_started_ago=timedelta(minutes=1))
        assert (await svc.reconcile_attempt(s, attempt_id)).status == "succeeded"
    toss.hang_event.set()
    await worker
    async with Session() as s:
        assert (await svc.get_attempt(s, attempt_id)).status == "succeeded"
        ledger = (await s.execute(text("SELECT count(*) FROM billing_ledger_entries WHERE org_id=:o"), {"o": org_id})).scalar_one()
        assert ledger == 1
    assert toss.approvals == 1 and len(toss.charge_calls) == 1


@pytest.mark.anyio
async def test_change_tier_refund_intent_survives_a_crash_and_the_sweep_sends_it_once(Session, toss, monkeypatch):
    """⑤ — 확정 커밋 전에 환불 의도(pending · 금액)를 적는다. 확정 뒤 환불 전에 죽으면 쓸기가 이어서 보내고, 다시 돌아도 취소는 1.
    뮤테이션: 의도를 커밋 뒤에 적으면(또는 안 적으면) 쓸기가 보낼 게 없어 RED."""
    from app.services import billing_payment_attempt as svc

    async with Session() as s:
        org_id = await _new_org(s, seats=1)
        await _seed_active_paid_subscription(s, org_id, tier="starter")
        await _seed_active_billing_key(s, org_id)
        await _seed_prior_confirmed_order(s, org_id, amount_minor=32_890)
        attempt_id = uuid.uuid4()
        _, token = await svc.start_change_tier_attempt(s, attempt_id=attempt_id, org_id=org_id, requested_by=None, new_tier="team")

    real_run = svc.run_pending_refund

    async def _crash(*_a, **_k):
        raise RuntimeError("instance vanished before the refund")

    monkeypatch.setattr(svc, "run_pending_refund", _crash)
    async with Session() as s:
        with pytest.raises(RuntimeError):
            await svc.drive_attempt(s, attempt_id, token)
        crashed = await svc.get_attempt(s, attempt_id)
        assert (crashed.status, crashed.refund_status) == ("succeeded", "pending") and crashed.refund_amount_minor > 0
    assert toss.cancel_calls == []

    monkeypatch.setattr(svc, "run_pending_refund", real_run)
    async with Session() as s:
        await svc.sweep_processing_attempts(s)
        await svc.sweep_processing_attempts(s)
        assert (await svc.get_attempt(s, attempt_id)).refund_status == "confirmed"
    assert len(toss.cancel_calls) == 1


@pytest.mark.anyio
async def test_stage_advances_to_key_issued_before_the_charge(Session, toss, monkeypatch):
    """표: 키 발급 뒤 단계 전진 — 청구 금액을 셀 때 이미 key_issued(울타리는 key_issued에서만 checkout 청구를 연다)."""
    from app.services import billing_payment_attempt as svc

    stages: list[str] = []
    real_inputs = svc._charge_inputs

    async def _spy(session, attempt):
        stages.append((await svc.get_attempt(session, attempt.id)).stage)
        return await real_inputs(session, attempt)

    monkeypatch.setattr(svc, "_charge_inputs", _spy)
    org_id, attempt_id, token = await _checkout_attempt(Session)
    async with Session() as s:
        await svc.drive_attempt(s, attempt_id, token, auth_key="auth-1")
    assert stages == ["key_issued"] and toss.issue_calls == 1 and toss.approvals == 1


@pytest.mark.anyio
async def test_key_issued_attempt_that_expires_fails_without_reauth_and_no_charge(Session, toss, monkeypatch):
    """표: key_issued 만료 — 빌링키는 발급됐지만 청구 전(행으로 증명)이라 failed · 청구 0 · 카드 인증부터 다시는 아님."""
    from app.services import billing_payment_attempt as svc

    async def _stop(*_a, **_k):
        raise RuntimeError("worker stops right after the billing key")

    monkeypatch.setattr(svc, "_charge_inputs", _stop)
    org_id, attempt_id, token = await _checkout_attempt(Session)
    async with Session() as s:
        with pytest.raises(RuntimeError):
            await svc.drive_attempt(s, attempt_id, token, auth_key="auth-1")
        assert (await svc.get_attempt(s, attempt_id)).stage == "key_issued"
        await _expire_lease(s, attempt_id)
        done = await svc.reconcile_attempt(s, attempt_id)
        assert (done.status, done.stage, done.reauth_required) == ("failed", "key_issued", False)
    assert toss.charge_calls == []


@pytest.mark.anyio
async def test_lease_lost_after_the_fence_the_reconciler_finishes_and_the_charge_stays_one(Session, toss):
    """표: 울타리 뒤 리스 상실 — 작업이 울타리를 넘어 청구 중인데 기한이 지나 대사가 가져감(조회 DONE → 확정) · 작업의 늦은 응답은
    확정을 두 번 하지 않는다."""
    from app.services import billing_payment_attempt as svc

    toss.charge_mode = "hang_then_ok"
    toss.hang_event = asyncio.Event()
    org_id, attempt_id, token = await _checkout_attempt(Session)
    worker = await _worker_until_charge_called(Session, toss, attempt_id, token)
    async with Session() as s:
        assert (await svc.get_attempt(s, attempt_id)).stage == "charge_started"
        await _expire_lease(s, attempt_id)
        assert (await svc.reconcile_attempt(s, attempt_id)).status == "succeeded"
    toss.hang_event.set()
    await worker
    assert toss.approvals == 1 and len(toss.charge_calls) == 1


@pytest.mark.anyio
@pytest.mark.parametrize("toss_status", ["ABORTED", "EXPIRED", "CANCELED"])
async def test_reconcile_non_done_toss_status_fails_the_attempt(Session, toss, toss_status):
    from app.services import billing_payment_attempt as svc

    toss.charge_mode = "network"
    org_id, attempt_id, token = await _checkout_attempt(Session)
    async with Session() as s:
        await svc.drive_attempt(s, attempt_id, token, auth_key="auth-1")
        toss.lookup_status = toss_status
        await _expire_lease(s, attempt_id)
        done = await svc.reconcile_attempt(s, attempt_id)
        assert (done.status, done.reason) == ("failed", f"toss status={toss_status}")
        assert (await _row(s, "SELECT status FROM billing_orders WHERE order_id=:x", x=done.order_id)).status == "failed"


@pytest.mark.anyio
async def test_reconcile_lookup_error_keeps_checking(Session, toss):
    """표: 조회 오류(Toss 5xx) — 결론 없이 «확인 중» 그대로 · 다음 조회가 다시 본다(기한을 지금으로 당김)."""
    from app.services import billing_payment_attempt as svc

    toss.charge_mode = "network"
    org_id, attempt_id, token = await _checkout_attempt(Session)
    async with Session() as s:
        await svc.drive_attempt(s, attempt_id, token, auth_key="auth-1")
        toss.lookup_status = "error"
        await _expire_lease(s, attempt_id, charge_started_ago=svc.NOT_FOUND_FAIL_AFTER + timedelta(minutes=1))
        checking = await svc.reconcile_attempt(s, attempt_id)
        assert checking.status == "processing"
        # 결과 모름 = 비종결 · 다음 조회는 간격을 두고(곧바로 다시 부르지 않는다).
        assert checking.next_check_at is not None and checking.next_check_at > datetime.now(timezone.utc)
        toss.lookup_status = None
        lookups = len(toss.lookup_calls)
        assert (await svc.reconcile_attempt(s, attempt_id)).status == "processing"
        assert len(toss.lookup_calls) == lookups, "다음 조회 시각 전엔 Toss를 부르지 않는다"
        await _expire_lease(s, attempt_id)
        assert (await svc.reconcile_attempt(s, attempt_id)).status == "succeeded", "다음 조회가 이어서 확정"


@pytest.mark.anyio
async def test_change_tier_other_id_same_org_while_one_is_processing_is_409(Session, toss):
    from app.services import billing_payment_attempt as svc
    from app.services.org_subscription_tier_change import TierChangeInProgress

    async with Session() as s:
        org_id = await _new_org(s, seats=1)
        await _seed_active_paid_subscription(s, org_id, tier="starter")
        await _seed_active_billing_key(s, org_id)
        await svc.start_change_tier_attempt(s, attempt_id=uuid.uuid4(), org_id=org_id, requested_by=None, new_tier="team")
        with pytest.raises(TierChangeInProgress):
            await svc.start_change_tier_attempt(s, attempt_id=uuid.uuid4(), org_id=org_id, requested_by=None, new_tier="business")
    assert toss.charge_calls == []


# ── 4704: «Toss 쪽 결과를 모르는 상태는 종결 상태가 아니다»(PO 04:08Z) — 상태 전이 표 ─────────────────────────────────
#
# | 비종결 → 종결 | Toss 확정 답(근거)                                    | 테스트                                                   |
# |---------------|-------------------------------------------------------|----------------------------------------------------------|
# | → declined    | 청구 4xx + 조회 NOT_FOUND · ABORTED/EXPIRED/CANCELED  | test_decline_needs_a_confirming_lookup                   |
# | (없음)        | 5xx · 408/409/429 · ALREADY_PROCESSED · DUP+조회 실패 | test_unknown_charge_outcomes_stay_processing             |
# | (없음)        | 거절 4xx인데 조회 오류 · 조회 DONE                    | test_decline_needs_a_confirming_lookup                   |
# | → succeeded   | 늦은 DONE + 의도 유효 + CAS                           | test_failed_not_found_then_done_within_24h_grants_rights |
# | → voided      | 늦은 DONE + 의도 무효 · 슬롯 바쁨 · CAS 잃음          | test_late_done_*_voids_and_refunds …                     |
# | 환불 → failed | 확정 4xx만                                            | test_refund_definite_4xx_fails_and_alerts                |
# | 환불 pending  | 5xx · 네트워크 · 200 뒤 응답 깨짐                     | test_refund_5xx_stays_pending_and_the_sweep_retries_same_key |


@pytest.fixture
def alerts(monkeypatch):
    from app.services import billing_payment_attempt as svc

    seen: list[tuple[str, uuid.UUID]] = []

    async def _record(event, attempt_id, detail, *, org_id, facts=None):
        # story #4341 — 알림마다 대상 조직이 실린다(운영 대화에서 어느 조직인지 읽히게). 없으면 기록하지 않아 그 테스트가 RED.
        if org_id is not None:
            seen.append((event, attempt_id))
        return False  # 전달 여부는 이 표의 관심 밖(운영 알림 서비스 자체는 test_4341_operator_alerts_realdb.py)

    monkeypatch.setattr(svc, "notify_operator", _record)
    return seen


async def _set(session, attempt_id, **values):
    from app.models.billing_payment_attempt import BillingPaymentAttempt

    await session.execute(update(BillingPaymentAttempt).where(BillingPaymentAttempt.id == attempt_id).values(**values))
    await session.commit()


@pytest.mark.anyio
@pytest.mark.parametrize("mode, code", [
    ("5xx", None),
    ("code", ("ALREADY_PROCESSED_PAYMENT", 400)),
    ("code", ("DUPLICATED_ORDER_ID", 400)),  # 중복 뒤 조회(가짜: NOT_FOUND → 4xx)도 결과 모름
    ("code", ("REQUEST_TIMEOUT", 408)),
    ("code", ("TOO_MANY_REQUESTS", 429)),
    ("code", ("CONFLICT", 409)),
    ("network", None),
])
async def test_unknown_charge_outcomes_stay_processing(Session, toss, mode, code):
    """까디르 P2 · PO 규칙 — 청구 응답이 «처리됐는지 모름»이면 declined/failed를 적지 않는다: 진행 중 그대로 · 청구 슬롯 유지.
    뮤테이션: `_outcome_unknown`에서 코드 · 상태 표를 빼면 ALREADY_PROCESSED · 408/409/429가 declined로 끝나 RED."""
    from app.services import billing_payment_attempt as svc

    toss.charge_mode, toss.charge_code = mode, code
    if code and code[0] == "DUPLICATED_ORDER_ID":
        toss.lookup_error = ("FORBIDDEN_REQUEST", 403)
    org_id, attempt_id, token = await _checkout_attempt(Session)
    async with Session() as s:
        await svc.drive_attempt(s, attempt_id, token, auth_key="auth-1")
        after = await svc.get_attempt(s, attempt_id)
        assert (after.status, after.stage) == ("processing", "charge_started"), f"{mode} {code}"
        assert (await _row(s, "SELECT checkout_claimed_at FROM org_subscriptions WHERE org_id=:o", o=org_id)).checkout_claimed_at is not None


@pytest.mark.anyio
@pytest.mark.parametrize("lookup, expected", [
    ("not_found", "declined"),
    ("ABORTED", "declined"),
    ("CANCELED", "declined"),
    ("error", "processing"),
    ("forbidden", "processing"),
    ("DONE", "processing"),
])
async def test_decline_needs_a_confirming_lookup(Session, toss, lookup, expected):
    """거절 4xx만으로는 끝내지 않는다 — Toss 조회가 «결제 없음» 또는 끝난 결제를 확정할 때만 declined. 조회가 오류 · DONE이면 진행 중.
    뮤테이션: 확인 조회 없이 4xx → declined면 error/forbidden/DONE 칸이 RED."""
    from app.services import billing_payment_attempt as svc

    toss.charge_mode = "decline"
    if lookup == "error":
        toss.lookup_status = "error"
    elif lookup == "forbidden":
        toss.lookup_error = ("FORBIDDEN_REQUEST", 403)
    elif lookup != "not_found":
        toss.lookup_status = lookup
    org_id, attempt_id, token = await _checkout_attempt(Session)
    async with Session() as s:
        await svc.drive_attempt(s, attempt_id, token, auth_key="auth-1")
        assert (await svc.get_attempt(s, attempt_id)).status == expected


async def _ended_not_found_checkout(Session, toss):
    """청구는 Toss에 닿았는데(승인됨) 조회가 한동안 «없음» → 10분 뒤 failed(NOT_FOUND)로 끝난 checkout. Toss 승인 기록은 되돌려 둔다."""
    from app.services import billing_payment_attempt as svc

    toss.charge_mode = "network"  # 도달했고 응답만 잃음 — 가짜 Toss에 승인 기록
    org_id, attempt_id, token = await _checkout_attempt(Session)
    async with Session() as s:
        await svc.drive_attempt(s, attempt_id, token, auth_key="auth-1")
    saved = dict(toss.charged)
    toss.charged.clear()
    async with Session() as s:
        await _expire_lease(s, attempt_id, charge_started_ago=svc.NOT_FOUND_FAIL_AFTER + timedelta(seconds=1))
        ended = await svc.reconcile_attempt(s, attempt_id)
        assert (ended.status, ended.reason) == ("failed", svc.REASON_NOT_FOUND_AT_TOSS)
        assert ended.next_check_at is not None, "청구 시작 흔적이 있으면 종결 뒤에도 재조회 예약"
    toss.charged.update(saved)
    return org_id, attempt_id


@pytest.mark.anyio
async def test_failed_not_found_then_done_within_24h_grants_rights(Session, toss, alerts):
    """까디르 ① — 10분 창 뒤 failed가 된 시도가 Toss에서 DONE → 쓸기 재조회가 늦은 성공 길로: 권리 적용(succeeded · active) · 청구 1.
    뮤테이션: 쓸기에서 종결 재조회(`recheck_ended_attempt`)를 빼면 failed 그대로 · 구독 pending → RED."""
    from app.services import billing_payment_attempt as svc

    org_id, attempt_id = await _ended_not_found_checkout(Session, toss)
    async with Session() as s:
        await _set(s, attempt_id, next_check_at=datetime.now(timezone.utc) - timedelta(seconds=1))
        result = await svc.sweep_processing_attempts(s)
        assert result.get("recheck_late") == 1
        done = await svc.get_attempt(s, attempt_id)
        assert (done.status, done.next_check_at) == ("succeeded", None)
        assert (await _row(s, "SELECT status, tier FROM org_subscriptions WHERE org_id=:o", o=org_id)) == ("active", "team")
        order = await _row(s, "SELECT status FROM billing_orders WHERE order_id=:oid", oid=done.order_id)
        assert order.status == "confirmed"
    assert toss.approvals == 1 and ("late_charge", attempt_id) in alerts


@pytest.mark.anyio
async def test_failed_not_found_then_done_after_a_later_success_voids_and_refunds(Session, toss, alerts):
    """P1 — 그 사이 같은 org의 다른 결제가 성공했다 → 늦은 DONE은 지금 상태를 덮어쓰지 않는다: voided + 제 청구 전액 환불 + 알림.
    뮤테이션: 의도 확인(`_stale_intent`)을 빼면 늦은 시도가 구독을 옛 시도 등급으로 덮어써 RED(tier · status 단언)."""
    from app.services import billing_payment_attempt as svc

    org_id, attempt_id = await _ended_not_found_checkout(Session, toss)
    toss.charge_mode = "ok"
    async with Session() as s:
        later_id = uuid.uuid4()
        _, later_token = await svc.start_checkout_attempt(
            s, attempt_id=later_id, org_id=org_id, requested_by=None, tier="business", billing_cycle="annual",
        )
        await svc.drive_attempt(s, later_id, later_token, auth_key="auth-2")
        assert (await svc.get_attempt(s, later_id)).status == "succeeded"
        await _set(s, attempt_id, next_check_at=datetime.now(timezone.utc) - timedelta(seconds=1))
        await svc.sweep_processing_attempts(s)
        voided = await svc.get_attempt(s, attempt_id)
        assert voided.status == "voided" and "later payment change" in voided.reason
        assert (voided.refund_status, voided.refund_target_order_id) == ("confirmed", voided.order_id)
        own = await _row(s, "SELECT amount_minor, refund_status FROM billing_orders WHERE order_id=:oid", oid=voided.order_id)
        assert voided.refund_amount_minor == own.amount_minor and own.refund_status == "confirmed"
        sub = await _row(s, "SELECT status, tier, billing_cycle FROM org_subscriptions WHERE org_id=:o", o=org_id)
        assert tuple(sub) == ("active", "business", "annual"), "늦은 시도가 지금 상태를 덮어쓰지 않는다"
    assert toss.cancel_keys == [f"attempt-void-refund-{attempt_id.hex}"]
    assert ("payment_voided", attempt_id) in alerts


@pytest.mark.anyio
async def test_late_done_while_the_org_slot_is_busy_voids_and_refunds_instead_of_reason_only(Session, toss, alerts):
    """P1 — 슬롯이 다른 작업에 쥐여 있으면 «이유만 남기고 권리 0 · 재시도 0»이 아니라 voided + 전액 환불.
    뮤테이션: 슬롯 바쁨 갈래를 예전처럼 사유만 적고 return하면 status failed · 환불 0으로 RED."""
    from app.services import billing_payment_attempt as svc

    org_id, attempt_id = await _ended_not_found_checkout(Session, toss)
    async with Session() as s:
        await _set_slot(s, org_id)
        await _set(s, attempt_id, next_check_at=datetime.now(timezone.utc) - timedelta(seconds=1))
        await svc.sweep_processing_attempts(s)
        voided = await svc.get_attempt(s, attempt_id)
        assert (voided.status, voided.refund_status) == ("voided", "confirmed") and "slot busy" in voided.reason
    assert len(toss.cancel_calls) == 1


async def _set_slot(session, org_id):
    await session.execute(
        text("UPDATE org_subscriptions SET checkout_claimed_at = now() WHERE org_id = :o"), {"o": org_id},
    )
    await session.commit()


@pytest.mark.anyio
async def test_cas_lost_at_finalize_does_not_write_succeeded(Session, toss, alerts, monkeypatch):
    """P1 — 권리 전이 CAS를 잃은 쪽은 succeeded를 적지 않는다 → voided + 전액 환불.
    뮤테이션: `changed == 0`에서 예전처럼 succeeded + 사유면 RED."""
    from app.services import billing_payment_attempt as svc
    from app.services import org_subscription_checkout as checkout_svc

    async def _lost(*_a, **_k):
        return 0

    monkeypatch.setattr(checkout_svc, "activate_claimed_subscription", _lost)
    org_id, attempt_id, token = await _checkout_attempt(Session)
    async with Session() as s:
        await svc.drive_attempt(s, attempt_id, token, auth_key="auth-1")
        done = await svc.get_attempt(s, attempt_id)
        assert (done.status, done.refund_status) == ("voided", "confirmed") and "claim lost" in done.reason
    assert toss.approvals == 1 and len(toss.cancel_calls) == 1


@pytest.mark.anyio
async def test_change_tier_late_done_after_the_plan_changed_voids_without_the_old_partial_refund(Session, toss, alerts):
    """P1 · change-tier — 시작 뒤 구독 요금제 판이 바뀌었다(다른 변경 · 등급은 그대로) → 늦은 DONE은 voided. 옛 결제 부분 환불은 버리고(권리가 안
    바뀌었으니) 제 청구만 전액 환불. 뮤테이션: 요금제 판 비교를 빼면 옛 시도 등급으로 덮어써 RED."""
    from app.services import billing_payment_attempt as svc

    async with Session() as s:
        org_id = await _new_org(s, seats=1)
        await _seed_active_paid_subscription(s, org_id, tier="starter")
        await _seed_active_billing_key(s, org_id)
        await _seed_prior_confirmed_order(s, org_id, amount_minor=32_890)
        attempt_id = uuid.uuid4()
        attempt, token = await svc.start_change_tier_attempt(s, attempt_id=attempt_id, org_id=org_id, requested_by=None, new_tier="team")
        old_target = attempt.refund_target_order_id
    toss.charge_mode = "network"
    async with Session() as s:
        await svc.drive_attempt(s, attempt_id, token)
    saved = dict(toss.charged)
    toss.charged.clear()
    async with Session() as s:
        await _expire_lease(s, attempt_id, charge_started_ago=svc.NOT_FOUND_FAIL_AFTER + timedelta(seconds=1))
        assert (await svc.reconcile_attempt(s, attempt_id)).status == "failed"
        # 그 사이 다른 경로가 요금제 판만 바꿨다(등급은 starter 그대로 — 등급 검증은 통과해 판 비교만이 잡는 판).
        other = (await s.execute(text("SELECT id FROM offering_versions WHERE id <> (SELECT offering_version_id FROM org_subscriptions WHERE org_id=:o) LIMIT 1"), {"o": org_id})).scalar_one()
        await s.execute(text("UPDATE org_subscriptions SET offering_version_id=:v WHERE org_id=:o"), {"v": other, "o": org_id})
        await s.commit()
    toss.charged.update(saved)
    async with Session() as s:
        await _set(s, attempt_id, next_check_at=datetime.now(timezone.utc) - timedelta(seconds=1))
        await svc.sweep_processing_attempts(s)
        voided = await svc.get_attempt(s, attempt_id)
        assert voided.status == "voided" and "plan changed" in voided.reason
        assert voided.refund_target_order_id == voided.order_id != old_target
        sub = await _row(s, "SELECT tier, offering_version_id FROM org_subscriptions WHERE org_id=:o", o=org_id)
        assert (sub.tier, sub.offering_version_id) == ("starter", other), "늦은 시도가 지금 판을 덮어쓰지 않는다"
        old = await _row(s, "SELECT refund_status FROM billing_orders WHERE order_id=:oid", oid=old_target)
        assert old.refund_status is None, "옛 결제 부분 환불은 보내지 않는다"
    assert toss.cancel_keys == [f"attempt-void-refund-{attempt_id.hex}"]


@pytest.mark.anyio
async def test_recheck_stops_after_24h_and_alerts_only_without_a_definite_answer(Session, toss, alerts):
    """24시간 표 줄 — 창이 끝날 때까지 답이 없으면(조회 오류) 재조회를 멈추고(`next_check_at` 비움) 상태는 failed 그대로 + 운영자 알림.
    답이 «없음»(NOT_FOUND)이면 조용히 멈춘다."""
    from app.services import billing_payment_attempt as svc

    org_id, attempt_id = await _ended_not_found_checkout(Session, toss)
    toss.charged.clear()
    past = datetime.now(timezone.utc) - svc.RECHECK_WINDOW - timedelta(minutes=1)
    async with Session() as s:
        await _set(s, attempt_id, finished_at=past, next_check_at=datetime.now(timezone.utc) - timedelta(seconds=1))
        assert await svc.recheck_ended_attempt(s, attempt_id) == "still_ended"
        ended = await svc.get_attempt(s, attempt_id)
        assert (ended.status, ended.next_check_at) == ("failed", None)
        assert ("recheck_window_closed", attempt_id) not in alerts, "NOT_FOUND = 확정 답"
        toss.lookup_status = "error"
        await _set(s, attempt_id, next_check_at=datetime.now(timezone.utc) - timedelta(seconds=1))
        await svc.recheck_ended_attempt(s, attempt_id)
    assert ("recheck_window_closed", attempt_id) in alerts


@pytest.mark.anyio
@pytest.mark.parametrize("mode", ["5xx", "5xx_done", "network"])
async def test_refund_5xx_stays_pending_and_the_sweep_retries_same_key(Session, toss, alerts, mode):
    """까디르 ② — 환불 5xx · 네트워크(Toss는 환불했는데 응답만 잃은 경우 포함)는 failed가 아니라 pending · 다음 쓸기가 같은 멱등키로
    다시 → confirmed · Toss 환불은 1. 뮤테이션: 모든 예외를 failed로 접으면(옛 동기 경로의 부분취소 방식 — story #4344에서 걷힘) RED."""
    from app.services import billing_payment_attempt as svc

    async with Session() as s:
        org_id = await _new_org(s, seats=1)
        await _seed_active_paid_subscription(s, org_id, tier="starter")
        await _seed_active_billing_key(s, org_id)
        await _seed_prior_confirmed_order(s, org_id, amount_minor=32_890)
        attempt_id = uuid.uuid4()
        _, token = await svc.start_change_tier_attempt(s, attempt_id=attempt_id, org_id=org_id, requested_by=None, new_tier="team")
        toss.cancel_mode = mode
        await svc.drive_attempt(s, attempt_id, token)
        first = await svc.get_attempt(s, attempt_id)
        assert (first.status, first.refund_status) == ("succeeded", "pending")
        assert first.next_check_at is not None
        toss.cancel_mode = "ok"
        await _set(s, attempt_id, next_check_at=datetime.now(timezone.utc) - timedelta(seconds=1))
        await svc.sweep_processing_attempts(s)
        assert (await svc.get_attempt(s, attempt_id)).refund_status == "confirmed"
    key = f"tierchange-refund-{attempt_id.hex}"
    assert set(toss.cancel_keys) == {key} and len(toss.cancel_keys) == 2 and len(toss.refunded) == 1


@pytest.mark.anyio
async def test_refund_definite_4xx_fails_and_alerts(Session, toss, alerts):
    from app.services import billing_payment_attempt as svc

    async with Session() as s:
        org_id = await _new_org(s, seats=1)
        await _seed_active_paid_subscription(s, org_id, tier="starter")
        await _seed_active_billing_key(s, org_id)
        await _seed_prior_confirmed_order(s, org_id, amount_minor=32_890)
        attempt_id = uuid.uuid4()
        attempt, token = await svc.start_change_tier_attempt(s, attempt_id=attempt_id, org_id=org_id, requested_by=None, new_tier="team")
        toss.cancel_mode = "decline"
        await svc.drive_attempt(s, attempt_id, token)
        done = await svc.get_attempt(s, attempt_id)
        assert (done.refund_status, done.next_check_at) == ("failed", None)
        old = await _row(s, "SELECT refund_status FROM billing_orders WHERE order_id=:oid", oid=attempt.refund_target_order_id)
        assert old.refund_status == "failed"
    assert ("refund_failed", attempt_id) in alerts


@pytest.mark.anyio
async def test_two_concurrent_refund_drivers_send_one_refund(Session, toss, alerts, monkeypatch):
    """까디르 ② — 동시 쓸기 둘이 같은 환불 대기를 잡아도 Toss 호출은 1(행 잠금 SKIP LOCKED + 환불 기한).
    뮤테이션: `with_for_update(skip_locked=True)` · `refund_lease_until`을 빼면 두 호출이 다 나가 RED."""
    from app.services import billing_payment_attempt as svc

    async with Session() as s:
        org_id = await _new_org(s, seats=1)
        await _seed_active_paid_subscription(s, org_id, tier="starter")
        await _seed_active_billing_key(s, org_id)
        await _seed_prior_confirmed_order(s, org_id, amount_minor=32_890)
        attempt_id = uuid.uuid4()
        _, token = await svc.start_change_tier_attempt(s, attempt_id=attempt_id, org_id=org_id, requested_by=None, new_tier="team")
    real = svc.run_pending_refund

    async def _defer(*_a, **_k):
        return "pending"

    monkeypatch.setattr(svc, "run_pending_refund", _defer)
    async with Session() as s:
        await svc.drive_attempt(s, attempt_id, token)
        assert (await svc.get_attempt(s, attempt_id)).refund_status == "pending"
    monkeypatch.setattr(svc, "run_pending_refund", real)
    toss.cancel_mode = "slow"

    async def _drive():
        async with Session() as s:
            return await svc.run_pending_refund(s, attempt_id)

    results = await asyncio.gather(_drive(), _drive())
    assert sorted(results, key=str) == ["confirmed", "pending"] or results == ["confirmed", "confirmed"]
    assert len(toss.cancel_calls) == 1


@pytest.mark.anyio
async def test_sweep_skips_rows_not_yet_due_and_defers_when_the_tick_budget_runs_out(Session, toss):
    """5분 틱이 전부를 매번 부르지 않는다: `next_check_at`이 안 된 행은 건드리지 않고, 남은 예산이 한 건 최악보다 작으면 새 건을 집지
    않는다(다음 틱이 이어받음)."""
    from app.services import billing_payment_attempt as svc

    toss.charge_mode = "network"
    org_id, attempt_id, token = await _checkout_attempt(Session)
    async with Session() as s:
        await svc.drive_attempt(s, attempt_id, token, auth_key="auth-1")
        await _set(s, attempt_id, lease_expires_at=datetime.now(timezone.utc) - timedelta(seconds=1),
                   next_check_at=datetime.now(timezone.utc) + timedelta(minutes=5))
        # 같은 DB에 앞 테스트의 due 행이 남아 있을 수 있다 — 이 시도의 조회 여부만 본다.
        order_id = (await svc.get_attempt(s, attempt_id)).order_id
        toss.lookup_calls.clear()
        await svc.sweep_processing_attempts(s)
        assert order_id not in toss.lookup_calls, "다음 조회 시각 전"
        await _set(s, attempt_id, next_check_at=datetime.now(timezone.utc) - timedelta(seconds=1))
        toss.lookup_calls.clear()
        deferred = await svc.sweep_processing_attempts(s, budget_seconds=svc.SWEEP_ITEM_WORST_SECONDS - 1)
        assert deferred.get("deferred", 0) >= 1 and toss.lookup_calls == []
        await svc.sweep_processing_attempts(s)
        assert (await svc.get_attempt(s, attempt_id)).status == "succeeded"



# ── 까디르 4704 돈 렌즈(PO 05:05Z) — «돈 기록 하나에 주인 하나» · 환불 기한 주인 · 로컬 주문 없는 DONE ──────────────────────


@pytest.mark.anyio
async def test_attempt_owned_orders_are_left_to_the_attempt_sweep_by_dunning_and_stale_sweeps(Session, toss):
    """P1 — 시도가 주인인 주문(`payment_attempt_id`)은 옛 dunning(매일 재청구 · 기한 뒤 무료 강등)과 stale-order 쓸기가 건너뛴다.
    주인 없는 옛 갱신 실패 주문은 dunning이 그대로 재청구한다(회귀 0).
    뮤테이션: 두 쓸기의 `payment_attempt_id.is_(None)` 걸러냄을 빼면 시도 주문이 재청구 · 조회되어 RED."""
    from app.services import billing_payment_attempt as svc
    from app.services.billing_scheduler import sweep_dunning_retries, sweep_stale_pending_orders

    toss.charge_mode = "decline"
    org_id, attempt_id, token = await _checkout_attempt(Session)
    now = datetime.now(timezone.utc)
    two_days_ago = now - timedelta(days=2)
    async with Session() as s:
        await svc.drive_attempt(s, attempt_id, token, auth_key="auth-1")
        assert (await svc.get_attempt(s, attempt_id)).status == "declined"
        owned = await _row(s, "SELECT order_id, status, payment_attempt_id FROM billing_orders WHERE org_id=:o", o=org_id)
        assert (owned.status, owned.payment_attempt_id) == ("failed", attempt_id)
        renewal_id = f"renewal:{uuid.uuid4().hex}"
        await s.execute(
            text(
                "INSERT INTO billing_orders (id, org_id, order_id, amount_minor, currency, status, purpose, created_at, updated_at) "
                "VALUES (:id, :o, :oid, 29000, 'krw', 'failed', 'charge', :t, :t)"
            ),
            {"id": uuid.uuid4(), "o": org_id, "oid": renewal_id, "t": two_days_ago},
        )
        await s.execute(text("UPDATE billing_orders SET created_at=:t, updated_at=:t WHERE order_id=:oid"), {"t": two_days_ago, "oid": owned.order_id})
        await s.commit()

        toss.charge_mode = "ok"
        toss.charge_calls.clear()
        await sweep_dunning_retries(s, now=now)
        assert toss.charge_calls == [renewal_id], "시도 주문을 dunning이 다시 청구했다"
        # 갱신 재청구 성공이 구독을 active로 돌린다(옛 동작) — 그 뒤 상태가 기준.
        sub_before = tuple(await _row(s, "SELECT tier, status FROM org_subscriptions WHERE org_id=:o", o=org_id))

        month_ago = now - timedelta(days=30)
        await s.execute(text("UPDATE billing_orders SET created_at=:t, updated_at=:t WHERE order_id=:oid"), {"t": month_ago, "oid": owned.order_id})
        await s.commit()
        await sweep_dunning_retries(s, now=now)
        assert tuple(await _row(s, "SELECT tier, status FROM org_subscriptions WHERE org_id=:o", o=org_id)) == sub_before, "시도 주문 때문에 무료 강등"

        await s.execute(text("UPDATE billing_orders SET status='pending', created_at=:t WHERE order_id=:oid"), {"t": now - timedelta(hours=1), "oid": owned.order_id})
        await s.commit()
        toss.lookup_calls.clear()
        await sweep_stale_pending_orders(s, now=now)
        assert owned.order_id not in toss.lookup_calls, "시도 주문을 stale 쓸기가 판정했다"


@pytest.mark.anyio
async def test_a_refund_driver_whose_lease_was_taken_over_does_not_write_its_result(Session, toss, alerts, monkeypatch):
    """P2 — 환불 결과는 기한의 주인만 적는다: A가 호출 중 기한이 지나 B가 다시 집어 confirmed로 끝냈으면, 늦게 끝난 A의 «실패»는
    버려진다. 뮤테이션: 최종 UPDATE의 `refund_lease_until == my_lease` 조건을 빼면 confirmed가 failed로 덮여 RED."""
    from app.services import billing_payment_attempt as svc
    from app.services.billing_refund import RefundError

    async with Session() as s:
        org_id = await _new_org(s, seats=1)
        await _seed_active_paid_subscription(s, org_id, tier="starter")
        await _seed_active_billing_key(s, org_id)
        await _seed_prior_confirmed_order(s, org_id, amount_minor=32_890)
        attempt_id = uuid.uuid4()
        _, token = await svc.start_change_tier_attempt(s, attempt_id=attempt_id, org_id=org_id, requested_by=None, new_tier="team")
    real = svc.run_pending_refund

    async def _defer(*_a, **_k):
        return "pending"

    monkeypatch.setattr(svc, "run_pending_refund", _defer)
    async with Session() as s:
        await svc.drive_attempt(s, attempt_id, token)
    monkeypatch.setattr(svc, "run_pending_refund", real)

    a_inside, a_release = asyncio.Event(), asyncio.Event()
    b_inside, b_release = asyncio.Event(), asyncio.Event()
    real_refund_org = svc.refund_org
    calls = {"n": 0}

    async def _refund_org(session, **kw):
        calls["n"] += 1
        if calls["n"] == 1:  # A — 호출 안에서 멈췄다가(그새 기한이 지남) «확정 거절»로 끝남
            a_inside.set()
            await a_release.wait()
            raise RefundError("pre-check failed late")
        b_inside.set()  # B — 기한을 넘겨받아 호출 중 · A가 먼저 끝난 뒤 정상 환불로 끝남
        await b_release.wait()
        return await real_refund_org(session, **kw)

    monkeypatch.setattr(svc, "refund_org", _refund_org)

    async def _drive():
        async with Session() as s:
            return await svc.run_pending_refund(s, attempt_id)

    task_a = asyncio.create_task(_drive())
    await a_inside.wait()
    async with Session() as s:
        await _set(s, attempt_id, refund_lease_until=datetime.now(timezone.utc) - timedelta(seconds=1))  # A의 기한이 지났다
    task_b = asyncio.create_task(_drive())
    await b_inside.wait()
    a_release.set()
    await task_a  # A가 B보다 먼저 끝난다 — 주인이 아니니 «실패»를 적으면 안 된다(시도 · 주문 둘 다)
    async with Session() as s:
        attempt = await svc.get_attempt(s, attempt_id)
        assert attempt.refund_status == "pending"
        old = await _row(s, "SELECT refund_status FROM billing_orders WHERE order_id=:oid", oid=attempt.refund_target_order_id)
        assert old.refund_status is None, "기한을 잃은 몰이꾼이 주문 쪽 환불 결과를 적었다"
    b_release.set()
    assert await task_b == "confirmed"
    async with Session() as s:
        attempt = await svc.get_attempt(s, attempt_id)
        assert attempt.refund_status == "confirmed"
        old = await _row(s, "SELECT refund_status FROM billing_orders WHERE order_id=:oid", oid=attempt.refund_target_order_id)
        assert old.refund_status == "confirmed"


@pytest.mark.anyio
@pytest.mark.parametrize("path", ["reconcile", "recheck"])
async def test_toss_done_without_a_local_order_is_voided_and_refunded(Session, toss, alerts, path):
    """P2 — Toss는 DONE인데 우리 주문 기록이 없다: 돈이 나갔으니 되돌려 놓기만 하지 않는다 — Toss 값으로 주문을 적고 voided +
    전액 환불(권리 0). 뮤테이션: `_record_done`이 없음을 알리지 않으면(예전처럼 False → 되돌려 놓기) 환불 0으로 RED."""
    from app.services import billing_payment_attempt as svc

    toss.charge_mode = "network"
    org_id, attempt_id, token = await _checkout_attempt(Session)
    async with Session() as s:
        await svc.drive_attempt(s, attempt_id, token, auth_key="auth-1")
        order_id = (await svc.get_attempt(s, attempt_id)).order_id
        if path == "recheck":
            saved = dict(toss.charged)
            toss.charged.clear()
            await _expire_lease(s, attempt_id, charge_started_ago=svc.NOT_FOUND_FAIL_AFTER + timedelta(seconds=1))
            assert (await svc.reconcile_attempt(s, attempt_id)).status == "failed"
            toss.charged.update(saved)
        await s.execute(text("DELETE FROM billing_orders WHERE order_id=:oid"), {"oid": order_id})
        await s.commit()
        if path == "reconcile":
            await _expire_lease(s, attempt_id, charge_started_ago=timedelta(minutes=1))
            await svc.reconcile_attempt(s, attempt_id)
        else:
            await _set(s, attempt_id, next_check_at=datetime.now(timezone.utc) - timedelta(seconds=1))
            await svc.recheck_ended_attempt(s, attempt_id)
        done = await svc.get_attempt(s, attempt_id)
        assert done.status == "voided" and "no local order" in done.reason
        assert (done.refund_status, done.refund_target_order_id) == ("confirmed", order_id)
        order = await _row(s, "SELECT status, payment_attempt_id, amount_minor FROM billing_orders WHERE order_id=:oid", oid=order_id)
        assert (order.status, order.payment_attempt_id) == ("confirmed", attempt_id) and order.amount_minor > 0
        assert (await _row(s, "SELECT status FROM org_subscriptions WHERE org_id=:o", o=org_id)).status != "active"
    assert toss.cancel_keys == [f"attempt-void-refund-{attempt_id.hex}"]



@pytest.mark.anyio
async def test_admin_retry_refuses_an_order_owned_by_a_payment_attempt(Session, toss):
    """까디르 P3(06:02Z) — 관리자 재시도도 «주인 하나»를 지킨다: 결제 시도가 주인인 실패 주문은 409 `ORDER_OWNED_BY_PAYMENT_ATTEMPT`
    · Toss 청구 0. 뮤테이션: 주인 확인을 빼면 `charge_org`가 다시 불려 청구 1로 RED."""
    from app.services import billing_payment_attempt as svc
    from app.services.admin_billing import AdminBillingError, retry_billing_order

    toss.charge_mode = "decline"
    org_id, attempt_id, token = await _checkout_attempt(Session)
    async with Session() as s:
        await svc.drive_attempt(s, attempt_id, token, auth_key="auth-1")
        order_id = (await svc.get_attempt(s, attempt_id)).order_id
        assert (await _row(s, "SELECT status FROM billing_orders WHERE order_id=:oid", oid=order_id)).status == "failed"
        toss.charge_mode = "ok"
        toss.charge_calls.clear()
        with pytest.raises(AdminBillingError) as exc_info:
            await retry_billing_order(s, org_id=org_id, order_id=order_id, actor_email="ops@example.com")
        assert (exc_info.value.status_code, exc_info.value.code) == (409, "ORDER_OWNED_BY_PAYMENT_ATTEMPT")
    assert toss.charge_calls == []
