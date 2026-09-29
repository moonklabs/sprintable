"""story #4409 — an ads boost stopped for a person to check is visible, and «outcome unknown» is retried only after the person
confirms the campaign does not exist at Meta.

- GET …/ads-boosts/{gate}/spend carries the start command's own state (status · failure_kind · error_code). Before, only the run
  status was there: the run stays «pending», so a dead_letter/needs_check start looked «not started» for good.
- POST …/publication-commands/{id}/retry on an ADS_BOOST_CREATE_OUTCOME_UNKNOWN start: 409 ADS_BOOST_CAMPAIGN_CHECK_REQUIRED
  without `confirmed_no_campaign` (nothing changes, no creation); with it, the run's claim and call marker are cleared and the
  retry creates the campaign once. ADS_BOOST_PROVIDER_ERROR retries as before (no confirmation).
"""
from __future__ import annotations

import os
from datetime import UTC, datetime, timedelta

import pytest

from tests.test_3475_publishing_metrics import _client_for, _setup_org_scoped_app
from tests.test_3806_ads_boost_execution import _setup_approved_gate
from tests.test_4404_publish_worker_no_open_tx_realdb import _command, _run, _spy_create, _start_command, _tick
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


async def _outcome_unknown(Session, org_id, gate_id, owner_id):
    """A start that stopped as «outcome unknown»: an expired claim with the call marker and no ids."""
    from sqlalchemy import update

    from app.models.ads_boost_run import AdsBoostRun
    from app.services.ads_boost_execution import _get_or_create_run

    async with Session() as s:
        run = await _get_or_create_run(s, org_id=org_id, gate_id=gate_id)
        await s.commit()
        long_ago = datetime.now(UTC) - timedelta(hours=3)
        await s.execute(update(AdsBoostRun).where(AdsBoostRun.id == run.id)
                        .values(create_claimed_at=long_ago, create_call_started_at=long_ago))
        await s.commit()
    command = await _start_command(Session, org_id, gate_id, owner_id)
    await _tick(Session)
    return command


async def _spend(client, org_id, gate_id) -> dict:
    r = await client.get(f"/api/v2/organizations/{org_id}/ads-boosts/{gate_id}/spend")
    assert r.status_code == 200, r.text
    return r.json()


async def test_a_needs_check_start_is_visible_on_spend_and_needs_the_confirmation_to_retry(monkeypatch):
    from app.main import app
    from tests.test_e4fc29fa_site_post_orchestration import _session_factory

    engine, Session, org_id, _project_id, owner_id, gate_id = await _setup_approved_gate(await _session_factory())
    calls = _spy_create(monkeypatch)
    try:
        command = await _outcome_unknown(Session, org_id, gate_id, owner_id)
        assert calls == []
        _setup_org_scoped_app(app, Session, org_id, user_id=owner_id)
        async with _client_for(app) as client:
            body = await _spend(client, org_id, gate_id)
            assert body["run_status"] == "pending"  # what the screen used to see alone
            from app.models.gate import Gate
            from app.services.ads_boost_execution import expected_campaign_name

            async with Session() as s:
                name = await expected_campaign_name(s, await s.get(Gate, gate_id))
            assert name and name.startswith("Boost ")
            assert body["start_command"] == {
                "id": str(command.id), "status": "dead_letter", "failure_kind": "needs_check",
                "error_code": "ADS_BOOST_CREATE_OUTCOME_UNKNOWN", "campaign_name": name,  # the one the dialog asks to look for
            }

            r = await client.post(f"/api/v2/organizations/{org_id}/publication-commands/{command.id}/retry")
            assert r.status_code == 409, r.text
            assert r.json()["error"]["code"] == "ADS_BOOST_CAMPAIGN_CHECK_REQUIRED"
            assert (await _command(Session, command.id)).status == "dead_letter"
            run = await _run(Session, gate_id)
            assert run.create_call_started_at is not None  # nothing cleared without the confirmation
            await _tick(Session)
            assert calls == []

            r = await client.post(
                f"/api/v2/organizations/{org_id}/publication-commands/{command.id}/retry",
                json={"confirmed_no_campaign": True},
            )
            assert r.status_code == 200, r.text
        await _tick(Session)
        assert calls == [1]  # created once after the person's confirmation
        assert (await _command(Session, command.id)).status == "completed"
    finally:
        app.dependency_overrides.clear()
        await engine.dispose()


async def test_a_provider_error_needs_check_retries_as_before_without_confirmation(monkeypatch):
    import app.services.ads_sandbox_campaign as sandbox
    from app.main import app
    from app.services.provider_call_mark import mark_provider_call
    from tests.test_e4fc29fa_site_post_orchestration import _session_factory

    real_status = sandbox.set_campaign_status
    failures = {"n": 0}

    async def failing_status_after_the_write(client, **kwargs):
        mark_provider_call()
        if failures["n"] == 0:
            failures["n"] += 1
            raise RuntimeError("no code — after the provider write (injected)")
        return await real_status(client, **kwargs)

    monkeypatch.setattr(sandbox, "set_campaign_status", failing_status_after_the_write)
    engine, Session, org_id, _project_id, owner_id, gate_id = await _setup_approved_gate(await _session_factory())
    try:
        command = await _start_command(Session, org_id, gate_id, owner_id)
        await _tick(Session)
        stopped = await _command(Session, command.id)
        assert (stopped.status, stopped.failure_kind, stopped.reason_code) == (
            "dead_letter", "needs_check", "ADS_BOOST_PROVIDER_ERROR",
        )
        _setup_org_scoped_app(app, Session, org_id, user_id=owner_id)
        async with _client_for(app) as client:
            assert (await _spend(client, org_id, gate_id))["start_command"]["error_code"] == "ADS_BOOST_PROVIDER_ERROR"
            r = await client.post(f"/api/v2/organizations/{org_id}/publication-commands/{command.id}/retry")
            assert r.status_code == 200, r.text
        await _tick(Session)
        assert (await _command(Session, command.id)).status == "completed"
    finally:
        app.dependency_overrides.clear()
        await engine.dispose()


async def test_spend_takes_the_newest_start_command_when_a_gate_has_two():
    """A re-approval gives one gate a second boost_start; the summary used scalar_one_or_none() and raised."""
    from app.main import app
    from tests.test_4404_publish_worker_no_open_tx_realdb import _second_start_command
    from tests.test_e4fc29fa_site_post_orchestration import _session_factory

    engine, Session, org_id, _project_id, owner_id, gate_id = await _setup_approved_gate(await _session_factory())
    try:
        first = await _start_command(Session, org_id, gate_id, owner_id)
        second_id = await _second_start_command(Session, first)
        _setup_org_scoped_app(app, Session, org_id, user_id=owner_id)
        async with _client_for(app) as client:
            assert (await _spend(client, org_id, gate_id))["start_command"]["id"] == str(second_id)
    finally:
        app.dependency_overrides.clear()
        await engine.dispose()


def _create_failing_first(monkeypatch, exc):
    import app.services.ads_sandbox_campaign as sandbox

    real = sandbox.create_boost_campaign
    calls: list[int] = []

    async def spy(client, **kwargs):
        calls.append(1)
        if len(calls) == 1:
            raise exc
        return await real(client, **kwargs)

    monkeypatch.setattr(sandbox, "create_boost_campaign", spy)
    return calls


async def _person_retries(app, Session, org_id, owner_id, command_id, **json):
    _setup_org_scoped_app(app, Session, org_id, user_id=owner_id)
    async with _client_for(app) as client:
        return await client.post(f"/api/v2/organizations/{org_id}/publication-commands/{command_id}/retry", json=json or None)


async def test_a_5xx_on_create_is_outcome_unknown_and_never_recreated_without_the_confirmation(monkeypatch):
    """Qadir 4805 — a 5xx may mean Meta created it: keep the marker, stop as «outcome unknown» at once."""
    from app.main import app
    from app.services.meta_ads_campaign import MetaAdsCampaignError
    from tests.test_e4fc29fa_site_post_orchestration import _session_factory

    engine, Session, org_id, _project_id, owner_id, gate_id = await _setup_approved_gate(await _session_factory())
    calls = _create_failing_first(monkeypatch, MetaAdsCampaignError(
        "META_ADS_CAMPAIGN_CREATE_FAILED", "Service Unavailable (injected 503)", outcome_known=False,
    ))
    try:
        command = await _start_command(Session, org_id, gate_id, owner_id)
        await _tick(Session)
        assert calls == [1]
        stopped = await _command(Session, command.id)
        assert (stopped.status, stopped.failure_kind, stopped.reason_code) == (
            "dead_letter", "needs_check", "ADS_BOOST_CREATE_OUTCOME_UNKNOWN",
        )
        assert (await _run(Session, gate_id)).create_call_started_at is not None  # marker kept
        r = await _person_retries(app, Session, org_id, owner_id, command.id)
        assert r.status_code == 409  # needs the confirmation
        await _tick(Session)
        assert calls == [1]  # no second create
        r = await _person_retries(app, Session, org_id, owner_id, command.id, confirmed_no_campaign=True)
        assert r.status_code == 200, r.text
        await _tick(Session)
        assert calls == [1, 1]
        assert (await _command(Session, command.id)).status == "completed"
    finally:
        app.dependency_overrides.clear()
        await engine.dispose()


async def test_a_definite_4xx_rejection_releases_the_claim_and_the_retry_creates_once(monkeypatch):
    from app.main import app
    from app.services.meta_ads_campaign import MetaAdsCampaignError
    from tests.test_e4fc29fa_site_post_orchestration import _session_factory

    engine, Session, org_id, _project_id, owner_id, gate_id = await _setup_approved_gate(await _session_factory())
    calls = _create_failing_first(monkeypatch, MetaAdsCampaignError(
        "META_ADS_CAMPAIGN_CREATE_FAILED", "(#100) Invalid parameter (injected 400)", outcome_known=True,
    ))
    try:
        command = await _start_command(Session, org_id, gate_id, owner_id)
        await _tick(Session)
        run = await _run(Session, gate_id)
        assert run.create_claimed_at is None and run.create_call_started_at is None  # released
        stopped = await _command(Session, command.id)
        assert stopped.reason_code == "META_ADS_CAMPAIGN_CREATE_FAILED"
        r = await _person_retries(app, Session, org_id, owner_id, command.id)
        assert r.status_code == 200, r.text  # no confirmation needed: nothing was created
        await _tick(Session)
        assert calls == [1, 1]
        assert (await _command(Session, command.id)).status == "completed"
    finally:
        app.dependency_overrides.clear()
        await engine.dispose()


def test_the_meta_adapter_marks_only_a_4xx_as_a_known_outcome():
    import httpx
    import pytest as _pytest

    from app.services.meta_ads_campaign import MetaAdsCampaignError, create_boost_campaign

    async def run(status: int, body: dict):
        async with httpx.AsyncClient(transport=httpx.MockTransport(lambda r: httpx.Response(status, json=body))) as client:
            with _pytest.raises(MetaAdsCampaignError) as exc:
                await create_boost_campaign(
                    client, ad_account_id="act_1", access_token="t", object_story_id="p_1", budget_minor=1000,
                    currency="KRW", starts_at_iso="2026-09-29T00:00:00+00:00", ends_at_iso="2026-09-30T00:00:00+00:00",
                    objective="POST_ENGAGEMENT",
                )
            return exc.value.outcome_known

    import asyncio as _asyncio

    assert _asyncio.run(run(400, {"error": {"message": "bad"}})) is True
    assert _asyncio.run(run(503, {"error": {"message": "down"}})) is False
    assert _asyncio.run(run(200, {})) is False  # 200 without an id


async def test_an_error_without_outcome_known_keeps_the_claim_and_stops_as_outcome_unknown(monkeypatch):
    """PO 23:39Z — the default is the safe side: an error raised without `outcome_known` (a new path that forgot it) is treated
    as «may have been created»."""
    from app.services.meta_ads_campaign import MetaAdsCampaignError
    from tests.test_e4fc29fa_site_post_orchestration import _session_factory

    engine, Session, org_id, _project_id, owner_id, gate_id = await _setup_approved_gate(await _session_factory())
    calls = _create_failing_first(monkeypatch, MetaAdsCampaignError("META_ADS_SOME_NEW_PATH", "no outcome_known given"))
    try:
        command = await _start_command(Session, org_id, gate_id, owner_id)
        await _tick(Session)
        run = await _run(Session, gate_id)
        assert run.create_claimed_at is not None and run.create_call_started_at is not None  # claim + marker kept
        stopped = await _command(Session, command.id)
        assert (stopped.status, stopped.reason_code) == ("dead_letter", "ADS_BOOST_CREATE_OUTCOME_UNKNOWN")
        await _tick(Session)
        assert calls == [1]
    finally:
        await engine.dispose()

