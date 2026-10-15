"""story #4461 — pause · resume · spend reads go to the ad connection the campaign was created under.

Qadir 08:57Z: the execution context always built the account and token from the gate's *current* seal
(`gate.sealed_ads_connection_id`), and a re-seal (`request_ads_boost`) can move the boost to another ad connection. A pause then
sent the old campaign id with the new account's token — the provider refused it (no such campaign there) and the real campaign
kept spending. The campaign's connection is recorded at create (`ads_boost_runs.created_connection_id`, 0425 · 4458); operations
on that campaign use it. Runs made before the record (null) keep the sealed connection.
"""
from __future__ import annotations

import os
import uuid

import pytest

from tests.test_3475_publishing_metrics import _client_for, _setup_org_scoped_app
from tests.test_3806_ads_boost_execution import _boost_body, _setup_approved_gate
from tests.test_3806_ads_boost_gate import _approve_gate
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


async def _second_ad_connection(Session, org_id, *, token: str) -> uuid.UUID:
    from app.models.channel_connection import ChannelConnection
    from app.services.channel_credential_crypto import encrypt_channel_credential

    async with Session() as s:
        conn = ChannelConnection(
            id=uuid.uuid4(), org_id=org_id, channel="ads_sandbox", account_id=f"acct-{uuid.uuid4().hex[:8]}",
            status="active", credential_kind="oauth", refresh_mode="reissue_from_access_token",
            encrypted_access_token=encrypt_channel_credential(token),
        )
        s.add(conn)
        await s.commit()
        return conn.id


async def _reseal_to(Session, org_id, owner_id, gate_id, ad_connection_id):
    from sqlalchemy import select

    from app.main import app
    from app.models.gate import Gate

    async with Session() as s:
        publication_id = uuid.UUID((await s.execute(select(Gate.scope_key).where(Gate.id == gate_id))).scalar_one())
    _setup_org_scoped_app(app, Session, org_id, user_id=owner_id)
    try:
        async with _client_for(app) as client:
            r = await client.post(f"/api/v2/organizations/{org_id}/publications/{publication_id}/boosts", json=_boost_body(ad_connection_id=ad_connection_id))
        assert r.status_code in (200, 201), r.text
    finally:
        app.dependency_overrides.clear()
    async with Session() as s:
        await _approve_gate(s, gate_id, owner_id)


def _status_tokens(monkeypatch) -> list[tuple[str, str]]:
    import app.services.ads_sandbox_campaign as sandbox

    real = sandbox.set_campaign_status
    calls: list[tuple[str, str]] = []

    async def spy(client, **kwargs):
        calls.append((kwargs["status"], kwargs["access_token"]))
        return await real(client, **kwargs)

    monkeypatch.setattr(sandbox, "set_campaign_status", spy)
    return calls


async def test_a_pause_after_a_reseal_to_another_ad_account_goes_to_the_campaigns_own_account(monkeypatch):
    from app.services.ads_boost_execution import request_ads_boost_pause
    from tests.test_e4fc29fa_site_post_orchestration import _session_factory

    engine, Session, org_id, _project_id, owner_id, gate_id = await _setup_approved_gate(await _session_factory())
    calls = _status_tokens(monkeypatch)
    try:
        await _start_command(Session, org_id, gate_id, owner_id)
        await _tick(Session)
        run = await _run(Session, gate_id)
        assert run.status == "running" and calls == [("ACTIVE", "plain-token")]
        campaign_conn = run.created_connection_id
        other = await _second_ad_connection(Session, org_id, token="token-B")
        await _reseal_to(Session, org_id, owner_id, gate_id, other)  # the boost now points at ad account B
        async with Session() as s:
            pause = await request_ads_boost_pause(s, org_id=org_id, gate_id=gate_id, requester_member_id=owner_id)
            await s.commit()
            pause_id = pause.id
        await _tick(Session)
        assert calls[1:] == [("PAUSED", "plain-token")], f"the pause went with {calls[1:]} — not the campaign's account ({campaign_conn})"
        assert (await _command(Session, pause_id)).status == "completed"
    finally:
        await engine.dispose()


async def test_a_spend_refresh_after_a_reseal_reads_through_the_campaigns_own_account(monkeypatch):
    """The spend of the campaign lives in the account it was made in: after a re-seal to account B, a «다시 수집» still reads A."""
    import app.services.ads_sandbox_campaign as sandbox
    from app.main import app
    from tests.test_e4fc29fa_site_post_orchestration import _session_factory

    engine, Session, org_id, _project_id, owner_id, gate_id = await _setup_approved_gate(await _session_factory())
    tokens: list[str] = []
    real_spend = sandbox.get_campaign_spend_minor

    async def spend_spy(client, **kwargs):
        tokens.append(kwargs["access_token"])
        return await real_spend(client, **kwargs)

    monkeypatch.setattr(sandbox, "get_campaign_spend_minor", spend_spy)
    try:
        await _start_command(Session, org_id, gate_id, owner_id)
        await _tick(Session)
        other = await _second_ad_connection(Session, org_id, token="token-B")
        await _reseal_to(Session, org_id, owner_id, gate_id, other)
        _setup_org_scoped_app(app, Session, org_id, user_id=owner_id)
        try:
            async with _client_for(app) as client:
                r = await client.post(f"/api/v2/organizations/{org_id}/ads-boosts/{gate_id}/spend/refresh")
            assert r.status_code == 201, r.text
        finally:
            app.dependency_overrides.clear()
        assert tokens and set(tokens) == {"plain-token"}, tokens
    finally:
        await engine.dispose()


async def test_a_run_made_before_the_record_keeps_the_sealed_connection(monkeypatch):
    """The boundary (PO 09:00Z): a run whose created_connection_id is empty (made before 0425) uses the sealed connection, as it
    always did — after a re-seal to B, its pause goes with B's token."""
    from sqlalchemy import update

    from app.models.ads_boost_run import AdsBoostRun
    from app.services.ads_boost_execution import request_ads_boost_pause
    from tests.test_e4fc29fa_site_post_orchestration import _session_factory

    engine, Session, org_id, _project_id, owner_id, gate_id = await _setup_approved_gate(await _session_factory())
    calls = _status_tokens(monkeypatch)
    try:
        await _start_command(Session, org_id, gate_id, owner_id)
        await _tick(Session)
        async with Session() as s:  # as if made before 0425
            await s.execute(update(AdsBoostRun).where(AdsBoostRun.gate_id == gate_id).values(created_connection_id=None))
            await s.commit()
        other = await _second_ad_connection(Session, org_id, token="token-B")
        await _reseal_to(Session, org_id, owner_id, gate_id, other)
        async with Session() as s:
            await request_ads_boost_pause(s, org_id=org_id, gate_id=gate_id, requester_member_id=owner_id)
            await s.commit()
        await _tick(Session)
        assert calls[1:] == [("PAUSED", "token-B")]
    finally:
        await engine.dispose()


async def test_a_pause_that_cannot_reach_the_campaigns_account_is_told_honestly(monkeypatch):
    """PO 09:00Z (AC2) — the campaign's own connection is gone (disconnected · its token dead): the pause cannot reach the campaign.
    It must not look like a pause: the command stops on the connection, the run stays running (money may still go out), and /spend
    tells the card (pause_command) so it can say «원래 광고 연결이 끊겨 멈추지 못했어요 — 광고 관리자에서 직접 멈춰 주세요»."""
    from sqlalchemy import update

    from app.main import app
    from app.models.channel_connection import ChannelConnection
    from app.services.ads_boost_execution import request_ads_boost_pause
    from tests.test_4447_boost_card_states_realdb import _spend
    from tests.test_e4fc29fa_site_post_orchestration import _session_factory

    engine, Session, org_id, _project_id, owner_id, gate_id = await _setup_approved_gate(await _session_factory())
    calls = _status_tokens(monkeypatch)
    try:
        await _start_command(Session, org_id, gate_id, owner_id)
        await _tick(Session)
        run = await _run(Session, gate_id)
        async with Session() as s:  # the account the campaign lives in is disconnected
            await s.execute(update(ChannelConnection).where(ChannelConnection.id == run.created_connection_id).values(status="disconnected"))
            await s.commit()
        async with Session() as s:
            pause = await request_ads_boost_pause(s, org_id=org_id, gate_id=gate_id, requester_member_id=owner_id)
            await s.commit()
            pause_id = pause.id
        await _tick(Session)
        stopped = await _command(Session, pause_id)
        assert (stopped.status, stopped.reason_code) == ("blocked_unapproved", "ADS_BOOST_CONNECTION_UNAVAILABLE"), (stopped.status, stopped.reason_code)
        assert calls[1:] == []  # nothing reached the provider
        assert (await _run(Session, gate_id)).status == "running"  # not drawn as paused
        body = await _spend(app, Session, org_id, owner_id, gate_id)
        app.dependency_overrides.clear()
        assert body["run_status"] == "running"
        assert body["pause_command"] == {"status": "blocked_unapproved", "failure_kind": None, "error_code": "ADS_BOOST_CONNECTION_UNAVAILABLE"}
    finally:
        await engine.dispose()
