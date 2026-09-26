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
            return {"paymentKey": path.split("/")[3], "status": "PARTIAL_CANCELED", "cancels": [{"cancelAmount": json["cancelAmount"], "transactionKey": f"tx-{uuid.uuid4().hex[:6]}"}]}
        # 청구 /v1/billing/{billingKey}
        order_id = json["orderId"]
        self.charge_calls.append(order_id)
        if self.charge_mode == "hang":
            assert self.hang_event is not None
            await self.hang_event.wait()
            raise RuntimeError("Cannot reach Toss API")  # 응답 전에 끊긴 판 — 그러나 Toss 쪽에선 승인됨(아래)
        if self.charge_mode == "network":
            self.charged.setdefault(order_id, f"pay-{uuid.uuid4().hex[:10]}")  # 도달은 했고 응답만 잃음
            raise RuntimeError("Cannot reach Toss API")
        if self.charge_mode == "decline":
            raise TossApiError("REJECT_CARD_COMPANY", "Toss charge failed", status_code=400)
        if order_id in self.charged:
            raise TossApiError(DUPLICATED_ORDER_ID, "Toss charge failed", status_code=400)
        payment_key = f"pay-{uuid.uuid4().hex[:10]}"
        self.charged[order_id] = payment_key
        return {"paymentKey": payment_key, "orderId": order_id, "receipt": {"url": f"https://r.example/{payment_key}"}}

    async def get(self, _self, path, *, timeout, op_label, quiet_codes=frozenset()):
        from app.services.payment.toss_adapter import TossApiError

        order_id = path.rsplit("/", 1)[-1]
        self.lookup_calls.append(order_id)
        if order_id not in self.charged:
            raise TossApiError("NOT_FOUND_PAYMENT", "Toss payment lookup failed", status_code=404)
        return {"status": "DONE", "paymentKey": self.charged[order_id], "orderId": order_id, "receipt": {"url": "https://r.example/x"}}

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

    values = {"lease_expires_at": datetime.now(timezone.utc) - timedelta(seconds=1)}
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
        assert result["seen"] >= 1 and (await svc.get_attempt(s, attempt_id)).status == "failed"


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
