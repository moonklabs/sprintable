"""story #4489 (Kadir · PO 03:48Z · design 04:11Z) — an attempt that ended without a proof (unresolved: failed/declined · not
proven · the recheck window closed) may still have been charged, so:
- a new payment for that org never starts (checkout · change-tier → `PaymentUnresolved` → 409 `PAYMENT_UNRESOLVED`); «checking»
  does not block;
- an operator resolves it: ① ask Toss again (DONE → late success · definite «no payment» → proven by the provider · no answer →
  stays unresolved with the lookup time) ② mark it by hand with why and on what evidence;
- ① and ② act only on unresolved (409 otherwise) and, at the same time, only one of them acts.
"""
from __future__ import annotations

import asyncio
import uuid
from datetime import datetime, timedelta, timezone

import pytest
from sqlalchemy import text
from sqlalchemy.exc import IntegrityError

from tests.test_4335_payment_attempts_realdb import (  # noqa: F401 — fixtures
    Session,
    _crypto_key,
    _ended_not_found_checkout,
    _new_org,
    _no_real_receipt_mail,
    _set,
    alerts,
    anyio_backend,
    pytestmark,
    toss,
)
from tests.test_2880_tier_change_upgrade_proration_realdb import (
    _seed_active_billing_key,
    _seed_active_paid_subscription,
    _seed_prior_confirmed_order,
)


async def _unresolved(Session, toss):
    """A checkout that charged at Toss (the fake keeps it DONE) but ended failed, its recheck window closed without a proof."""
    from app.services import billing_payment_attempt as svc

    org_id, attempt_id = await _ended_not_found_checkout(Session, toss)
    async with Session() as s:
        await _set(s, attempt_id, finished_at=datetime.now(timezone.utc) - svc.RECHECK_WINDOW - timedelta(minutes=1), next_check_at=None)
        assert svc.no_charge_state(await svc.get_attempt(s, attempt_id)) == "unresolved"
    return org_id, attempt_id


async def _insert_ended(s, org_id, *, next_check_at=None, proven=False):
    """A bare ended attempt row for an org (the refusal only reads the row)."""
    from app.models.billing_payment_attempt import BillingPaymentAttempt

    now = datetime.now(timezone.utc)
    aid = uuid.uuid4()
    s.add(BillingPaymentAttempt(
        id=aid, org_id=org_id, kind="checkout", tier="team", billing_cycle="monthly", status="failed", stage="charge_started",
        order_id=f"checkout-{aid.hex}", charge_started_at=now - timedelta(days=2), finished_at=now - timedelta(days=2),
        next_check_at=next_check_at, no_charge_proven_at=now if proven else None, no_charge_proof="provider" if proven else None,
    ))
    await s.commit()
    return aid


# ── ① ask the provider again ────────────────────────────────────────────────────────────────────────────────────────────

@pytest.mark.anyio
async def test_recheck_done_takes_the_late_success_path(Session, toss, alerts):
    from app.services import billing_payment_attempt as svc

    org_id, attempt_id = await _unresolved(Session, toss)
    async with Session() as s:
        assert await svc.operator_recheck(s, org_id=org_id, attempt_id=attempt_id) == ("charged", "DONE")
        row = await svc.get_attempt(s, attempt_id)
        assert row.status == "succeeded" and row.provider_rechecked_at is not None
        assert svc.no_charge_state(row) is None
    assert ("late_charge", attempt_id) in alerts


@pytest.mark.anyio
async def test_recheck_done_whose_late_path_dies_is_left_checking_for_the_sweep(Session, toss, alerts, monkeypatch):
    """A DONE hands the attempt to the late-success path; if that path dies midway the attempt is «checking» (the sweep's recheck
    picks it up again), never left unresolved — and no hand mark can land on money Toss says was taken."""
    from app.services import billing_payment_attempt as svc

    org_id, attempt_id = await _unresolved(Session, toss)

    async def dies(*_a, **_k):
        raise RuntimeError("instance gone")

    monkeypatch.setattr(svc, "_late_confirmed", dies)
    async with Session() as s:
        with pytest.raises(RuntimeError):
            await svc.operator_recheck(s, org_id=org_id, attempt_id=attempt_id)
    async with Session() as s:
        row = await svc.get_attempt(s, attempt_id)
        assert svc.no_charge_state(row) == "checking"
        with pytest.raises(svc.AttemptNotUnresolved):
            await svc.operator_mark_no_charge(s, org_id=org_id, attempt_id=attempt_id, actor_email="op@x.test", reason="r", evidence="e")


@pytest.mark.anyio
async def test_recheck_definite_no_payment_is_proven_by_the_provider(Session, toss):
    from app.services import billing_payment_attempt as svc

    org_id, attempt_id = await _unresolved(Session, toss)
    toss.charged.clear()  # Toss now answers NOT_FOUND
    async with Session() as s:
        assert await svc.operator_recheck(s, org_id=org_id, attempt_id=attempt_id) == ("no_charge", "NOT_FOUND")
        row = await svc.get_attempt(s, attempt_id)
        assert (svc.no_charge_state(row), row.no_charge_proof, row.status) == ("confirmed", "provider", "failed")


@pytest.mark.anyio
async def test_recheck_without_an_answer_stays_unresolved_and_records_when(Session, toss):
    from app.services import billing_payment_attempt as svc

    org_id, attempt_id = await _unresolved(Session, toss)
    toss.lookup_status = "error"
    try:
        async with Session() as s:
            assert (await svc.operator_recheck(s, org_id=org_id, attempt_id=attempt_id))[0] == "unknown"
            row = await svc.get_attempt(s, attempt_id)
            assert (svc.no_charge_state(row), row.no_charge_proof) == ("unresolved", None)
            assert row.provider_rechecked_at is not None
    finally:
        toss.lookup_status = None


# ── ② the hand mark ────────────────────────────────────────────────────────────────────────────────────────────────────

@pytest.mark.anyio
async def test_mark_records_who_why_and_evidence(Session, toss):
    from app.services import billing_payment_attempt as svc

    org_id, attempt_id = await _unresolved(Session, toss)
    async with Session() as s:
        await svc.operator_mark_no_charge(
            s, org_id=org_id, attempt_id=attempt_id, actor_email="op@x.test", reason=" Toss console: no payment ", evidence="screenshot #12",
        )
        row = await svc.get_attempt(s, attempt_id)
        assert (svc.no_charge_state(row), row.no_charge_proof, row.no_charge_marked_by) == ("confirmed", "operator", "op@x.test")
        assert (row.no_charge_mark_reason, row.no_charge_mark_evidence) == ("Toss console: no payment", "screenshot #12")


@pytest.mark.anyio
@pytest.mark.parametrize("reason, evidence", [("", "x"), ("x", "   ")])
async def test_mark_without_reason_or_evidence_is_refused(Session, toss, reason, evidence):
    from app.services import billing_payment_attempt as svc

    org_id, attempt_id = await _unresolved(Session, toss)
    async with Session() as s:
        with pytest.raises(ValueError):
            await svc.operator_mark_no_charge(s, org_id=org_id, attempt_id=attempt_id, actor_email="op@x.test", reason=reason, evidence=evidence)
        assert svc.no_charge_state(await svc.get_attempt(s, attempt_id)) == "unresolved"


@pytest.mark.anyio
async def test_the_database_refuses_an_operator_proof_without_evidence(Session, toss):
    """0428's constraint holds even if the service is bypassed."""
    org_id, attempt_id = await _unresolved(Session, toss)
    async with Session() as s:
        with pytest.raises(IntegrityError):
            await s.execute(
                text("UPDATE billing_payment_attempts SET no_charge_proven_at = now(), no_charge_proof = 'operator', "
                     "no_charge_marked_by = 'op@x.test', no_charge_mark_reason = 'r', no_charge_mark_evidence = ' ' WHERE id = :id"),
                {"id": attempt_id},
            )
        await s.rollback()
        # NULL reason: `length(NULL) > 0` is NULL, and a CHECK that is NULL passes — the constraint says IS NOT NULL itself
        with pytest.raises(IntegrityError):
            await s.execute(
                text("UPDATE billing_payment_attempts SET no_charge_proven_at = now(), no_charge_proof = 'operator', "
                     "no_charge_marked_by = 'op@x.test', no_charge_mark_evidence = 'e' WHERE id = :id"),
                {"id": attempt_id},
            )
        await s.rollback()
        # proven with no proof source: `proof IN (...)` with a NULL proof is NULL — same trap
        with pytest.raises(IntegrityError):
            await s.execute(text("UPDATE billing_payment_attempts SET no_charge_proven_at = now() WHERE id = :id"), {"id": attempt_id})
        await s.rollback()


@pytest.mark.anyio
async def test_mark_is_refused_when_a_confirmed_charge_is_on_record(Session, toss):
    from app.services import billing_payment_attempt as svc

    org_id, attempt_id = await _unresolved(Session, toss)
    async with Session() as s:
        order_id = (await svc.get_attempt(s, attempt_id)).order_id
        await s.execute(text("UPDATE billing_orders SET status = 'confirmed' WHERE order_id = :o"), {"o": order_id})
        await s.commit()
        with pytest.raises(svc.AttemptNotUnresolved):
            await svc.operator_mark_no_charge(s, org_id=org_id, attempt_id=attempt_id, actor_email="op@x.test", reason="r", evidence="e")
        assert svc.no_charge_state(await svc.get_attempt(s, attempt_id)) == "unresolved"


# ── ①② only on unresolved · only one at a time ───────────────────────────────────────────────────────────────────────

@pytest.mark.anyio
@pytest.mark.parametrize("state", ["checking", "confirmed"])
@pytest.mark.parametrize("action", ["recheck", "mark"])
async def test_resolve_actions_refuse_an_attempt_that_is_not_unresolved(Session, toss, state, action):
    from app.services import billing_payment_attempt as svc

    async with Session() as s:
        org_id = await _new_org(s)
        aid = await _insert_ended(
            s, org_id, next_check_at=datetime.now(timezone.utc) + timedelta(hours=1) if state == "checking" else None,
            proven=state == "confirmed",
        )
        with pytest.raises(svc.AttemptNotUnresolved):
            if action == "recheck":
                await svc.operator_recheck(s, org_id=org_id, attempt_id=aid)
            else:
                await svc.operator_mark_no_charge(s, org_id=org_id, attempt_id=aid, actor_email="op@x.test", reason="r", evidence="e")
        assert svc.no_charge_state(await svc.get_attempt(s, aid)) == state


@pytest.mark.anyio
async def test_another_orgs_attempt_is_not_found(Session, toss):
    from app.services import billing_payment_attempt as svc

    _, attempt_id = await _unresolved(Session, toss)
    async with Session() as s:
        other = await _new_org(s)
        with pytest.raises(svc.AttemptNotFound):
            await svc.operator_recheck(s, org_id=other, attempt_id=attempt_id)


@pytest.mark.anyio
async def test_recheck_and_mark_at_the_same_time_act_once(Session, toss, monkeypatch):
    """① holds the row through its Toss lookup: ② at that moment gets `AttemptBusy`; afterwards the attempt is proven (no longer
    unresolved), so ② again gets `AttemptNotUnresolved`. One proof, by the provider."""
    from app.services import billing_payment_attempt as svc

    org_id, attempt_id = await _unresolved(Session, toss)
    looking = asyncio.Event()
    release = asyncio.Event()

    async def slow_lookup(_attempt):
        looking.set()
        await release.wait()
        return None, True  # NOT_FOUND

    monkeypatch.setattr(svc, "_lookup", slow_lookup)

    async def recheck():
        async with Session() as s:
            return await svc.operator_recheck(s, org_id=org_id, attempt_id=attempt_id)

    async def mark():
        async with Session() as s:
            return await svc.operator_mark_no_charge(s, org_id=org_id, attempt_id=attempt_id, actor_email="op@x.test", reason="r", evidence="e")

    first = asyncio.create_task(recheck())
    await asyncio.wait_for(looking.wait(), 10)
    with pytest.raises(svc.AttemptBusy):
        await mark()
    release.set()
    assert await first == ("no_charge", "NOT_FOUND")
    with pytest.raises(svc.AttemptNotUnresolved):
        await mark()
    async with Session() as s:
        row = await svc.get_attempt(s, attempt_id)
        assert (row.no_charge_proof, row.no_charge_marked_by) == ("provider", None)


@pytest.mark.anyio
async def test_two_marks_at_the_same_time_act_once(Session, toss):
    from app.services import billing_payment_attempt as svc

    org_id, attempt_id = await _unresolved(Session, toss)

    async def mark(who):
        async with Session() as s:
            try:
                await svc.operator_mark_no_charge(s, org_id=org_id, attempt_id=attempt_id, actor_email=who, reason="r", evidence="e")
                return who
            except (svc.AttemptBusy, svc.AttemptNotUnresolved):
                return None

    won = [w for w in await asyncio.gather(mark("a@x.test"), mark("b@x.test")) if w]
    assert len(won) == 1
    async with Session() as s:
        assert (await svc.get_attempt(s, attempt_id)).no_charge_marked_by == won[0]


# ── the refusal ────────────────────────────────────────────────────────────────────────────────────────────────────────

@pytest.mark.anyio
async def test_checkout_is_refused_while_an_attempt_is_unresolved_and_checking_does_not_block(Session, toss):
    from app.services import billing_payment_attempt as svc

    async with Session() as s:
        org_id = await _new_org(s)
        blocker = await _insert_ended(s, org_id)
        with pytest.raises(svc.PaymentUnresolved):
            await svc.start_checkout_attempt(s, attempt_id=uuid.uuid4(), org_id=org_id, requested_by=None, tier="team", billing_cycle="monthly")
        assert (await s.execute(text("SELECT count(*) FROM billing_payment_attempts WHERE org_id = :o"), {"o": org_id})).scalar() == 1

        await _set(s, blocker, next_check_at=datetime.now(timezone.utc) + timedelta(hours=1))  # checking
        _, token = await svc.start_checkout_attempt(s, attempt_id=uuid.uuid4(), org_id=org_id, requested_by=None, tier="team", billing_cycle="monthly")
        assert token is not None


@pytest.mark.anyio
async def test_change_tier_is_refused_while_an_attempt_is_unresolved_and_checking_does_not_block(Session, toss):
    from app.services import billing_payment_attempt as svc

    async with Session() as s:
        org_id = await _new_org(s, seats=1)
        await _seed_active_paid_subscription(s, org_id, tier="starter")
        await _seed_active_billing_key(s, org_id)
        await _seed_prior_confirmed_order(s, org_id, amount_minor=32_890)
        blocker = await _insert_ended(s, org_id)
        with pytest.raises(svc.PaymentUnresolved):
            await svc.start_change_tier_attempt(s, attempt_id=uuid.uuid4(), org_id=org_id, requested_by=None, new_tier="team")

        await _set(s, blocker, next_check_at=datetime.now(timezone.utc) + timedelta(hours=1))
        _, token = await svc.start_change_tier_attempt(s, attempt_id=uuid.uuid4(), org_id=org_id, requested_by=None, new_tier="team")
        assert token is not None


@pytest.mark.anyio
async def test_once_resolved_a_new_payment_starts(Session, toss):
    from app.services import billing_payment_attempt as svc

    org_id, attempt_id = await _unresolved(Session, toss)
    async with Session() as s:
        with pytest.raises(svc.PaymentUnresolved):
            await svc.start_checkout_attempt(s, attempt_id=uuid.uuid4(), org_id=org_id, requested_by=None, tier="team", billing_cycle="monthly")
        await svc.operator_mark_no_charge(s, org_id=org_id, attempt_id=attempt_id, actor_email="op@x.test", reason="r", evidence="e")
        _, token = await svc.start_checkout_attempt(s, attempt_id=uuid.uuid4(), org_id=org_id, requested_by=None, tier="team", billing_cycle="monthly")
        assert token is not None


@pytest.mark.anyio
async def test_list_shows_every_unresolved_attempt_and_nothing_else(Session, toss):
    from app.services import billing_payment_attempt as svc

    async with Session() as s:
        org_id = await _new_org(s)
        u = await _insert_ended(s, org_id)
        c = await _insert_ended(s, org_id, next_check_at=datetime.now(timezone.utc) + timedelta(hours=1))
        p = await _insert_ended(s, org_id, proven=True)
        ids = {a.id for a in await svc.list_unresolved(s, limit=100_000)}
        assert u in ids and c not in ids and p not in ids


@pytest.mark.anyio
@pytest.mark.parametrize("case", ["unresolved", "checking", "unresolved_in_prod"])
async def test_the_status_flag_and_the_start_refusal_always_agree(Session, toss, monkeypatch, case):
    """PO 04:32Z — one source: in the same org state, `payment_unresolved` true ↔ the start is refused, false ↔ it starts."""
    from app.core.config import settings
    from app.services import billing_payment_attempt as svc
    from ee.routers.billing import _payment_unresolved

    if case == "unresolved_in_prod":
        monkeypatch.setattr(settings, "deploy_env", "prod")
    async with Session() as s:
        org_id = await _new_org(s)
        await _insert_ended(s, org_id, next_check_at=datetime.now(timezone.utc) + timedelta(hours=1) if case == "checking" else None)
        flag = await _payment_unresolved(s, org_id)
        try:
            await svc.start_checkout_attempt(s, attempt_id=uuid.uuid4(), org_id=org_id, requested_by=None, tier="team", billing_cycle="monthly")
            refused = False
        except svc.PaymentUnresolved:
            refused = True
    assert flag == refused
    assert flag == (case == "unresolved")
