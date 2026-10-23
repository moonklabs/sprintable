"""story #4755 — the scheduler's subscription writes take the organization row too, and a charge that settles on a closed organization goes back to the customer.

4753 gave the webhook and the admin grant the lock the closing paths take (organization row → subscription). The scheduler's own writes — the renewal retry that turns a subscription `active`, the renewal
roll-forward, the `free` downgrade, the restore when an expired grant ends — and the `subscription.canceled` webhook branch did not. Real PG, two connections (one holds the lock, the other is seen
waiting in pg_stat_activity). A confirmed charge for an organization that is gone is refunded in full with one idempotency key and an operator alert; a failed refund is recorded and retried, never doubled.
"""
from __future__ import annotations

import asyncio
import os
import uuid
from datetime import datetime, timezone

import pytest

_REAL_DB_URL = os.getenv("PARITY_TEST_DATABASE_URL") or os.getenv("ALEMBIC_DATABASE_URL")

pytestmark = [
    pytest.mark.skipif(not _REAL_DB_URL, reason="통합 테스트는 실 PG(PARITY/ALEMBIC_DATABASE_URL) 필요"),
    pytest.mark.anyio,
]


@pytest.fixture
def anyio_backend():
    return "asyncio"


@pytest.fixture(autouse=True)
async def _dispose_global_engine_after_test():
    yield
    from app.core.database import engine as _global_engine
    await _global_engine.dispose()


def _async_url() -> str:
    url = _REAL_DB_URL
    for prefix in ("postgresql+psycopg2://", "postgresql+asyncpg://", "postgresql://"):
        if url.startswith(prefix):
            return "postgresql+asyncpg://" + url[len(prefix):]
    return url


async def _factory():
    from sqlalchemy.ext.asyncio import async_sessionmaker, create_async_engine

    engine = create_async_engine(_async_url())
    return engine, async_sessionmaker(engine, expire_on_commit=False)


async def _seed_org(maker) -> uuid.UUID:
    from app.models.organization import Organization

    async with maker() as s:
        org = Organization(id=uuid.uuid4(), name="Org4753", slug=f"org4753-{uuid.uuid4().hex[:8]}")
        s.add(org)
        await s.commit()
        return org.id


async def _cleanup(maker, *org_ids) -> None:
    """What these tests wrote must not outlive them: a subscription row left behind carries a `pricing_version_id` of the shared seeded catalogue, and the tests that reset that catalogue
    (test_e_admin_b1_grandfather_wiring_realdb) then fail on the foreign key."""
    from sqlalchemy import text

    async with maker() as s:
        for o in org_ids:
            await s.execute(text("DELETE FROM org_subscriptions WHERE org_id = :o"), {"o": o})
            await s.execute(text("DELETE FROM org_members WHERE org_id = :o"), {"o": o})
            await s.execute(text("DELETE FROM organizations WHERE id = :o"), {"o": o})
        await s.execute(text("DELETE FROM polar_webhook_events WHERE event_id LIKE 'evt-4753-%'"))
        await s.execute(text("DELETE FROM operator_alerts WHERE dedupe_key LIKE 'billing.orphan_subscription_refused:%'"))
        await s.commit()


async def _scalar(maker, sql: str, **kw):
    from sqlalchemy import text

    async with maker() as s:
        return (await s.execute(text(sql), kw)).scalar_one()


async def _someone_waits_for_a_row_lock(maker, *, task: asyncio.Task, needle: str = "organizations") -> None:
    """Wait until a statement of this test is stuck behind a row lock (not finished) — the proof that the write took the lock the other side holds."""
    for _ in range(100):
        await asyncio.sleep(0.1)
        waiting = await _scalar(
            maker,
            "SELECT count(*) FROM pg_stat_activity WHERE wait_event_type = 'Lock' AND query ILIKE :q",
            q=f"%{needle}%FOR UPDATE%",
        )
        if waiting or task.done():
            break
    assert not task.done(), "the write finished without waiting for the organization row — it does not take the lock"


async def _webhook_event(maker, event_id: str) -> None:
    from sqlalchemy import text

    async with maker() as s:
        await s.execute(text("INSERT INTO polar_webhook_events (event_id, event_type) VALUES (:e, 'checkout.completed')"), {"e": event_id})
        await s.commit()




# ─── fakes for the money side: only the provider's refund is replaced, every row is real ───────────────────────────────────────────────────────────────────────────────────────────────────────────

class _FakeToss:
    calls: list[dict] = []
    fail_next = 0

    async def refund(self, **kw):
        _FakeToss.calls.append(kw)
        if _FakeToss.fail_next > 0:
            _FakeToss.fail_next -= 1
            raise RuntimeError("provider unreachable")
        return {"cancels": [{"transactionKey": f"tx-{len(_FakeToss.calls)}-{uuid.uuid4().hex[:6]}", "cancelAmount": 12000}]}


@pytest.fixture
def fake_toss(monkeypatch):
    import app.services.billing_refund as br

    _FakeToss.calls = []
    _FakeToss.fail_next = 0
    monkeypatch.setattr(br, "TossAdapter", _FakeToss)
    return _FakeToss


async def _seed_subscription(maker, org_id, *, status: str, tier: str = "team") -> None:
    from sqlalchemy import text

    async with maker() as s:
        await s.execute(
            text("INSERT INTO org_subscriptions (id, org_id, tier, billing_cycle, status, current_period_end) VALUES (gen_random_uuid(), :o, :t, 'monthly', :s, now() - interval '1 day')"),
            {"o": org_id, "t": tier, "s": status},
        )
        await s.commit()


async def _seed_order(maker, org_id, order_id: str, *, status: str) -> None:
    from sqlalchemy import text

    async with maker() as s:
        await s.execute(
            text("INSERT INTO billing_orders (id, org_id, order_id, amount_minor, currency, status, purpose, payment_key) VALUES (gen_random_uuid(), :o, :oid, 12000, 'krw', :s, 'charge', :pk)"),
            {"o": org_id, "oid": order_id, "s": status, "pk": f"pay-{uuid.uuid4().hex[:8]}" if status == "confirmed" else None},
        )
        await s.commit()


async def _cleanup_money(maker, *org_ids) -> None:
    from sqlalchemy import text

    async with maker() as s:
        for o in org_ids:
            for t in ("billing_orders", "org_billing_keys"):                  # (the ledger is append-only: its rows stay, keyed by a random organization id)
                await s.execute(text(f"DELETE FROM {t} WHERE org_id = :o"), {"o": o})
        await s.execute(text("DELETE FROM operator_alerts WHERE dedupe_key LIKE 'billing.charge_refund%'"))
        await s.commit()
    await _cleanup(maker, *org_ids)


async def _alert_kinds(maker, order_id: str) -> list[str]:
    from sqlalchemy import text

    async with maker() as s:
        rows = (await s.execute(text("SELECT kind FROM operator_alerts WHERE dedupe_key LIKE :k ORDER BY kind"), {"k": f"billing.charge_refund%:{order_id}"})).all()
    return [r[0] for r in rows]


async def test_01_a_renewal_retry_charged_while_the_organization_closes_is_refunded_not_turned_into_a_subscription(fake_toss):
    """The closing holds the row (a past_due subscription does not stop it); the retry's outcome sync waits, finds the organization gone, and — the charge being confirmed — refunds it in full
    (one idempotency key), leaves NO live subscription, records the refund on the order and alerts."""
    from sqlalchemy import text

    from app.repositories.organization import OrganizationRepository
    from app.services.billing_scheduler import _sync_renewal_retry_outcome

    engine, maker = await _factory()
    try:
        org_id = await _seed_org(maker)
        order_id = f"renewal:4755-{uuid.uuid4().hex[:8]}"
        await _seed_subscription(maker, org_id, status="past_due")
        await _seed_order(maker, org_id, order_id, status="confirmed")            # the retry's charge went through
        async with maker() as closer, maker() as sched:
            await closer.execute(text("SELECT 1 FROM organizations WHERE id = :o FOR UPDATE"), {"o": str(org_id)})
            task = asyncio.create_task(_sync_renewal_retry_outcome(sched, org_id, order_id, grace_days=7, now=datetime.now(timezone.utc)))
            await _someone_waits_for_a_row_lock(maker, task=task)
            assert (await OrganizationRepository(closer).delete_for_account_closure(org_id, uuid.uuid4())) == {"ok": True}
            await closer.commit()
            await asyncio.wait_for(task, timeout=20)
        assert await _scalar(maker, "SELECT count(*) FROM organizations WHERE id = :o", o=org_id) == 0
        assert await _scalar(maker, "SELECT status FROM org_subscriptions WHERE org_id = :o", o=org_id) == "canceled"      # not turned `active`
        assert [c["idempotency_key"] for c in fake_toss.calls] == [f"orgclosed-refund:{order_id}"]                            # refunded once, with the order's own key
        assert await _scalar(maker, "SELECT refund_status FROM billing_orders WHERE order_id = :o", o=order_id) == "confirmed"
        assert await _alert_kinds(maker, order_id) == ["billing.charge_refunded_org_closed"]
    finally:
        await _cleanup_money(maker, org_id)
        await engine.dispose()


async def test_02_a_refund_that_fails_is_recorded_alerted_retried_and_never_doubled(fake_toss):
    """The provider is down: the order says `refund_status = failed`, the failure alert goes out, the next sweep retries with the SAME key and it goes through; running the retry again (or the
    first path again) refunds nothing more — one ledger refund, one provider success."""
    from app.services.billing_closed_org_refund import refund_charge_for_closed_org, retry_failed_closed_org_refunds

    engine, maker = await _factory()
    try:
        org_id = await _seed_org(maker)
        order_id = f"renewal:4755-{uuid.uuid4().hex[:8]}"
        await _seed_order(maker, org_id, order_id, status="confirmed")
        async with maker() as s:                                              # the organization is gone
            from sqlalchemy import text
            await s.execute(text("DELETE FROM organizations WHERE id = :o"), {"o": org_id})
            await s.commit()
        fake_toss.fail_next = 1
        async with maker() as s:
            assert await refund_charge_for_closed_org(s, org_id=org_id, order_id=order_id) is False
        assert await _scalar(maker, "SELECT refund_status FROM billing_orders WHERE order_id = :o", o=order_id) == "failed"
        assert await _alert_kinds(maker, order_id) == ["billing.charge_refund_failed_org_closed"]
        async with maker() as s:
            assert await retry_failed_closed_org_refunds(s) >= 1             # the next sweep takes it up
        assert await _scalar(maker, "SELECT refund_status FROM billing_orders WHERE order_id = :o", o=order_id) == "confirmed"
        calls_after_success = len(fake_toss.calls)
        keys = {c["idempotency_key"] for c in fake_toss.calls}
        assert keys == {f"orgclosed-refund:{order_id}"} and calls_after_success == 2      # the failed try and the good one: the same key
        async with maker() as s:
            assert await retry_failed_closed_org_refunds(s) == 0             # nothing left to retry
            assert await refund_charge_for_closed_org(s, org_id=org_id, order_id=order_id) is True   # asked again: already refunded
        assert len(fake_toss.calls) == calls_after_success                     # the provider was not called a third time
        assert await _scalar(maker, "SELECT count(*) FROM billing_ledger_entries WHERE org_id = :o AND entry_type = 'refund'", o=org_id) == 1
    finally:
        await _cleanup_money(maker, org_id)
        await engine.dispose()


async def test_03_a_renewal_charged_while_the_organization_goes_is_refunded_and_the_period_is_not_rolled(fake_toss, monkeypatch):
    """`trigger_due_charges`: the charge is confirmed, the organization is gone when the result is written → refunded, the subscription's period untouched, an alert; for a live organization the period still rolls."""
    from sqlalchemy import text

    import app.services.billing_scheduler as bs
    from tests.test_2777_admin_billing_realdb import _seed_offering

    engine, maker = await _factory()
    try:
        async with maker() as s:
            await _seed_offering(s, tier="team", monthly_price_minor=12000)
        gone_org, live_org = await _seed_org(maker), await _seed_org(maker)
        orders = {gone_org: f"renewal:4755-g{uuid.uuid4().hex[:6]}", live_org: f"renewal:4755-l{uuid.uuid4().hex[:6]}"}
        async with maker() as s:
            offering = (await s.execute(text("SELECT id FROM offering_versions WHERE tier = 'team' AND currency = 'krw' AND effective_to IS NULL LIMIT 1"))).scalar_one()
            for o in (gone_org, live_org):
                await s.execute(text("INSERT INTO org_subscriptions (id, org_id, tier, billing_cycle, status, offering_version_id, current_period_end) VALUES (gen_random_uuid(), :o, 'team', 'monthly', 'active', :v, now() - interval '1 day')"), {"o": o, "v": offering})
            await s.commit()
        period_before = await _scalar(maker, "SELECT current_period_end FROM org_subscriptions WHERE org_id = :o", o=gone_org)

        async def fake_amount(session, *, org_id):
            if org_id not in orders:
                raise bs.ChargeAmountError("not part of this test")          # other rows of the shared database are left alone
            return 12000, "krw"

        async def fake_charge(session, *, org_id, order_id, amount_minor, currency, order_name=None, **kw):
            await _seed_order(maker, org_id, order_id, status="confirmed")   # the provider took the money…
            if org_id == gone_org:
                async with maker() as other:                                  # …and the organization went before the result was written
                    await other.execute(text("DELETE FROM organizations WHERE id = :o"), {"o": org_id})
                    await other.commit()
            async with maker() as other:
                return (await other.execute(text("SELECT 1"))) and await _order(maker, order_id)

        monkeypatch.setattr(bs, "compute_charge_amount", fake_amount)
        monkeypatch.setattr(bs, "charge_org", fake_charge)
        monkeypatch.setattr(bs, "_renewal_order_id", lambda org_id, offering_id, period_end: orders[org_id])
        async with maker() as s:
            await bs.trigger_due_charges(s)
        # the vanished organization: refunded once with the order's key, period untouched, alerted
        assert [c["idempotency_key"] for c in fake_toss.calls] == [f"orgclosed-refund:{orders[gone_org]}"]
        assert await _scalar(maker, "SELECT current_period_end FROM org_subscriptions WHERE org_id = :o", o=gone_org) == period_before
        assert await _alert_kinds(maker, orders[gone_org]) == ["billing.charge_refunded_org_closed"]
        # the live organization: the period rolled forward as before, no refund
        assert await _scalar(maker, "SELECT current_period_end > now() FROM org_subscriptions WHERE org_id = :o", o=live_org) is True
        assert await _alert_kinds(maker, orders[live_org]) == []
    finally:
        await _cleanup_money(maker, gone_org, live_org)
        await engine.dispose()


async def _order(maker, order_id: str):
    from sqlalchemy import select

    from app.models.billing_order import BillingOrder

    async with maker() as s:
        o = (await s.execute(select(BillingOrder).where(BillingOrder.order_id == order_id))).scalar_one()
        s.expunge(o)
        return o


async def test_04_the_free_downgrade_waits_for_a_closing_and_writes_no_subscription_for_a_closed_organization():
    """`downgrade_to_free`: the closing holds the row, the sweep waits, the organization is gone → NO `free` subscription row is created; the stale order is still ended (the sweep never picks it again)."""
    from sqlalchemy import text

    from app.repositories.organization import OrganizationRepository
    from app.services.billing_scheduler import downgrade_to_free

    engine, maker = await _factory()
    try:
        org_id = await _seed_org(maker)
        order_id = f"renewal:4755-{uuid.uuid4().hex[:8]}"
        await _seed_order(maker, org_id, order_id, status="failed")
        async with maker() as closer, maker() as sched:
            await closer.execute(text("SELECT 1 FROM organizations WHERE id = :o FOR UPDATE"), {"o": str(org_id)})
            task = asyncio.create_task(downgrade_to_free(sched, org_id, order_id))
            await _someone_waits_for_a_row_lock(maker, task=task)
            assert (await OrganizationRepository(closer).delete_for_account_closure(org_id, uuid.uuid4())) == {"ok": True}
            await closer.commit()
            await asyncio.wait_for(task, timeout=20)
        assert await _scalar(maker, "SELECT count(*) FROM org_subscriptions WHERE org_id = :o", o=org_id) == 0
        assert await _scalar(maker, "SELECT status FROM billing_orders WHERE order_id = :o", o=order_id) == "downgraded"
    finally:
        await _cleanup_money(maker, org_id)
        await engine.dispose()


async def test_05_an_expired_grant_of_a_closed_organization_restores_nothing_and_is_marked_moot():
    """`sweep_expired_grants`: the closing holds the row, the sweep waits, the organization is gone → the subscription is not restored (its row stays as the closing left it), the grant is marked moot
    (`org_closed`) so the next sweep does not look at it again."""
    from sqlalchemy import text

    from app.repositories.organization import OrganizationRepository
    from app.services.billing_ledger import record_ledger_entry
    from app.services.billing_scheduler import sweep_expired_grants

    engine, maker = await _factory()
    try:
        org_id = await _seed_org(maker)
        await _seed_subscription(maker, org_id, status="past_due", tier="team")
        async with maker() as s:
            grant = await record_ledger_entry(
                s, org_id=org_id, entry_type="credit_grant", amount_minor=12000, currency="krw", direction="credit",
                provider_ref=f"admin-grant:4755-{uuid.uuid4().hex[:8]}",
                metadata={"kind": "tier_grant", "target_tier": "team", "prev_tier": "free", "grant_expires_at": "2020-01-01T00:00:00+00:00", "months": 1},
            )
            grant_id = grant.id
        async with maker() as closer, maker() as sched:
            await closer.execute(text("SELECT 1 FROM organizations WHERE id = :o FOR UPDATE"), {"o": str(org_id)})
            task = asyncio.create_task(sweep_expired_grants(sched))
            await _someone_waits_for_a_row_lock(maker, task=task)
            assert (await OrganizationRepository(closer).delete_for_account_closure(org_id, uuid.uuid4())) == {"ok": True}
            await closer.commit()
            result = await asyncio.wait_for(task, timeout=20)
        assert result["skipped_org_closed"] >= 1
        assert await _scalar(maker, "SELECT tier || ':' || status FROM org_subscriptions WHERE org_id = :o", o=org_id) == "team:canceled"      # not restored to free/active
        assert await _scalar(maker, "SELECT count(*) FROM billing_ledger_entries WHERE org_id = :o AND metadata->>'kind' = 'tier_grant_revert' AND (metadata->>'org_closed')::boolean", o=org_id) == 1
        async with maker() as s:
            again = await sweep_expired_grants(s)
        assert await _scalar(maker, "SELECT count(*) FROM billing_ledger_entries WHERE org_id = :o AND metadata->>'kind' = 'tier_grant_revert'", o=org_id) == 1   # not looked at again
        assert grant_id is not None and again is not None
    finally:
        await _cleanup_money(maker, org_id)
        await engine.dispose()


async def test_06_the_canceled_webhook_branch_waits_for_a_closing_and_leaves_what_the_closing_wrote():
    """`subscription.canceled`: the closing holds the row, the cancellation waits; once the organization is gone its subscription is already `canceled` (the closing's spelling) and is not rewritten."""
    from sqlalchemy import text

    from app.repositories.organization import OrganizationRepository
    from ee.routers.billing import _cancel_subscription_by_provider_id

    engine, maker = await _factory()
    try:
        org_id = await _seed_org(maker)
        polar_id = f"sub_4755_{uuid.uuid4().hex[:8]}"
        async with maker() as s:
            await s.execute(text("INSERT INTO org_subscriptions (id, org_id, tier, status, polar_subscription_id) VALUES (gen_random_uuid(), :o, 'team', 'past_due', :p)"), {"o": org_id, "p": polar_id})
            await s.commit()
        async with maker() as closer, maker() as hook:
            await closer.execute(text("SELECT 1 FROM organizations WHERE id = :o FOR UPDATE"), {"o": str(org_id)})
            task = asyncio.create_task(_cancel_subscription_by_provider_id(hook, polar_id))
            await _someone_waits_for_a_row_lock(maker, task=task)
            assert (await OrganizationRepository(closer).delete_for_account_closure(org_id, uuid.uuid4())) == {"ok": True}
            await closer.commit()
            await asyncio.wait_for(task, timeout=20)
        assert await _scalar(maker, "SELECT status FROM org_subscriptions WHERE org_id = :o", o=org_id) == "canceled"
        # a live organization's subscription is cancelled as before
        live = await _seed_org(maker)
        live_polar = f"sub_4755_{uuid.uuid4().hex[:8]}"
        async with maker() as s:
            await s.execute(text("INSERT INTO org_subscriptions (id, org_id, tier, status, polar_subscription_id) VALUES (gen_random_uuid(), :o, 'team', 'active', :p)"), {"o": live, "p": live_polar})
            await s.commit()
        async with maker() as s:
            await _cancel_subscription_by_provider_id(s, live_polar)
        assert await _scalar(maker, "SELECT status FROM org_subscriptions WHERE org_id = :o", o=live) == "cancelled"
        await _cleanup_money(maker, live)
    finally:
        await _cleanup_money(maker, org_id)
        await engine.dispose()


async def test_07_the_scheduler_holds_the_row_the_closing_waits_and_then_sees_the_active_subscription(fake_toss, monkeypatch):
    """The other direction: the retry outcome holds the row while it turns the subscription `active`; the closing waits, then SEES the active subscription → `active_subscription`, the organization stays."""
    from app.repositories.organization import OrganizationRepository
    import app.services.billing_scheduler as bs

    engine, maker = await _factory()
    gate, arrived = asyncio.Event(), asyncio.Event()
    try:
        org_id = await _seed_org(maker)
        order_id = f"renewal:4755-{uuid.uuid4().hex[:8]}"
        await _seed_subscription(maker, org_id, status="past_due")
        await _seed_order(maker, org_id, order_id, status="confirmed")
        real_lock = bs.lock_org_for_billing_write

        async def parked(session, oid):
            ok = await real_lock(session, oid)            # takes the row…
            arrived.set()
            await gate.wait()                             # …and stays «in the middle of its write»
            return ok

        monkeypatch.setattr(bs, "lock_org_for_billing_write", parked)
        async with maker() as sched, maker() as closer:
            sync = asyncio.create_task(bs._sync_renewal_retry_outcome(sched, org_id, order_id, grace_days=7, now=datetime.now(timezone.utc)))
            await asyncio.wait_for(arrived.wait(), timeout=20)
            close = asyncio.create_task(OrganizationRepository(closer).delete_for_account_closure(org_id, uuid.uuid4()))
            await _someone_waits_for_a_row_lock(maker, task=close)
            gate.set()
            await asyncio.wait_for(sync, timeout=20)
            res = await asyncio.wait_for(close, timeout=20)
        assert res == {"ok": False, "reason": "active_subscription"}, res
        assert await _scalar(maker, "SELECT count(*) FROM organizations WHERE id = :o", o=org_id) == 1
        assert await _scalar(maker, "SELECT status FROM org_subscriptions WHERE org_id = :o", o=org_id) == "active"
        assert fake_toss.calls == []                       # a live organization: nothing refunded
    finally:
        await _cleanup_money(maker, org_id)
        await engine.dispose()


async def test_08_the_dunning_sweep_takes_up_a_failed_closed_organization_refund_again(fake_toss, monkeypatch):
    """The sweep (not only a direct call) retries a refund that failed for a closed organization — with the same key — and does nothing once it is refunded."""
    import app.services.billing_scheduler as bs

    engine, maker = await _factory()
    try:
        org_id = await _seed_org(maker)
        order_id = f"renewal:4755-{uuid.uuid4().hex[:8]}"
        await _seed_order(maker, org_id, order_id, status="confirmed")
        from sqlalchemy import text
        async with maker() as s:
            await s.execute(text("UPDATE billing_orders SET refund_status = 'failed' WHERE order_id = :o"), {"o": order_id})
            await s.execute(text("DELETE FROM organizations WHERE id = :o"), {"o": org_id})
            await s.commit()
        monkeypatch.setattr(bs, "next_dunning_action", lambda *a, **k: "wait")      # the sweep's own dunning decisions are not what this test is about; other rows of the shared database stay untouched
        async with maker() as s:
            await bs.sweep_dunning_retries(s)
        assert await _scalar(maker, "SELECT refund_status FROM billing_orders WHERE order_id = :o", o=order_id) == "confirmed"
        assert [c["idempotency_key"] for c in fake_toss.calls] == [f"orgclosed-refund:{order_id}"]
        async with maker() as s:
            await bs.sweep_dunning_retries(s)
        assert len(fake_toss.calls) == 1                                               # a second sweep refunds nothing more
    finally:
        await _cleanup_money(maker, org_id)
        await engine.dispose()
