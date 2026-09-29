"""story #4412 — «it is already in my ad account»: a boost start stopped as «outcome unknown» adopts the campaign this run's
create call made, instead of creating another. Shortcut (PO): Meta is exercised through the sandbox adapter and MockTransport
only — no live Meta round trip yet (no app credentials / ads_management review).

End to end with the sandbox markers (the PO's dev run): create-unknown → the lookup finds the campaign · ad set · ad → adopted,
no second create, the start completes. none → not found; twice → ambiguous (a list, nothing adopted). The PO's two hazards: a
campaign of the same name already recorded on another run, or created before this run's call marker, is not adopted; an ad
set of the right name under another campaign is not adopted.
"""
from __future__ import annotations

import os
import uuid
from datetime import UTC, datetime, timedelta

import pytest

from tests.test_3475_publishing_metrics import _client_for, _setup_org_scoped_app
from tests.test_3806_ads_boost_execution import _setup_approved_gate
from tests.test_4142_recipe_async_video_publish_command_realdb import _configure_secrets  # noqa: F401 — autouse
from tests.test_4404_publish_worker_no_open_tx_realdb import _command, _run, _start_command, _tick

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


def _count_creates(monkeypatch):
    import app.services.ads_sandbox_campaign as sandbox

    real = sandbox.create_boost_campaign
    calls: list[int] = []

    async def spy(client, **kwargs):
        calls.append(1)
        return await real(client, **kwargs)

    monkeypatch.setattr(sandbox, "create_boost_campaign", spy)
    return calls


async def _stopped_unknown(marker: str, monkeypatch):
    """An approved boost whose start stopped as «outcome unknown» (the sandbox create answered like a 503)."""
    from tests.test_e4fc29fa_site_post_orchestration import _session_factory

    engine, Session, org_id, _project_id, owner_id, gate_id = await _setup_approved_gate(
        await _session_factory(), objective=f"POST_ENGAGEMENT {marker}",
    )
    creates = _count_creates(monkeypatch)
    command = await _start_command(Session, org_id, gate_id, owner_id)
    await _tick(Session)
    stopped = await _command(Session, command.id)
    assert (stopped.status, stopped.reason_code) == ("dead_letter", "ADS_BOOST_CREATE_OUTCOME_UNKNOWN")
    return engine, Session, org_id, owner_id, gate_id, command, creates


async def _adopt(Session, org_id, owner_id, gate_id):
    from app.main import app

    _setup_org_scoped_app(app, Session, org_id, user_id=owner_id)
    try:
        async with _client_for(app) as client:
            return await client.post(f"/api/v2/organizations/{org_id}/ads-boosts/{gate_id}/adopt-existing")
    finally:
        app.dependency_overrides.clear()


async def test_exactly_one_is_adopted_and_the_start_completes_without_a_second_create(monkeypatch):
    engine, Session, org_id, owner_id, gate_id, command, creates = await _stopped_unknown("[sandbox:create-unknown]", monkeypatch)
    try:
        assert creates == [1]
        r = await _adopt(Session, org_id, owner_id, gate_id)
        assert r.status_code == 200, r.text
        body = r.json()
        assert body["result"] == "adopted"
        run = await _run(Session, gate_id)
        assert (run.campaign_id, run.adset_id, run.ad_id) == (body["campaign_id"], body["adset_id"], body["ad_id"])
        assert run.campaign_id.startswith("sandbox-campaign-") and run.create_call_started_at is None
        await _tick(Session)
        assert creates == [1]  # adopted, not created again
        done = await _command(Session, command.id)
        assert done.status == "completed"
        assert (await _run(Session, gate_id)).status == "running"
    finally:
        await engine.dispose()


async def test_none_found_adopts_nothing(monkeypatch):
    engine, Session, org_id, owner_id, gate_id, command, _creates = await _stopped_unknown(
        "[sandbox:create-unknown-none]", monkeypatch,
    )
    try:
        r = await _adopt(Session, org_id, owner_id, gate_id)
        assert r.json()["result"] == "not_found"
        run = await _run(Session, gate_id)
        assert run.campaign_id is None and run.create_call_started_at is not None
        assert (await _command(Session, command.id)).status == "dead_letter"
    finally:
        await engine.dispose()


async def test_two_of_that_name_adopt_nothing_and_list_them(monkeypatch):
    engine, Session, org_id, owner_id, gate_id, _command_row, _creates = await _stopped_unknown(
        "[sandbox:create-unknown-twice]", monkeypatch,
    )
    try:
        body = (await _adopt(Session, org_id, owner_id, gate_id)).json()
        assert body["result"] == "ambiguous" and body["level"] == "campaign" and len(body["candidates"]) == 2
        assert (await _run(Session, gate_id)).campaign_id is None
    finally:
        await engine.dispose()


async def test_a_campaign_already_recorded_on_another_run_is_not_adopted(monkeypatch):
    """PO hazard ① — an earlier boost of the same post has the same name."""
    from app.models.ads_boost_run import AdsBoostRun

    engine, Session, org_id, owner_id, gate_id, _command_row, _creates = await _stopped_unknown(
        "[sandbox:create-unknown]", monkeypatch,
    )
    try:
        import app.services.ads_sandbox_campaign as sandbox
        from sqlalchemy import select

        async with Session() as s:
            run = (await s.execute(select(AdsBoostRun).where(AdsBoostRun.gate_id == gate_id))).scalar_one()
            # the lookup's only candidate is already on another gate's run
            found = await sandbox.find_boost_campaigns(
                None, ad_account_id="", access_token="", object_story_id="", objective="[sandbox:create-unknown]",
            )
        import app.services.ads_boost_execution as execution

        real_ctx = execution._resolve_execution_context

        async def ctx_spy(db, command):
            ctx = await real_ctx(db, command)
            expected = (await sandbox.find_boost_campaigns(
                None, ad_account_id=ctx["ad_account_id"], access_token="", object_story_id=ctx["object_story_id"],
                objective="[sandbox:create-unknown]",
            ))[0]["id"]
            db.add(AdsBoostRun(id=uuid.uuid4(), org_id=org_id, gate_id=uuid.uuid4(), campaign_id=expected))
            await db.flush()
            return ctx

        monkeypatch.setattr(execution, "_resolve_execution_context", ctx_spy)
        assert found and run.campaign_id is None
        body = (await _adopt(Session, org_id, owner_id, gate_id)).json()
        assert body["result"] == "not_found"
    finally:
        await engine.dispose()


async def test_a_campaign_created_before_this_runs_call_is_not_adopted(monkeypatch):
    """PO hazard ② — created_time before the call marker (minus the clock skew)."""
    import app.services.ads_sandbox_campaign as sandbox

    engine, Session, org_id, owner_id, gate_id, _command_row, _creates = await _stopped_unknown(
        "[sandbox:create-unknown]", monkeypatch,
    )
    try:
        real_find = sandbox.find_boost_campaigns

        async def old_campaign(client, **kwargs):
            found = await real_find(client, **kwargs)
            long_ago = (datetime.now(UTC) - timedelta(hours=2)).strftime("%Y-%m-%dT%H:%M:%S+0000")
            return [{**c, "created_time": long_ago} for c in found]

        monkeypatch.setattr(sandbox, "find_boost_campaigns", old_campaign)
        assert (await _adopt(Session, org_id, owner_id, gate_id)).json()["result"] == "not_found"
    finally:
        await engine.dispose()


async def test_an_adset_of_that_name_under_another_campaign_is_not_adopted(monkeypatch):
    """PO — the parent chain must match, not only the name."""
    import app.services.ads_sandbox_campaign as sandbox

    engine, Session, org_id, owner_id, gate_id, _command_row, _creates = await _stopped_unknown(
        "[sandbox:create-unknown]", monkeypatch,
    )
    try:
        real_find = sandbox.find_boost_adsets

        async def adset_elsewhere(client, **kwargs):
            return [{**a, "campaign_id": "some-other-campaign"} for a in await real_find(client, **kwargs)]

        monkeypatch.setattr(sandbox, "find_boost_adsets", adset_elsewhere)
        body = (await _adopt(Session, org_id, owner_id, gate_id)).json()
        assert body["result"] == "adopted" and body["campaign_id"] and body["adset_id"] is None and body["ad_id"] is None
        run = await _run(Session, gate_id)
        assert run.adset_id is None and run.ad_id is None
    finally:
        await engine.dispose()


async def test_nothing_to_adopt_when_the_start_is_not_outcome_unknown(monkeypatch):
    from tests.test_e4fc29fa_site_post_orchestration import _session_factory

    engine, Session, org_id, _project_id, owner_id, gate_id = await _setup_approved_gate(await _session_factory())
    try:
        await _start_command(Session, org_id, gate_id, owner_id)
        await _tick(Session)  # completes normally
        r = await _adopt(Session, org_id, owner_id, gate_id)
        assert r.status_code == 409 and r.json()["error"]["code"] == "ADS_BOOST_ADOPT_NOT_APPLICABLE"
    finally:
        await engine.dispose()


async def test_an_adset_whose_budget_differs_from_the_sealed_amount_is_not_adopted_and_nothing_is_switched_on(monkeypatch):
    """PO 00:48Z — the budget lives on the ad set; adopting one changed in the ad account would spend an unapproved amount."""
    engine, Session, org_id, owner_id, gate_id, command, creates = await _stopped_unknown(
        "[sandbox:create-unknown-budget-changed]", monkeypatch,
    )
    try:
        body = (await _adopt(Session, org_id, owner_id, gate_id)).json()
        assert body["result"] == "budget_mismatch" and body["level"] == "adset"
        assert body["adset_budget_minor"] != body["sealed_budget_minor"] and body["sealed_budget_minor"] == 100_000
        run = await _run(Session, gate_id)
        assert run.campaign_id is None and run.create_call_started_at is not None  # nothing adopted
        await _tick(Session)
        assert (await _command(Session, command.id)).status == "dead_letter"  # nothing switched on
        assert (await _run(Session, gate_id)).status != "running"
    finally:
        await engine.dispose()

