"""story #4753 — a subscription write and an organization closing meet on the SAME organization row, in the same order.

Found by Kadir on 5189 (named there as a residual): the closing paths lock the `organizations` row, look at the subscription, and delete the row; the payment provider's webhook (and the admin
grant) wrote or activated a subscription without that lock — a subscription written between the look and the commit, or after it, left a live paid subscription on an organization that was going
or gone (`org_subscriptions` has no foreign key to `organizations`). Real PG, two connections: one holds the lock while the other waits (seen in pg_stat_activity).
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


async def test_01_the_closing_holds_the_row_the_webhook_waits_and_then_writes_no_subscription_for_the_closed_organization():
    """(a) the closing wins: it holds the organization row (and closes the organization); the webhook's write waits for the row, finds the organization gone, and writes NO subscription — it keeps
    the case where a person can find it (`refused_org_closed` on the event row) instead."""
    from sqlalchemy import text

    from app.repositories.organization import OrganizationRepository
    from ee.routers.billing import _update_subscription

    engine, maker = await _factory()
    try:
        org_id = await _seed_org(maker)
        event_id = f"evt-4753-{uuid.uuid4().hex[:8]}"
        await _webhook_event(maker, event_id)
        async with maker() as closer, maker() as hook:
            await closer.execute(text("SELECT 1 FROM organizations WHERE id = :o FOR UPDATE"), {"o": str(org_id)})         # the closing holds the row…
            task = asyncio.create_task(_update_subscription(hook, org_id, "pro", "monthly", "cus_4753", "sub_4753", "active", event_id))
            await _someone_waits_for_a_row_lock(maker, task=task)                                                           # …and the webhook is made to wait
            res = await OrganizationRepository(closer).delete_for_account_closure(org_id, uuid.uuid4())                      # the real closing
            assert res == {"ok": True}, res
            await closer.commit()
            await asyncio.wait_for(task, timeout=20)
        assert await _scalar(maker, "SELECT count(*) FROM organizations WHERE id = :o", o=org_id) == 0
        assert await _scalar(maker, "SELECT count(*) FROM org_subscriptions WHERE org_id = :o", o=org_id) == 0               # no live subscription on a closed organization
        row = await _scalar(maker, "SELECT outcome || ':' || org_id::text FROM polar_webhook_events WHERE event_id = :e", e=event_id)
        assert row == f"refused_org_closed:{org_id}"
    finally:
        await _cleanup(maker, org_id)
        await engine.dispose()


async def test_02_the_webhook_holds_the_row_the_closing_waits_and_then_sees_the_subscription_and_refuses():
    """(b) the webhook wins: it holds the organization row while it writes the subscription; the closing waits for the row, then SEES the subscription and refuses
    (`active_subscription` — the 409 of the owner's delete and of the account deletion). The organization stays."""
    from app.repositories.organization import OrganizationRepository
    import ee.routers.billing as billing

    engine, maker = await _factory()
    gate = asyncio.Event()
    try:
        org_id = await _seed_org(maker)
        original = billing._current_pricing_version_id

        async def held(session, tier, cycle, currency="usd"):
            await gate.wait()                                   # the webhook is «in the middle of its write», holding the organization row
            return await original(session, tier, cycle, currency)

        billing._current_pricing_version_id = held
        try:
            async with maker() as hook, maker() as closer:
                hook_task = asyncio.create_task(billing._update_subscription(hook, org_id, "pro", "monthly", "cus_4753", "sub_4753", "active", None))
                await asyncio.sleep(0.5)                       # it has taken the row and is parked at the gate
                close_task = asyncio.create_task(OrganizationRepository(closer).delete_for_account_closure(org_id, uuid.uuid4()))
                await _someone_waits_for_a_row_lock(maker, task=close_task)
                gate.set()                                     # the webhook finishes and commits
                await asyncio.wait_for(hook_task, timeout=20)
                res = await asyncio.wait_for(close_task, timeout=20)
        finally:
            billing._current_pricing_version_id = original
        assert res == {"ok": False, "reason": "active_subscription"}, res
        assert await _scalar(maker, "SELECT count(*) FROM organizations WHERE id = :o", o=org_id) == 1
        assert await _scalar(maker, "SELECT status FROM org_subscriptions WHERE org_id = :o", o=org_id) == "active"
    finally:
        await _cleanup(maker, org_id)
        await engine.dispose()


async def test_03_the_owners_organization_delete_meets_the_webhook_the_same_way():
    """The owner's delete (`delete_by_user`) is the other closing path: the webhook holds the row → the owner's delete waits → it sees the subscription → `active_subscription`."""
    from app.models.project import OrgMember
    from app.models.user import User
    from app.repositories.organization import OrganizationRepository
    import ee.routers.billing as billing

    engine, maker = await _factory()
    gate = asyncio.Event()
    try:
        org_id = await _seed_org(maker)
        uid = uuid.uuid4()
        async with maker() as s:
            s.add(User(id=uid, email=f"owner4753-{uid.hex[:8]}@test.com", hashed_password="x"))
            await s.commit()
            s.add(OrgMember(id=uuid.uuid4(), org_id=org_id, user_id=uid, role="owner"))
            await s.commit()
        original = billing._current_pricing_version_id

        async def held(session, tier, cycle, currency="usd"):
            await gate.wait()
            return await original(session, tier, cycle, currency)

        billing._current_pricing_version_id = held
        try:
            async with maker() as hook, maker() as closer:
                hook_task = asyncio.create_task(billing._update_subscription(hook, org_id, "pro", "yearly", "cus_4753", "sub_4753b", "active", None))
                await asyncio.sleep(0.5)
                close_task = asyncio.create_task(OrganizationRepository(closer).delete_by_user(org_id, uid, "Org4753", confirm_without_impact=True))
                await _someone_waits_for_a_row_lock(maker, task=close_task)
                gate.set()
                await asyncio.wait_for(hook_task, timeout=20)
                res = await asyncio.wait_for(close_task, timeout=20)
        finally:
            billing._current_pricing_version_id = original
        assert res == {"ok": False, "reason": "active_subscription"}, res
        assert await _scalar(maker, "SELECT count(*) FROM organizations WHERE id = :o", o=org_id) == 1
    finally:
        await _cleanup(maker, org_id)
        await engine.dispose()


async def test_04_a_webhook_for_an_organization_that_never_existed_writes_nothing_and_says_so():
    """Not only the race: a webhook naming an organization that is gone (closed long ago, or an id that was never one) writes no subscription row and is kept on the event row."""
    from ee.routers.billing import _update_subscription

    engine, maker = await _factory()
    try:
        ghost = uuid.uuid4()
        event_id = f"evt-4753-{uuid.uuid4().hex[:8]}"
        await _webhook_event(maker, event_id)
        async with maker() as hook:
            await _update_subscription(hook, ghost, "team", "monthly", "cus_x", "sub_x", "active", event_id)
        assert await _scalar(maker, "SELECT count(*) FROM org_subscriptions WHERE org_id = :o", o=ghost) == 0
        assert await _scalar(maker, "SELECT outcome FROM polar_webhook_events WHERE event_id = :e", e=event_id) == "refused_org_closed"
        # …and a webhook for a live organization still writes its subscription (the lock is not a refusal)
        live = await _seed_org(maker)
        async with maker() as hook:
            await _update_subscription(hook, live, "team", "monthly", "cus_y", "sub_y", "active", None)
        assert await _scalar(maker, "SELECT status FROM org_subscriptions WHERE org_id = :o", o=live) == "active"
    finally:
        await _cleanup(maker, live, ghost)
        await engine.dispose()


async def test_05_the_admin_grant_takes_the_same_row_and_refuses_a_closed_organization():
    """The admin grant also activates a tier: it takes the organization row first (a closing that holds it makes the grant wait) and refuses an organization that is gone (404 ORG_NOT_FOUND)."""
    from sqlalchemy import text

    from app.services.admin_billing import AdminBillingError, grant_credit
    from tests.test_2777_admin_billing_realdb import _seed_offering

    engine, maker = await _factory()
    try:
        async with maker() as s:
            await _seed_offering(s, tier="team", monthly_price_minor=59000)
        # (i) a grant for an organization that is gone: refused
        async with maker() as s:
            with pytest.raises(AdminBillingError) as e:
                await grant_credit(s, org_id=uuid.uuid4(), target_tier="team", months=1, reason="CS", currency="krw", idempotency_key=f"idem-{uuid.uuid4()}", actor_email="op@moonklabs.com")
        assert e.value.status_code == 404 and e.value.code == "ORG_NOT_FOUND"
        # (ii) a closing that holds the row makes the grant wait; when the organization is gone the grant is refused and no tier is written
        org_id = await _seed_org(maker)
        async with maker() as closer, maker() as grantor:
            await closer.execute(text("SELECT 1 FROM organizations WHERE id = :o FOR UPDATE"), {"o": str(org_id)})

            async def grant():
                try:
                    await grant_credit(grantor, org_id=org_id, target_tier="team", months=1, reason="CS", currency="krw", idempotency_key=f"idem-{uuid.uuid4()}", actor_email="op@moonklabs.com")
                except AdminBillingError as exc:
                    return exc.code

            task = asyncio.create_task(grant())
            await _someone_waits_for_a_row_lock(maker, task=task)
            await closer.execute(text("DELETE FROM organizations WHERE id = :o"), {"o": org_id})
            await closer.commit()
            assert await asyncio.wait_for(task, timeout=20) == "ORG_NOT_FOUND"
        assert await _scalar(maker, "SELECT count(*) FROM org_subscriptions WHERE org_id = :o", o=org_id) == 0
    finally:
        await _cleanup(maker, org_id)
        await engine.dispose()
