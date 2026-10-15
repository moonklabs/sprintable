"""story #4466 — a running boost keeps a way to stop spending when its gate leaves «approved».

PO 11:49Z · 11:51Z: once a running boost's gate left approved (the same post's boost requested again → pending re-review · the
approval undone · then void / hold / reject), every operation was refused — the person's pause (409 GATE_NOT_APPROVED), a pause
already queued (voided by the re-request), the cap's automatic pause (GateNotApproved swallowed, and no resolver to attribute it
to) — while the campaign kept spending on the older seal's budget. Decided (가)(나)(다):
(가) a money-stopping operation (pause) goes through whatever the gate's status — request and worker alike;
(나) a reopen does not void a queued pause;
(다) one place: an ads_boost gate leaving «approved» while its campaign is live gets the boost paused (scheduler · «다시 결재 중»).
Resume and start still need an approved gate.
"""
from __future__ import annotations

import os
import uuid
from datetime import datetime, timezone

import pytest

from tests.test_3475_publishing_metrics import _client_for, _setup_org_scoped_app
from tests.test_3806_ads_boost_execution import _setup_approved_gate
from tests.test_3806_ads_boost_gate import _boost_body
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


def _status_calls(monkeypatch) -> list[str]:
    import app.services.ads_sandbox_campaign as sandbox

    real = sandbox.set_campaign_status
    calls: list[str] = []

    async def spy(client, **kwargs):
        calls.append(kwargs["status"])
        return await real(client, **kwargs)

    monkeypatch.setattr(sandbox, "set_campaign_status", spy)
    return calls


async def _running(monkeypatch):
    from tests.test_e4fc29fa_site_post_orchestration import _session_factory

    engine, Session, org_id, _project_id, owner_id, gate_id = await _setup_approved_gate(await _session_factory())
    calls = _status_calls(monkeypatch)
    await _start_command(Session, org_id, gate_id, owner_id)
    await _tick(Session)
    assert (await _run(Session, gate_id)).status == "running" and calls == ["ACTIVE"]
    return engine, Session, org_id, owner_id, gate_id, calls


async def _reopen(Session, org_id, owner_id, gate_id, *, budget_minor=60_000):
    """The same post's boost requested again (a lower budget): the gate goes back to pending re-review — not approved again."""
    from sqlalchemy import select

    from app.main import app
    from app.models.gate import Gate

    async with Session() as s:
        gate = (await s.execute(select(Gate).where(Gate.id == gate_id))).scalar_one()
        publication_id, conn = uuid.UUID(gate.scope_key), gate.sealed_ads_connection_id
    _setup_org_scoped_app(app, Session, org_id, user_id=owner_id)
    try:
        async with _client_for(app) as client:
            r = await client.post(
                f"/api/v2/organizations/{org_id}/publications/{publication_id}/boosts",
                json=_boost_body(ad_connection_id=conn, budget_minor=budget_minor),
            )
        assert r.status_code in (200, 201), r.text
    finally:
        app.dependency_overrides.clear()


async def _undo(Session, org_id, owner_id, gate_id):
    from app.services.gate_service import undo_gate_resolution

    async with Session() as s:
        await undo_gate_resolution(s, org_id, gate_id, owner_id)
        await s.commit()


async def _gate_status(Session, gate_id) -> str:
    from sqlalchemy import select

    from app.models.gate import Gate

    async with Session() as s:
        return (await s.execute(select(Gate.status).where(Gate.id == gate_id))).scalar_one()


async def _pauses(Session, gate_id):
    from sqlalchemy import select

    from app.models.publication_command import PublicationCommand
    from app.services.ads_boost_execution import OP_PAUSE

    async with Session() as s:
        return (await s.execute(
            select(PublicationCommand).where(PublicationCommand.gate_id == gate_id, PublicationCommand.operation == OP_PAUSE)
            .order_by(PublicationCommand.created_at)
        )).scalars().all()


async def _spend_tick(Session):
    from app.services.ads_spend_snapshots import process_due_ads_spend_snapshots

    async with Session() as s:
        return await process_due_ads_spend_snapshots(s, now=datetime.now(timezone.utc))


async def test_a_person_can_pause_while_the_gate_is_back_in_review(monkeypatch):
    """(가) — the «중지» button worked only on an approved gate (409 GATE_NOT_APPROVED) while the campaign kept spending."""
    from app.services.ads_boost_execution import request_ads_boost_pause

    engine, Session, org_id, owner_id, gate_id, calls = await _running(monkeypatch)
    try:
        await _reopen(Session, org_id, owner_id, gate_id)
        assert await _gate_status(Session, gate_id) == "pending"
        async with Session() as s:
            pause = await request_ads_boost_pause(s, org_id=org_id, gate_id=gate_id, requester_member_id=owner_id)
            await s.commit()
            pause_id = pause.id
        await _tick(Session)
        assert calls[-1] == "PAUSED"
        assert (await _command(Session, pause_id)).status == "completed"
        assert (await _run(Session, gate_id)).status == "paused"
    finally:
        await engine.dispose()


async def test_a_queued_pause_survives_a_reopen(monkeypatch):
    """(나) — a re-request voided every pending command of the gate, the person's queued pause included."""
    from app.services.ads_boost_execution import request_ads_boost_pause

    engine, Session, org_id, owner_id, gate_id, calls = await _running(monkeypatch)
    try:
        async with Session() as s:
            pause = await request_ads_boost_pause(s, org_id=org_id, gate_id=gate_id, requester_member_id=owner_id)
            await s.commit()
            pause_id = pause.id
        await _reopen(Session, org_id, owner_id, gate_id)
        assert (await _command(Session, pause_id)).status == "pending"
        await _tick(Session)
        assert calls[-1] == "PAUSED" and (await _command(Session, pause_id)).status == "completed"
    finally:
        await engine.dispose()


@pytest.mark.parametrize("leave", ["reopen", "undo"])
async def test_a_running_boost_whose_gate_leaves_approved_is_paused(monkeypatch, leave):
    """(다) — whichever way the gate leaves approved, the live campaign is paused by the scheduler (no money on unapproved
    values), once: a second pass adds no second pause."""
    engine, Session, org_id, owner_id, gate_id, calls = await _running(monkeypatch)
    try:
        await (_reopen if leave == "reopen" else _undo)(Session, org_id, owner_id, gate_id)
        assert await _gate_status(Session, gate_id) == "pending"
        await _spend_tick(Session)
        pauses = await _pauses(Session, gate_id)
        assert [(p.initiated_by, p.status) for p in pauses] == [("scheduler", "pending")], [(p.initiated_by, p.status) for p in pauses]
        await _tick(Session)
        assert calls[-1] == "PAUSED" and (await _run(Session, gate_id)).status == "paused"
        await _spend_tick(Session)
        assert len(await _pauses(Session, gate_id)) == 1
    finally:
        await engine.dispose()


async def test_the_cap_pause_goes_through_on_a_gate_back_in_review(monkeypatch):
    """(가) — the cap's automatic pause swallowed GateNotApproved, and a reopen cleared the resolver it was attributed to."""
    from sqlalchemy import select

    from app.models.gate import Gate
    from app.services.ads_spend_snapshots import _pause_by_scheduler

    engine, Session, org_id, owner_id, gate_id, calls = await _running(monkeypatch)
    try:
        await _reopen(Session, org_id, owner_id, gate_id)
        async with Session() as s:
            gate = (await s.execute(select(Gate).where(Gate.id == gate_id))).scalar_one()
            assert gate.resolver_id is None
            run = await _run(Session, gate_id)
            assert await _pause_by_scheduler(s, gate=gate, run=run) is True
        pauses = await _pauses(Session, gate_id)
        assert [p.initiated_by for p in pauses] == ["scheduler"] and pauses[0].requested_by_member_id == owner_id
    finally:
        await engine.dispose()


async def test_resume_still_needs_an_approved_gate(monkeypatch):
    """The boundary: only stopping money is exempt — a resume on a gate back in review is refused."""
    from app.services.ads_boost_execution import AdsBoostGateNotApprovedError, request_ads_boost_pause, request_ads_boost_resume

    engine, Session, org_id, owner_id, gate_id, calls = await _running(monkeypatch)
    try:
        async with Session() as s:
            await request_ads_boost_pause(s, org_id=org_id, gate_id=gate_id, requester_member_id=owner_id)
            await s.commit()
        await _tick(Session)
        await _reopen(Session, org_id, owner_id, gate_id)
        async with Session() as s:
            with pytest.raises(AdsBoostGateNotApprovedError):
                await request_ads_boost_resume(s, org_id=org_id, gate_id=gate_id, requester_member_id=owner_id)
    finally:
        await engine.dispose()
