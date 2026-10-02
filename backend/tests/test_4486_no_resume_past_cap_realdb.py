"""story #4486 — a boost paused at its cap (the approved total budget) is never switched on again by [재개].

Before: a resume was refused only for an unreadable spend (`spend_blocked_at`), never for the cap (`cap_reached_at`) — at request
time (ads_boost_execution._request_toggle) and when the worker ran it. A resumed capped boost went ACTIVE, and the next capture
(the resume's first, a day later) was the earliest that could pause it again: money past the approved budget in between.
Now both refuse (ADS_BOOST_CAP_REACHED · nothing reaches the provider). More spend is a new request: a cancel, then a new cycle
(4460's reset clears the cap), whose campaign resumes as any other.
"""
from __future__ import annotations

import os

import pytest

from tests.test_3475_publishing_metrics import _client_for, _setup_org_scoped_app
from tests.test_3806_ads_boost_gate import _approve_gate
from tests.test_4404_publish_worker_no_open_tx_realdb import _command, _run, _start_command, _tick
from tests.test_4142_recipe_async_video_publish_command_realdb import _configure_secrets  # noqa: F401 — autouse
from tests.test_4460_cancel_this_boost_realdb import _cancel, _new_seal_start, _request_again, _setup  # noqa: F401

_REAL_DB_URL = os.getenv("PARITY_TEST_DATABASE_URL") or os.getenv("ALEMBIC_DATABASE_URL")

pytestmark = [
    pytest.mark.destructive_schema,
    pytest.mark.skipif(not _REAL_DB_URL, reason="real Postgres 필요"),
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


async def _capped(Session, org_id, owner_id, gate_id, calls):
    """Running → [광고비 다시 수집] (the sandbox's capture 12,345 ≥ the 10,000 budget) → the cap → the scheduler's pause lands."""
    from app.services.ads_spend_snapshots import refresh_ads_boost_spend_now

    await _start_command(Session, org_id, gate_id, owner_id)
    await _tick(Session)
    campaign = (await _run(Session, gate_id)).campaign_id
    async with Session() as s:
        await refresh_ads_boost_spend_now(s, org_id=org_id, gate_id=gate_id, requester_member_id=owner_id)
    await _tick(Session)
    run = await _run(Session, gate_id)
    assert run.cap_reached_at is not None and run.status == "paused" and calls[-1] == ("PAUSED", campaign)
    return campaign


async def _setup_small(monkeypatch):
    from tests.test_3806_ads_boost_execution import _setup_approved_gate
    from tests.test_4460_cancel_this_boost_realdb import _provider
    from tests.test_e4fc29fa_site_post_orchestration import _session_factory

    engine, Session, org_id, _project_id, owner_id, gate_id = await _setup_approved_gate(await _session_factory(), budget_minor=10_000)
    return engine, Session, org_id, owner_id, gate_id, _provider(monkeypatch)


async def test_a_capped_boost_cannot_be_resumed(monkeypatch):
    """The request is refused with a named code (409 ADS_BOOST_CAP_REACHED) and nothing is queued or switched on."""
    from sqlalchemy import select

    from app.main import app
    from app.models.publication_command import PublicationCommand
    from app.services.ads_boost_execution import OP_RESUME

    engine, Session, org_id, owner_id, gate_id, calls = await _setup_small(monkeypatch)
    try:
        await _capped(Session, org_id, owner_id, gate_id, calls)
        _setup_org_scoped_app(app, Session, org_id, user_id=owner_id)
        try:
            async with _client_for(app) as client:
                r = await client.post(f"/api/v2/organizations/{org_id}/ads-boosts/{gate_id}/resume")
        finally:
            app.dependency_overrides.clear()
        assert r.status_code == 409, r.text
        err = r.json().get("error") or r.json().get("detail")
        assert err["code"] == "ADS_BOOST_CAP_REACHED" and "홍보 취소" in err["message"]
        async with Session() as s:
            resumes = (await s.execute(select(PublicationCommand).where(
                PublicationCommand.gate_id == gate_id, PublicationCommand.operation == OP_RESUME,
            ))).scalars().all()
        assert resumes == []
        await _tick(Session)
        assert [c for c in calls if c[0] == "ACTIVE"] == [calls[0]]  # only the first start
    finally:
        await engine.dispose()


async def test_a_resume_queued_before_the_cap_is_refused_when_it_runs(monkeypatch):
    """The worker checks again: a resume queued while the boost was paused by a person, with the cap reached before it runs,
    stops with ADS_BOOST_CAP_REACHED — the provider is not asked to switch it on."""
    from sqlalchemy import update

    from app.models.ads_boost_run import AdsBoostRun
    from app.services.ads_boost_execution import request_ads_boost_pause, request_ads_boost_resume

    engine, Session, org_id, owner_id, gate_id, calls = await _setup_small(monkeypatch)
    try:
        await _start_command(Session, org_id, gate_id, owner_id)
        await _tick(Session)
        async with Session() as s:
            await request_ads_boost_pause(s, org_id=org_id, gate_id=gate_id, requester_member_id=owner_id)
        await _tick(Session)
        async with Session() as s:
            resume = await request_ads_boost_resume(s, org_id=org_id, gate_id=gate_id, requester_member_id=owner_id)
        from datetime import datetime, timezone

        async with Session() as s:  # the cap is reached after the resume was queued (the capture that found it ran first)
            await s.execute(update(AdsBoostRun).where(AdsBoostRun.gate_id == gate_id).values(cap_reached_at=datetime.now(timezone.utc)))
            await s.commit()
        actives_before = len([c for c in calls if c[0] == "ACTIVE"])
        await _tick(Session)
        done = await _command(Session, resume.id)
        assert done.status != "completed" and done.reason_code == "ADS_BOOST_CAP_REACHED"
        assert len([c for c in calls if c[0] == "ACTIVE"]) == actives_before
        assert (await _run(Session, gate_id)).status == "paused"
    finally:
        await engine.dispose()


async def test_a_new_cycle_after_a_cancel_resumes_normally(monkeypatch):
    """More spend is a new request: cancel the capped boost, request again with a new budget, start — that cycle's campaign
    pauses and resumes as any other (the reset cleared the cap)."""
    from app.services.ads_boost_execution import request_ads_boost_pause, request_ads_boost_resume

    engine, Session, org_id, owner_id, gate_id, calls = await _setup_small(monkeypatch)
    try:
        await _capped(Session, org_id, owner_id, gate_id, calls)
        await _cancel(Session, org_id, gate_id, owner_id)
        await _tick(Session)
        r = await _request_again(Session, org_id, owner_id, gate_id, budget_minor=250_000)
        assert r.status_code in (200, 201), r.text
        async with Session() as s:
            await _approve_gate(s, gate_id, owner_id)
        await _new_seal_start(Session, org_id, gate_id, owner_id)
        await _tick(Session)
        run = await _run(Session, gate_id)
        assert run.status == "running" and run.cap_reached_at is None
        async with Session() as s:
            await request_ads_boost_pause(s, org_id=org_id, gate_id=gate_id, requester_member_id=owner_id)
        await _tick(Session)
        async with Session() as s:
            await request_ads_boost_resume(s, org_id=org_id, gate_id=gate_id, requester_member_id=owner_id)
        await _tick(Session)
        assert calls[-1] == ("ACTIVE", run.campaign_id) and (await _run(Session, gate_id)).status == "running"
    finally:
        await engine.dispose()


async def test_a_capped_boost_is_not_started_again_by_a_re_request(monkeypatch):
    """PO 04:01Z — the same class: the same post requested again without a cancel → re-approved → the new seal's start reached the
    worker, which switched the existing campaign on again (4458 only refuses a campaign made on another budget) while the cap
    stayed reached: money past the approved budget. The worker refuses it before any provider call (blocked_unapproved ·
    ADS_BOOST_CAP_REACHED — the card says so); the way to spend more stays one: a cancel and a new request."""
    engine, Session, org_id, owner_id, gate_id, calls = await _setup_small(monkeypatch)
    try:
        campaign = await _capped(Session, org_id, owner_id, gate_id, calls)
        r = await _request_again(Session, org_id, owner_id, gate_id, budget_minor=10_000)
        assert r.status_code in (200, 201), r.text
        async with Session() as s:
            await _approve_gate(s, gate_id, owner_id)
        # a start that reaches the worker anyway (queued before the cap was found · any path the request check does not see —
        # a person's [시작] is refused at request, see the next test): queued here without that check
        from app.services.ads_boost_execution import request_ads_boost_start

        async with Session() as s:
            start = await request_ads_boost_start(
                s, org_id=org_id, gate_id=gate_id, requester_member_id=owner_id, initiated_by="scheduler",
            )
        await _tick(Session)
        assert ("ACTIVE", campaign) not in calls[calls.index(("PAUSED", campaign)):]
        done = await _command(Session, start.id)
        assert (done.status, done.reason_code) == ("blocked_unapproved", "ADS_BOOST_CAP_REACHED")
        run = await _run(Session, gate_id)
        assert run.status == "paused" and run.cap_reached_at is not None
    finally:
        await engine.dispose()


async def test_a_persons_start_of_a_capped_boost_is_refused_with_its_reason(monkeypatch):
    """PO 04:01Z — at request time too: after a re-request and a re-approval, a person's [시작] gets 409 ADS_BOOST_CAP_REACHED with
    Yuna's sentence (cancel, then request again), and nothing is queued."""
    from sqlalchemy import select

    from app.main import app
    from app.models.publication_command import PublicationCommand
    from app.services.ads_boost_execution import OP_BOOST_START

    engine, Session, org_id, owner_id, gate_id, calls = await _setup_small(monkeypatch)
    try:
        await _capped(Session, org_id, owner_id, gate_id, calls)
        r = await _request_again(Session, org_id, owner_id, gate_id, budget_minor=10_000)
        assert r.status_code in (200, 201), r.text
        async with Session() as s:
            await _approve_gate(s, gate_id, owner_id)
        _setup_org_scoped_app(app, Session, org_id, user_id=owner_id)
        try:
            async with _client_for(app) as client:
                r = await client.post(f"/api/v2/organizations/{org_id}/ads-boosts/{gate_id}/start")
        finally:
            app.dependency_overrides.clear()
        assert r.status_code == 409, r.text
        body = r.json()
        err = body.get("error") or body.get("detail")
        assert err["code"] == "ADS_BOOST_CAP_REACHED" and "홍보 취소" in err["message"]
        async with Session() as s:
            starts = (await s.execute(select(PublicationCommand.id).where(
                PublicationCommand.gate_id == gate_id, PublicationCommand.operation == OP_BOOST_START,
            ))).scalars().all()
        assert len(starts) == 1  # only the first cycle's start
    finally:
        await engine.dispose()
