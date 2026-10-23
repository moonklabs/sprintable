"""story #4752 follow-up (blocks the 4756 prod promotion) — where payment entry is CLOSED (`platform_settings.billing_checkout_enabled` false: prod until the payment review is through) a
subscription row (an admin plan grant is enough to make one) must not stop the deletion of an account or an organization: the person has no billing tab to «cancel first» in. The closing
ends the row with the organization, by a statement of its own (a deployment without the billing modules has no `end_org_billing`). Where payment entry is OPEN the 409 stays.

Real PG. The world is the one of the account-deletion tests."""
from __future__ import annotations

import os
import uuid
from datetime import datetime, timezone
from unittest.mock import AsyncMock, MagicMock

import pytest

from tests.test_4752_account_delete_realdb import (  # noqa: F401  (the fixtures are collected from here)
    _billing_entry, _close, _dispose_global_engine_after_test, _no_rate_limit, _org_exists, _world, anyio_backend,
)

pytestmark = [
    pytest.mark.skipif(not (os.getenv("PARITY_TEST_DATABASE_URL") or os.getenv("ALEMBIC_DATABASE_URL")), reason="통합 테스트는 실 PG(PARITY/ALEMBIC_DATABASE_URL) 필요"),
    pytest.mark.anyio,
]


async def _seed_subscription(w, org_id, *, status="active", claimed=False) -> None:
    from app.models.org_subscription import OrgSubscription

    async with w.Session() as s:
        s.add(OrgSubscription(id=uuid.uuid4(), org_id=org_id, tier="pro", status=status, checkout_claimed_at=datetime.now(timezone.utc) if claimed else None))
        await s.commit()


async def _sub_statuses(w, org_id) -> list[str]:
    return [r[0] for r in (await w.sql("SELECT status FROM org_subscriptions WHERE org_id = :o", o=org_id)).all()]


async def _preview(w, tokens) -> dict:
    r = await w.client.get("/api/v2/account/delete-preview", headers={"Authorization": f"Bearer {tokens['access_token']}"})
    assert r.status_code == 200, r.text
    return r.json()


async def test_01_payment_entry_closed_an_active_subscription_does_not_stop_the_account_deletion_and_ends_with_the_organization():
    engine, w = await _world()
    try:
        uid, email, org_id = await w.person(org=True, name="Granted Plan", spare_owner=False)
        await _seed_subscription(w, org_id)                                         # (an admin plan grant leaves a row like this)
        tokens = await w.tokens(email)
        p = await _preview(w, tokens)
        assert [o["id"] for o in p["closing"]] == [str(org_id)] and p["blocked"] == []      # the window offers no «cancel first» branch
        assert (await w.delete(tokens)).status_code == 200
        assert not await _org_exists(w, org_id) and (await w.row(uid))["is_active"] is False
        assert await _sub_statuses(w, org_id) == ["canceled"]                        # nothing left active on a closed organization
    finally:
        await _close(engine, w)


async def test_02_payment_entry_closed_an_in_flight_checkout_claim_does_not_stop_it_either():
    engine, w = await _world()
    try:
        uid, email, org_id = await w.person(org=True, name="Claimed", spare_owner=False)
        await _seed_subscription(w, org_id, status="pending", claimed=True)
        assert (await w.delete(await w.tokens(email))).status_code == 200
        assert not await _org_exists(w, org_id)
        assert await _sub_statuses(w, org_id) == ["canceled"] and (await w.sql("SELECT checkout_claimed_at FROM org_subscriptions WHERE org_id = :o", o=org_id)).scalar_one() is None
    finally:
        await _close(engine, w)


async def test_03_payment_entry_open_the_409_is_unchanged_for_the_subscription_and_the_claim():
    engine, w = await _world()
    await _billing_entry(w, True)
    try:
        uid, email, org_id = await w.person(org=True, name="Pays", spare_owner=False)
        await _seed_subscription(w, org_id)
        r = await w.delete(await w.tokens(email))
        assert r.status_code == 409 and [(o["id"], o["reason"]) for o in r.json()["error"]["orgs"]] == [(str(org_id), "active_subscription")]
        await w.sql("UPDATE org_subscriptions SET status = 'pending', checkout_claimed_at = now() WHERE org_id = :o", o=org_id)        # a claim in flight
        r = await w.delete(await w.tokens(email))
        assert r.status_code == 409 and r.json()["error"]["orgs"][0]["reason"] == "active_subscription"
        assert await _org_exists(w, org_id) and (await w.row(uid))["is_active"] is True and await _sub_statuses(w, org_id) == ["pending"]
    finally:
        await _close(engine, w)


async def test_04_the_deployment_without_the_billing_modules_ends_the_row_the_same_way(monkeypatch):
    """The production branch carries no `org_billing_end` (the closing of an organization there does not call `end_org_billing`): the same deletion still finishes and no subscription
    row is left active / past_due / pending. (`end_org_billing` is replaced by nothing, as the branch has it.)"""
    import app.repositories.organization as org_repo

    called = []

    async def _absent(*a, **kw):
        called.append(1)

    monkeypatch.setattr(org_repo, "end_org_billing", _absent, raising=False)
    engine, w = await _world()
    try:
        uid, email, org_id = await w.person(org=True, name="No Billing Modules", spare_owner=False)
        await _seed_subscription(w, org_id, status="past_due")                          # (one row per organization; the active one is test_01's)
        assert (await w.delete(await w.tokens(email))).status_code == 200
        assert not await _org_exists(w, org_id)
        assert await _sub_statuses(w, org_id) == ["canceled"]
        assert called == [1]                                                          # (the stand-in was what ran; the rows were ended by the closing's own statement)
    finally:
        await _close(engine, w)


async def test_05_the_owners_organization_delete_follows_the_same_switch():
    from app.repositories.organization import OrganizationRepository

    engine, w = await _world()
    try:
        uid, email, org_id = await w.person(org=True, name="Owner Delete", spare_owner=False)
        await _seed_subscription(w, org_id)
        name = (await w.sql("SELECT name FROM organizations WHERE id = :o", o=org_id)).scalar_one()
        async with w.Session() as s:
            impact = await OrganizationRepository(s).get_impact(org_id)
            assert impact.has_active_subscription is False                           # the screen shows no «subscription» warning where nothing can be cancelled
        await _billing_entry(w, True)
        async with w.Session() as s:
            assert (await OrganizationRepository(s).get_impact(org_id)).has_active_subscription is True
            assert await OrganizationRepository(s).delete_by_user(org_id, uid, name) == {"ok": False, "reason": "active_subscription"}
            await s.rollback()
        await _billing_entry(w, False)
        async with w.Session() as s:
            assert await OrganizationRepository(s).delete_by_user(org_id, uid, name) == {"ok": True}
            await s.commit()
        assert not await _org_exists(w, org_id) and await _sub_statuses(w, org_id) == ["canceled"]
    finally:
        await _close(engine, w)


async def test_06_a_missing_settings_row_counts_as_open_the_side_that_blocks():
    from app.repositories.organization import OrganizationRepository

    session = MagicMock()
    result = MagicMock()
    result.first.return_value = None
    session.execute = AsyncMock(return_value=result)
    assert await OrganizationRepository(session)._billing_is_live() is True
