"""story #4476 — a pause stopped on the connection is re-raised when someone presses [중지] again.

Qadir 4889 T1 · PO 14:27Z: a pause that failed on the connection (token expired · account gone) is `blocked` with failure_kind
`connection` — waiting for a person, not in flight. `_request_toggle` treated it like pending / in_progress (the double-click rule:
the same row is reused), so after reconnecting, [중지] returned the same blocked row and nothing went to the provider again — no way
left in the app to stop the money. Decided (가): that row is re-raised to pending (the retry rule · the same idempotency key · sent
through the campaign's connection now); still disconnected → blocked again (only when someone presses). A pause blocked by an
org-wide pause stays as it is (lifting the pause re-queues it).
"""
from __future__ import annotations

import os

import pytest

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


def _provider(monkeypatch) -> dict:
    """The sandbox's status call, with a switch: while `down`, a PAUSED call fails like an expired token."""
    import app.services.ads_sandbox_campaign as sandbox
    from app.services.meta_ads_campaign import MetaAdsCampaignError

    real = sandbox.set_campaign_status
    state = {"down": False, "calls": []}

    async def status(client, **kwargs):
        state["calls"].append(kwargs["status"])
        if state["down"] and kwargs["status"] == "PAUSED":
            raise MetaAdsCampaignError("CHANNEL_TOKEN_EXPIRED", "sandbox: token expired", outcome_known=True)
        return await real(client, **kwargs)

    monkeypatch.setattr(sandbox, "set_campaign_status", status)
    return state


async def _running(monkeypatch):
    from tests.test_e4fc29fa_site_post_orchestration import _session_factory

    engine, Session, org_id, _project_id, owner_id, gate_id = await _setup_approved_gate(await _session_factory())
    provider = _provider(monkeypatch)
    await _start_command(Session, org_id, gate_id, owner_id)
    await _tick(Session)
    assert (await _run(Session, gate_id)).status == "running"
    return engine, Session, org_id, owner_id, gate_id, provider


async def _press_pause(Session, org_id, gate_id, owner_id):
    from app.services.ads_boost_execution import request_ads_boost_pause

    async with Session() as s:
        command = await request_ads_boost_pause(s, org_id=org_id, gate_id=gate_id, requester_member_id=owner_id)
        await s.commit()
        return command.id


async def _pauses(Session, gate_id):
    from sqlalchemy import select

    from app.models.publication_command import PublicationCommand
    from app.services.ads_boost_execution import OP_PAUSE

    async with Session() as s:
        return (await s.execute(
            select(PublicationCommand).where(PublicationCommand.gate_id == gate_id, PublicationCommand.operation == OP_PAUSE)
        )).scalars().all()


async def _reconnect(Session, gate_id, provider):
    """What a person's reconnect does: the ad connection the failure marked is active again, and the provider takes calls."""
    from sqlalchemy import update

    from app.models.channel_connection import ChannelConnection

    run = await _run(Session, gate_id)
    async with Session() as s:
        await s.execute(update(ChannelConnection).where(ChannelConnection.id == run.created_connection_id).values(status="active"))
        await s.commit()
    provider["down"] = False


async def _blocked_on_connection(monkeypatch):
    engine, Session, org_id, owner_id, gate_id, provider = await _running(monkeypatch)
    provider["down"] = True
    pause_id = await _press_pause(Session, org_id, gate_id, owner_id)
    await _tick(Session)
    blocked = await _command(Session, pause_id)
    assert (blocked.status, blocked.failure_kind) == ("blocked", "connection"), (blocked.status, blocked.failure_kind, blocked.reason_code)
    return engine, Session, org_id, owner_id, gate_id, provider, pause_id


async def test_after_reconnecting_pressing_pause_again_sends_the_same_pause(monkeypatch):
    engine, Session, org_id, owner_id, gate_id, provider, pause_id = await _blocked_on_connection(monkeypatch)
    try:
        await _reconnect(Session, gate_id, provider)
        again = await _press_pause(Session, org_id, gate_id, owner_id)
        assert again == pause_id  # the same row — one pause per toggle
        assert (await _command(Session, pause_id)).status == "pending"
        await _tick(Session)
        assert provider["calls"][-1] == "PAUSED"
        assert (await _command(Session, pause_id)).status == "completed"
        assert (await _run(Session, gate_id)).status == "paused"
        assert len(await _pauses(Session, gate_id)) == 1
    finally:
        await engine.dispose()


async def test_still_disconnected_it_stops_again_and_only_a_press_raises_it(monkeypatch):
    """Not reconnected: the re-raised pause stops again before any call (the connection is still marked failed — the card's
    honest block, 4461) and nothing is sent again on its own."""
    engine, Session, org_id, owner_id, gate_id, provider, pause_id = await _blocked_on_connection(monkeypatch)
    try:
        calls = len(provider["calls"])
        await _press_pause(Session, org_id, gate_id, owner_id)
        await _tick(Session)
        stopped = await _command(Session, pause_id)
        assert (stopped.status, stopped.reason_code) == ("blocked_unapproved", "ADS_BOOST_CONNECTION_UNAVAILABLE"), (stopped.status, stopped.reason_code)
        assert len(provider["calls"]) == calls  # stopped before the provider
        await _tick(Session)  # no press: nothing is sent again on its own
        assert len(provider["calls"]) == calls
        assert len(await _pauses(Session, gate_id)) == 1
    finally:
        await engine.dispose()


async def test_a_double_press_after_reconnecting_keeps_one_pause(monkeypatch):
    engine, Session, org_id, owner_id, gate_id, provider, pause_id = await _blocked_on_connection(monkeypatch)
    try:
        await _reconnect(Session, gate_id, provider)
        first = await _press_pause(Session, org_id, gate_id, owner_id)
        second = await _press_pause(Session, org_id, gate_id, owner_id)
        assert first == second == pause_id
        assert [(p.id, p.status) for p in await _pauses(Session, gate_id)] == [(pause_id, "pending")]
    finally:
        await engine.dispose()


async def test_a_pause_held_by_an_org_wide_pause_is_left_as_it_is(monkeypatch):
    """The boundary: a pause blocked by an org-wide pause (failure_kind paused) is re-queued by lifting that pause — a press
    keeps the double-click rule (same row, unchanged)."""
    from sqlalchemy import update

    from app.models.publication_command import PublicationCommand

    engine, Session, org_id, owner_id, gate_id, provider, pause_id = await _blocked_on_connection(monkeypatch)
    try:
        async with Session() as s:
            await s.execute(update(PublicationCommand).where(PublicationCommand.id == pause_id).values(failure_kind="paused"))
            await s.commit()
        again = await _press_pause(Session, org_id, gate_id, owner_id)
        assert again == pause_id
        held = await _command(Session, pause_id)
        assert (held.status, held.failure_kind) == ("blocked", "paused")
    finally:
        await engine.dispose()


async def test_a_resume_stopped_on_the_connection_is_re_raised_the_same_way(monkeypatch):
    """The same dead end for a resume: after reconnecting, pressing «재개» again sends the same resume (one row)."""
    import app.services.ads_sandbox_campaign as sandbox
    from app.services.ads_boost_execution import request_ads_boost_resume
    from app.services.meta_ads_campaign import MetaAdsCampaignError

    engine, Session, org_id, owner_id, gate_id, provider = await _running(monkeypatch)
    try:
        await _press_pause(Session, org_id, gate_id, owner_id)
        await _tick(Session)
        assert (await _run(Session, gate_id)).status == "paused"
        real = sandbox.set_campaign_status
        down = {"on": True}

        async def status(client, **kwargs):
            if down["on"] and kwargs["status"] == "ACTIVE":
                raise MetaAdsCampaignError("CHANNEL_TOKEN_EXPIRED", "sandbox: token expired", outcome_known=True)
            return await real(client, **kwargs)

        monkeypatch.setattr(sandbox, "set_campaign_status", status)

        async def press_resume():
            async with Session() as s:
                command = await request_ads_boost_resume(s, org_id=org_id, gate_id=gate_id, requester_member_id=owner_id)
                await s.commit()
                return command.id

        resume_id = await press_resume()
        await _tick(Session)
        assert ((await _command(Session, resume_id)).status, (await _command(Session, resume_id)).failure_kind) == ("blocked", "connection")
        down["on"] = False
        await _reconnect(Session, gate_id, provider)
        assert await press_resume() == resume_id
        await _tick(Session)
        assert (await _command(Session, resume_id)).status == "completed"
        assert (await _run(Session, gate_id)).status == "running"
    finally:
        await engine.dispose()
