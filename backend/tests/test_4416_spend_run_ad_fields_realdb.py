"""story #4416 — GET …/ads-boosts/{gate}/spend carries the run's campaign for the «stop in Ads Manager» link and the ad channel.

When a pause has not landed yet, money may still be going out, so the card points at the campaign to stop. The read gives
`campaign_id` (the run's), `ad_account_id` (the sealed ad connection's, numeric, no `act_`), `campaign_name` (the name a start
gives it) and `ad_channel` (`conn.channel` as is). All four are null without a run; `campaign_id` is also null while the run has
no campaign yet. The screen decides the notice from `ad_channel` (ads_sandbox · meta_ads · anything else).
"""
from __future__ import annotations

import os

import pytest

from tests.test_3475_publishing_metrics import _client_for, _setup_org_scoped_app
from tests.test_3806_ads_boost_execution import _setup_approved_gate
from tests.test_3806_ads_boost_spend import _start_boost
from tests.test_4142_recipe_async_video_publish_command_realdb import _configure_secrets  # noqa: F401 — autouse

_REAL_DB_URL = os.getenv("PARITY_TEST_DATABASE_URL") or os.getenv("ALEMBIC_DATABASE_URL")

pytestmark = [
    pytest.mark.destructive_schema,
    pytest.mark.skipif(not _REAL_DB_URL, reason="real Postgres 필요"),
    pytest.mark.anyio,
]

_RUN_AD_FIELDS = ("campaign_id", "ad_account_id", "campaign_name", "ad_channel")


@pytest.fixture
def anyio_backend():
    return "asyncio"


@pytest.fixture(autouse=True)
async def _dispose_global_engine_after_test():
    yield
    from app.core.database import engine as _global_engine

    await _global_engine.dispose()


async def _spend(app, Session, org_id, owner_id, gate_id) -> dict:
    _setup_org_scoped_app(app, Session, org_id, user_id=owner_id)
    async with _client_for(app) as client:
        r = await client.get(f"/api/v2/organizations/{org_id}/ads-boosts/{gate_id}/spend")
    assert r.status_code == 200, r.text
    return r.json()


async def _set_ad_connection(Session, gate_id, **values) -> None:
    """Change the gate's sealed ad connection (channel · account id) — the start ran on ads_sandbox."""
    from sqlalchemy import update

    from app.models.channel_connection import ChannelConnection
    from app.models.gate import Gate

    async with Session() as s:
        gate = await s.get(Gate, gate_id)
        await s.execute(update(ChannelConnection).where(ChannelConnection.id == gate.sealed_ads_connection_id).values(**values))
        await s.commit()


async def _expected_name(Session, gate_id) -> str:
    from app.models.gate import Gate
    from app.services.ads_boost_execution import expected_campaign_name

    async with Session() as s:
        name = await expected_campaign_name(s, await s.get(Gate, gate_id))
    assert name and name.startswith("Boost ")
    return name


async def test_a_running_run_carries_its_campaign_account_name_and_channel():
    from app.main import app
    from tests.test_4404_publish_worker_no_open_tx_realdb import _run
    from tests.test_e4fc29fa_site_post_orchestration import _session_factory

    engine, Session, org_id, _project_id, owner_id, gate_id = await _setup_approved_gate(await _session_factory())
    try:
        await _start_boost(Session, org_id, gate_id, owner_id)
        await _set_ad_connection(Session, gate_id, account_id="1234567890")
        run = await _run(Session, gate_id)
        assert run.status == "running" and run.campaign_id

        body = await _spend(app, Session, org_id, owner_id, gate_id)
        assert body["run_status"] == "running"
        assert {k: body[k] for k in _RUN_AD_FIELDS} == {
            "campaign_id": run.campaign_id, "ad_account_id": "1234567890",
            "campaign_name": await _expected_name(Session, gate_id), "ad_channel": "ads_sandbox",
        }
    finally:
        app.dependency_overrides.clear()
        await engine.dispose()


async def test_no_run_gives_null_fields_and_a_run_without_a_campaign_gives_a_null_campaign_id():
    from app.main import app
    from app.services.ads_boost_execution import _get_or_create_run
    from tests.test_e4fc29fa_site_post_orchestration import _session_factory

    engine, Session, org_id, _project_id, owner_id, gate_id = await _setup_approved_gate(await _session_factory())
    try:
        body = await _spend(app, Session, org_id, owner_id, gate_id)
        assert body["run_status"] is None
        assert {k: body[k] for k in _RUN_AD_FIELDS} == dict.fromkeys(_RUN_AD_FIELDS)  # nothing made up before a run

        async with Session() as s:  # a partial run: the row exists, the create call has not made a campaign
            await _get_or_create_run(s, org_id=org_id, gate_id=gate_id)
            await s.commit()
        await _set_ad_connection(Session, gate_id, account_id="act_1234567890")  # stored with the prefix → numeric
        body = await _spend(app, Session, org_id, owner_id, gate_id)
        assert body["run_status"] == "pending"
        assert {k: body[k] for k in _RUN_AD_FIELDS} == {
            "campaign_id": None, "ad_account_id": "1234567890",
            "campaign_name": await _expected_name(Session, gate_id), "ad_channel": "ads_sandbox",
        }
    finally:
        app.dependency_overrides.clear()
        await engine.dispose()


@pytest.mark.parametrize("channel", ["ads_sandbox", "meta_ads", "tiktok_ads"])
async def test_ad_channel_is_the_connection_channel_as_is(channel):
    """ads_sandbox (refresh notice only) · meta_ads (money line · campaign · link) · an unknown value (money line only): the
    read passes the channel through untouched; the screen maps it."""
    from app.main import app
    from tests.test_e4fc29fa_site_post_orchestration import _session_factory

    engine, Session, org_id, _project_id, owner_id, gate_id = await _setup_approved_gate(await _session_factory())
    try:
        await _start_boost(Session, org_id, gate_id, owner_id)
        await _set_ad_connection(Session, gate_id, channel=channel)
        body = await _spend(app, Session, org_id, owner_id, gate_id)
        assert body["ad_channel"] == channel
        assert body["campaign_id"]  # the link target stays whatever the channel
    finally:
        app.dependency_overrides.clear()
        await engine.dispose()
