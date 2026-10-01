"""story #4458 — an older seal's start racing a re-seal: the seal is checked again right before the provider call.

4870 (4447) made the execution context refuse a command of a replaced seal, but the check and a re-seal are not atomic: a worker
that passed the context (and took the campaign-creation claim) could still call the provider after a person re-approved the boost
with other values — the old budget would go out. The race here has the shape real data has (Qadir ⓐ): the old seal's start passes
the context, the gate is re-sealed (new version · another budget · approved again) before the call, then the new seal's start runs.

The re-seal is written straight to the gate from another session at the exact moment (inside the first provider read of the start,
the account-currency lookup) — the same end state as the real request path (new sealed_ads_boost_version_id · approved), which
would not void the old command either (it is in progress, not pending).
"""
from __future__ import annotations

import os
import uuid

import pytest

from tests.test_3475_publishing_metrics import _client_for, _setup_org_scoped_app  # noqa: F401
from tests.test_3806_ads_boost_execution import _setup_approved_gate
from tests.test_4404_publish_worker_no_open_tx_realdb import _command, _run, _start_command, _tick
from tests.test_4142_recipe_async_video_publish_command_realdb import _configure_secrets  # noqa: F401 — autouse

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


async def test_an_old_seals_start_resealed_before_the_call_never_calls_the_provider(monkeypatch):
    import app.services.ads_sandbox_campaign as sandbox
    from sqlalchemy import update

    from app.models.gate import Gate
    from tests.test_e4fc29fa_site_post_orchestration import _session_factory

    engine, Session, org_id, _project_id, owner_id, gate_id = await _setup_approved_gate(await _session_factory(), budget_minor=100_000)
    new_budget = 40_000
    creates: list[int] = []
    real_create, real_currency = sandbox.create_boost_campaign, sandbox.get_ad_account_currency
    resealed = {"done": False}

    async def create_spy(client, **kwargs):
        creates.append(kwargs["budget_minor"])
        return await real_create(client, **kwargs)

    async def currency_then_reseal(client, **kwargs):
        # the old seal's start has passed the execution context (and holds no transaction): a person re-approves now
        if not resealed["done"]:
            resealed["done"] = True
            async with Session() as s:
                await s.execute(update(Gate).where(Gate.id == gate_id).values(
                    sealed_ads_boost_version_id=uuid.uuid4(), sealed_ads_budget_minor=new_budget, status="approved",
                ))
                await s.commit()
        return await real_currency(client, **kwargs)

    monkeypatch.setattr(sandbox, "create_boost_campaign", create_spy)
    monkeypatch.setattr(sandbox, "get_ad_account_currency", currency_then_reseal)
    try:
        old = await _start_command(Session, org_id, gate_id, owner_id)
        await _tick(Session)
        assert resealed["done"]
        stopped = await _command(Session, old.id)
        assert creates == [], f"the old seal's start reached the provider with budget(s) {creates}"
        assert (stopped.status, stopped.reason_code) == ("blocked_unapproved", "ADS_BOOST_SEAL_REPLACED"), (stopped.status, stopped.reason_code, stopped.last_error)
        run = await _run(Session, gate_id)
        assert run is None or (run.campaign_id is None and run.create_claimed_at is None and run.create_call_started_at is None)

        # the new seal's start then runs on its own values — created once, with the new budget (the gate now has two starts:
        # take the new one from the request itself)
        from app.services.ads_boost_execution import request_ads_boost_start

        async with Session() as s:
            new = await request_ads_boost_start(s, org_id=org_id, gate_id=gate_id, requester_member_id=owner_id, initiated_by="human")
            await s.commit()
        assert new.id != old.id
        await _tick(Session)
        assert creates == [new_budget]
        assert (await _command(Session, new.id)).status == "completed"
    finally:
        await engine.dispose()


async def _reseal_during_create(monkeypatch, Session, gate_id, *, new_budget: int):
    """The re-seal lands *inside* the old seal's create call (after the pre-call check): the campaign is created on the old values,
    then the gate is re-sealed before the call returns. Returns the spies (create budgets · status calls)."""
    import app.services.ads_sandbox_campaign as sandbox
    from sqlalchemy import update

    from app.models.gate import Gate

    creates: list[int] = []
    statuses: list[str] = []
    real_create, real_status = sandbox.create_boost_campaign, sandbox.set_campaign_status

    async def create_then_reseal(client, **kwargs):
        from app.services.provider_call_mark import mark_provider_call

        creates.append(kwargs["budget_minor"])
        mark_provider_call()  # what a real adapter's HTTP write does (provider_client hook); the sandbox sends no HTTP
        result = await real_create(client, **kwargs)
        if len(creates) == 1:
            async with Session() as s:
                await s.execute(update(Gate).where(Gate.id == gate_id).values(
                    sealed_ads_boost_version_id=uuid.uuid4(), sealed_ads_budget_minor=new_budget, status="approved",
                ))
                await s.commit()
        return result

    async def status_spy(client, **kwargs):
        statuses.append(kwargs["status"])
        return await real_status(client, **kwargs)

    monkeypatch.setattr(sandbox, "create_boost_campaign", create_then_reseal)
    monkeypatch.setattr(sandbox, "set_campaign_status", status_spy)
    return creates, statuses


async def _new_seal_start(Session, org_id, gate_id, owner_id):
    from app.services.ads_boost_execution import request_ads_boost_start

    async with Session() as s:
        new = await request_ads_boost_start(s, org_id=org_id, gate_id=gate_id, requester_member_id=owner_id, initiated_by="human")
        await s.commit()
    return new


async def test_a_campaign_created_on_a_replaced_seal_is_not_switched_on_with_another_budget(monkeypatch):
    """PO 08:13Z ② (다): a campaign created with a budget other than the current seal's is never switched on by the new seal's
    start — it stays off and stops for a person (needs_check, «승인한 예산과 광고 예산이 달라요»), and the result says it was made on
    the older seal. No spend outside the approval; no silent budget change."""
    from tests.test_e4fc29fa_site_post_orchestration import _session_factory

    engine, Session, org_id, _project_id, owner_id, gate_id = await _setup_approved_gate(await _session_factory(), budget_minor=100_000)
    creates, statuses = await _reseal_during_create(monkeypatch, Session, gate_id, new_budget=40_000)
    try:
        old = await _start_command(Session, org_id, gate_id, owner_id)
        await _tick(Session)
        assert creates == [100_000]  # made on the old seal, during which the re-seal landed
        assert statuses == []  # but never switched on — the ACTIVE step re-checks the seal
        stopped = await _command(Session, old.id)
        assert (stopped.status, stopped.reason_code) == ("blocked_unapproved", "ADS_BOOST_SEAL_REPLACED"), (stopped.status, stopped.reason_code)
        run = await _run(Session, gate_id)
        assert run.campaign_id and run.created_budget_minor == 100_000 and run.created_for_version_id == old.approved_version
        assert run.created_connection_id == old.destination  # the ad connection it was created under (PO 09:00Z · used by 4461)
        # PO 11:24Z — the old command's refusal came after its create call went out: the attempt ledger says the adapter was called
        from sqlalchemy import select

        from app.models.publication_attempt import PublicationAttempt

        async with Session() as s:
            last = (await s.execute(
                select(PublicationAttempt).where(PublicationAttempt.command_id == old.id).order_by(PublicationAttempt.started_at.desc()).limit(1)
            )).scalar_one()
        assert (last.result_code, last.adapter_called) == ("ADS_BOOST_SEAL_REPLACED", True)

        new = await _new_seal_start(Session, org_id, gate_id, owner_id)
        await _tick(Session)
        assert creates == [100_000] and statuses == []  # not created again · not switched on
        held = await _command(Session, new.id)
        assert (held.status, held.failure_kind, held.reason_code) == ("dead_letter", "needs_check", "ADS_BOOST_CREATED_BUDGET_DIFFERS"), (held.status, held.failure_kind, held.reason_code, held.last_error)

        # PO 10:56Z — the card states the facts: /spend carries the created budget (next to the sealed one)
        from app.main import app
        from tests.test_4447_boost_card_states_realdb import _spend

        body = await _spend(app, Session, org_id, owner_id, gate_id)
        app.dependency_overrides.clear()
        assert body["start_command"]["error_code"] == "ADS_BOOST_CREATED_BUDGET_DIFFERS"
        assert (body["created_budget_minor"], body["sealed_ads_budget_minor"]) == (100_000, 40_000)
        assert "request_draft_id" not in body  # no «request again» link: re-seals only lower the budget, so it never works
    finally:
        await engine.dispose()


async def test_the_same_budget_on_the_new_seal_switches_the_campaign_on():
    """The other side: a re-seal that kept the budget — the campaign made on the older seal is the approved spend; the new seal's
    start switches it on (no second create)."""
    import pytest as _pytest  # noqa: F401
    from tests.test_e4fc29fa_site_post_orchestration import _session_factory

    mp = _pytest.MonkeyPatch()
    engine, Session, org_id, _project_id, owner_id, gate_id = await _setup_approved_gate(await _session_factory(), budget_minor=100_000)
    creates, statuses = await _reseal_during_create(mp, Session, gate_id, new_budget=100_000)
    try:
        await _start_command(Session, org_id, gate_id, owner_id)
        await _tick(Session)
        assert creates == [100_000] and statuses == []
        new = await _new_seal_start(Session, org_id, gate_id, owner_id)
        await _tick(Session)
        assert creates == [100_000] and statuses == ["ACTIVE"]
        assert (await _command(Session, new.id)).status == "completed"
    finally:
        mp.undo()
        await engine.dispose()


async def test_resume_does_not_switch_on_a_campaign_whose_budget_the_new_seal_lowered(monkeypatch):
    """The same rule on resume: a boost ran on its seal (budget 100,000), was paused, then re-sealed with a lower budget and
    approved again. Resuming would switch the 100,000 campaign back on — spend beyond the new approval. It stays off (needs_check)."""
    import app.services.ads_sandbox_campaign as sandbox
    from sqlalchemy import update

    from app.models.gate import Gate
    from app.services.ads_boost_execution import request_ads_boost_pause, request_ads_boost_resume
    from tests.test_e4fc29fa_site_post_orchestration import _session_factory

    engine, Session, org_id, _project_id, owner_id, gate_id = await _setup_approved_gate(await _session_factory(), budget_minor=100_000)
    statuses: list[str] = []
    real_status = sandbox.set_campaign_status

    async def status_spy(client, **kwargs):
        statuses.append(kwargs["status"])
        return await real_status(client, **kwargs)

    monkeypatch.setattr(sandbox, "set_campaign_status", status_spy)
    try:
        await _start_command(Session, org_id, gate_id, owner_id)
        await _tick(Session)
        async with Session() as s:
            await request_ads_boost_pause(s, org_id=org_id, gate_id=gate_id, requester_member_id=owner_id)
            await s.commit()
        await _tick(Session)
        assert statuses == ["ACTIVE", "PAUSED"] and (await _run(Session, gate_id)).created_budget_minor == 100_000
        async with Session() as s:  # re-sealed with a lower budget and approved again
            await s.execute(update(Gate).where(Gate.id == gate_id).values(
                sealed_ads_boost_version_id=uuid.uuid4(), sealed_ads_budget_minor=40_000, status="approved",
            ))
            await s.commit()
        async with Session() as s:
            resume = await request_ads_boost_resume(s, org_id=org_id, gate_id=gate_id, requester_member_id=owner_id)
            await s.commit()
            resume_id = resume.id
        await _tick(Session)
        held = await _command(Session, resume_id)
        assert statuses == ["ACTIVE", "PAUSED"]  # not switched back on
        assert (held.status, held.failure_kind, held.reason_code) == ("dead_letter", "needs_check", "ADS_BOOST_CREATED_BUDGET_DIFFERS"), (held.status, held.failure_kind, held.reason_code, held.last_error)
    finally:
        await engine.dispose()


async def test_an_adset_from_a_partly_failed_create_keeps_its_budget_record_and_is_not_switched_on_after_a_lower_reseal(monkeypatch):
    """Qadir 4881 (PO 11:24Z): a create that failed part-way (4xx after the ad set existed) kept the partial ids and released the
    claim, but recorded no budget. A lower re-seal, then the new seal's start reused that ad set (made on the old budget), created
    only the ad and recorded the *current* (lower) budget as «created» — the check passed and the old-budget ad set was switched on.
    «Created» is now recorded once, the moment the budget-carrying ad set first exists (success or partial), with the budget of
    that call, and never overwritten."""
    import app.services.ads_sandbox_campaign as sandbox
    from sqlalchemy import update

    from app.models.gate import Gate
    from app.services.meta_ads_campaign import MetaAdsCampaignError
    from tests.test_e4fc29fa_site_post_orchestration import _session_factory

    engine, Session, org_id, _project_id, owner_id, gate_id = await _setup_approved_gate(await _session_factory(), budget_minor=100_000)
    real_create, real_status = sandbox.create_boost_campaign, sandbox.set_campaign_status
    calls: list[dict] = []
    statuses: list[str] = []

    async def create(client, **kwargs):
        calls.append({"budget": kwargs["budget_minor"], "existing": dict(kwargs.get("existing") or {})})
        result = await real_create(client, **kwargs)
        if len(calls) == 1:  # the ad set (and campaign) exist, then the ad is rejected (4xx)
            exc = MetaAdsCampaignError("META_ADS_AD_CREATE_FAILED", "sandbox: ad rejected after the ad set", outcome_known=True)
            exc.partial = {"campaign_id": result["campaign_id"], "adset_id": result["adset_id"]}
            raise exc
        return {**result, **{k: v for k, v in (kwargs.get("existing") or {}).items() if v}}

    async def status(client, **kwargs):
        statuses.append(kwargs["status"])
        return await real_status(client, **kwargs)

    monkeypatch.setattr(sandbox, "create_boost_campaign", create)
    monkeypatch.setattr(sandbox, "set_campaign_status", status)
    try:
        await _start_command(Session, org_id, gate_id, owner_id)
        await _tick(Session)
        run = await _run(Session, gate_id)
        assert run.adset_id and not run.ad_id and run.created_budget_minor == 100_000  # recorded with the partial ad set
        async with Session() as s:  # a lower re-seal, approved again
            await s.execute(update(Gate).where(Gate.id == gate_id).values(
                sealed_ads_boost_version_id=uuid.uuid4(), sealed_ads_budget_minor=40_000, status="approved",
            ))
            await s.commit()
        new = await _new_seal_start(Session, org_id, gate_id, owner_id)
        await _tick(Session)
        assert calls[-1]["existing"].get("adset_id") == run.adset_id  # the old ad set was reused
        assert statuses == []  # never switched on
        assert (await _run(Session, gate_id)).created_budget_minor == 100_000  # not overwritten with the lower budget
        held = await _command(Session, new.id)
        assert (held.status, held.failure_kind, held.reason_code) == ("dead_letter", "needs_check", "ADS_BOOST_CREATED_BUDGET_DIFFERS"), (held.status, held.reason_code, held.last_error)
    finally:
        await engine.dispose()


async def test_an_adopted_adset_records_its_budget_and_a_lower_reseal_does_not_switch_it_on(monkeypatch):
    """The adopt path (PO 11:24Z): it checked the adopted ad set's budget but recorded nothing — null = no later check. It now
    records the ad set's budget as read from the provider; a later lower re-seal's start is held like any other."""
    from sqlalchemy import update

    from app.models.gate import Gate
    from tests.test_4412_boost_adopt_existing_realdb import _adopt, _stopped_unknown

    engine, Session, org_id, owner_id, gate_id, command, creates = await _stopped_unknown("[sandbox:create-unknown]", monkeypatch)
    try:
        r = await _adopt(Session, org_id, owner_id, gate_id)
        assert r.status_code == 200, r.text
        run = await _run(Session, gate_id)
        assert run.adset_id and run.created_budget_minor is not None  # the adopted ad set's own budget
        adopted_budget = run.created_budget_minor
        async with Session() as s:
            await s.execute(update(Gate).where(Gate.id == gate_id).values(
                sealed_ads_boost_version_id=uuid.uuid4(), sealed_ads_budget_minor=adopted_budget - 1, status="approved",
            ))
            await s.commit()
        new = await _new_seal_start(Session, org_id, gate_id, owner_id)
        await _tick(Session)
        held = await _command(Session, new.id)
        assert (held.failure_kind, held.reason_code) == ("needs_check", "ADS_BOOST_CREATED_BUDGET_DIFFERS"), (held.status, held.reason_code, held.last_error)
    finally:
        await engine.dispose()
