"""story #4447 — the boost card's states come from the server's contract, and a start that failed says how to go on.

- The three value sets the card branches on (run status · start command status · failure kind) live in one backend module
  (`app/services/ads_boost_states.py`): /spend publishes them as openapi enums and the web imports a TypeScript file generated
  from them (kept fresh by test_4447_ads_boost_states_contract.py). The web had `failed` (never written by the server) and lacked
  `pause_pending` (written by a delayed pause) — a pending pause looked «not started» and offered «홍보 시작».
- `start_command.retryable`: the server's own «can this person retry it» (`human_retryable` · people only) — the card shows the
  retry button from this value, not from its own reading of the status. «홍보 시작» on a failed start only returned the same dead
  command (live S6, 2026-10-01).
- A voided start command (its approval was replaced) is not «the» start command: /spend draws from the valid approval.
"""
from __future__ import annotations

import os

import pytest

from tests.test_3475_publishing_metrics import _client_for, _setup_org_scoped_app
from tests.test_3806_ads_boost_execution import _setup_approved_gate
from tests.test_4404_publish_worker_no_open_tx_realdb import _start_command
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


async def _set_command(Session, command_id, **values):
    from sqlalchemy import update

    from app.models.publication_command import PublicationCommand

    async with Session() as s:
        await s.execute(update(PublicationCommand).where(PublicationCommand.id == command_id).values(**values))
        await s.commit()


async def _spend(app, Session, org_id, owner_id, gate_id) -> dict:
    _setup_org_scoped_app(app, Session, org_id, user_id=owner_id)
    async with _client_for(app) as client:
        r = await client.get(f"/api/v2/organizations/{org_id}/ads-boosts/{gate_id}/spend")
    assert r.status_code == 200, r.text
    return r.json()


@pytest.mark.parametrize(("status", "failure_kind", "retryable"), [
    ("dead_letter", "not_sent", True),        # a person can retry it (the endpoint takes it)
    ("dead_letter", "transient", True),       # retries ran out
    ("blocked", "connection", True),          # after reconnecting
    ("blocked", "paused", False),             # the org's publishing pause: the server re-queues it when the pause is lifted
    ("pending", None, False),                 # still queued: nothing to retry
])
async def test_the_start_command_carries_the_servers_own_retryable(status, failure_kind, retryable):
    from app.main import app
    from tests.test_e4fc29fa_site_post_orchestration import _session_factory

    engine, Session, org_id, _project_id, owner_id, gate_id = await _setup_approved_gate(await _session_factory())
    try:
        command = (await _start_command(Session, org_id, gate_id, owner_id)).id
        await _set_command(Session, command, status=status, failure_kind=failure_kind)
        body = await _spend(app, Session, org_id, owner_id, gate_id)
        assert body["start_command"]["status"] == status
        assert body["start_command"]["retryable"] is retryable
    finally:
        app.dependency_overrides.clear()
        await engine.dispose()


async def test_a_voided_start_command_is_not_the_start_command():
    """Its approval was replaced (a re-seal voids the pending command): /spend draws from the valid approval — no command yet."""
    from app.main import app
    from tests.test_e4fc29fa_site_post_orchestration import _session_factory

    engine, Session, org_id, _project_id, owner_id, gate_id = await _setup_approved_gate(await _session_factory())
    try:
        command = (await _start_command(Session, org_id, gate_id, owner_id)).id
        await _set_command(Session, command, status="voided")
        assert (await _spend(app, Session, org_id, owner_id, gate_id))["start_command"] is None
    finally:
        app.dependency_overrides.clear()
        await engine.dispose()


async def test_an_agent_viewer_never_gets_retryable():
    """The retry endpoint is for people only (`_require_human`): an agent reading /spend gets retryable false."""
    from app.main import app
    from tests.test_e4fc29fa_site_post_orchestration import _session_factory

    engine, Session, org_id, _project_id, owner_id, gate_id = await _setup_approved_gate(await _session_factory())
    try:
        command = (await _start_command(Session, org_id, gate_id, owner_id)).id
        await _set_command(Session, command, status="dead_letter", failure_kind="not_sent")
        _setup_org_scoped_app(app, Session, org_id, user_id=owner_id, agent=True)
        async with _client_for(app) as client:
            r = await client.get(f"/api/v2/organizations/{org_id}/ads-boosts/{gate_id}/spend")
        assert r.status_code == 200, r.text
        assert r.json()["start_command"]["retryable"] is False
    finally:
        app.dependency_overrides.clear()
        await engine.dispose()


async def test_a_start_stopped_before_the_call_carries_its_reason_to_the_card():
    """Qadir 4870 ①: the worker stops a start before any provider call when the approval is gone (or the connection / the source
    post is missing) — `blocked_unapproved`. It wrote the status and the error text only, so /spend had no error_code and the card
    could neither say why nor what next. Now the shared `mark_blocked_unapproved` shape: the reason code reaches the card, and no
    retry (approving again makes a new command)."""
    from datetime import UTC, datetime

    from sqlalchemy import text

    from app.main import app
    from app.models.publication_command import PublicationCommand
    from app.services.ads_boost_execution import process_one_ads_boost_command
    from tests.test_e4fc29fa_site_post_orchestration import _session_factory

    engine, Session, org_id, _project_id, owner_id, gate_id = await _setup_approved_gate(await _session_factory())
    try:
        command_id = (await _start_command(Session, org_id, gate_id, owner_id)).id
        async with Session() as s:  # the approval is gone by the time the worker picks the command up
            await s.execute(text("UPDATE gate SET status='pending' WHERE id=:g"), {"g": gate_id})
            await s.commit()
        async with Session() as s:
            command = await s.get(PublicationCommand, command_id)
            await process_one_ads_boost_command(s, command, now=datetime.now(UTC))
            await s.commit()
        async with Session() as s:
            row = await s.get(PublicationCommand, command_id)
            assert (row.status, row.reason_code, row.failure_kind) == ("blocked_unapproved", "ADS_BOOST_GATE_NOT_APPROVED", None)
        start = (await _spend(app, Session, org_id, owner_id, gate_id))["start_command"]
        assert (start["status"], start["error_code"], start["retryable"]) == ("blocked_unapproved", "ADS_BOOST_GATE_NOT_APPROVED", False)
    finally:
        app.dependency_overrides.clear()
        await engine.dispose()


async def test_after_a_reseal_the_old_stopped_start_is_not_the_start_command():
    """Qadir 4870 (06:47Z) ②: a re-seal voids only the *pending* commands; an old start that had already stopped (dead_letter ·
    blocked) stays. /spend picked the newest non-voided start of the gate — the old one — and the card, seeing a stopped start,
    never showed «홍보 시작» for the new approval. /spend now reads only the start command of the gate's current seal
    (approved_version = sealed_ads_boost_version_id, which every re-seal issues anew)."""
    import uuid

    from sqlalchemy import select

    from app.main import app
    from app.models.gate import Gate
    from tests.test_3806_ads_boost_execution import _boost_body
    from tests.test_3806_ads_boost_gate import _approve_gate
    from tests.test_e4fc29fa_site_post_orchestration import _session_factory

    engine, Session, org_id, _project_id, owner_id, gate_id = await _setup_approved_gate(await _session_factory())
    try:
        old = (await _start_command(Session, org_id, gate_id, owner_id)).id
        await _set_command(Session, old, status="dead_letter", failure_kind="not_sent")
        async with Session() as s:
            gate = (await s.execute(select(Gate).where(Gate.id == gate_id))).scalar_one()
            publication_id, ad_connection_id, old_version = uuid.UUID(gate.scope_key), gate.sealed_ads_connection_id, gate.sealed_ads_boost_version_id
        # the person asks for the boost again (the real request path re-seals the same gate) and it is approved again
        _setup_org_scoped_app(app, Session, org_id, user_id=owner_id)
        async with _client_for(app) as client:
            r = await client.post(f"/api/v2/organizations/{org_id}/publications/{publication_id}/boosts", json=_boost_body(ad_connection_id=ad_connection_id))
        assert r.status_code in (200, 201), r.text
        assert uuid.UUID(r.json()["gate_id"]) == gate_id
        async with Session() as s:
            await _approve_gate(s, gate_id, owner_id)
        async with Session() as s:
            assert (await s.execute(select(Gate.sealed_ads_boost_version_id).where(Gate.id == gate_id))).scalar_one() != old_version
        body = await _spend(app, Session, org_id, owner_id, gate_id)
        assert body["start_command"] is None, body["start_command"]  # the new approval has no start yet → the card offers «홍보 시작»
    finally:
        app.dependency_overrides.clear()
        await engine.dispose()


async def test_after_a_reseal_and_a_second_start_pause_still_works():
    """The same re-seal case (Qadir 4870 ②), one step on: the new approval is started (a second boost_start row for the gate —
    commands are unique per approved version). «Has this gate started» (`_request_toggle`) read the gate's start with
    scalar_one_or_none() and raised MultipleResultsFound — pause/resume failed after any re-approval + start (the 4409 class)."""
    import uuid

    from sqlalchemy import select

    from app.main import app
    from app.models.gate import Gate
    from tests.test_3806_ads_boost_execution import _boost_body
    from tests.test_3806_ads_boost_gate import _approve_gate
    from tests.test_e4fc29fa_site_post_orchestration import _session_factory

    engine, Session, org_id, _project_id, owner_id, gate_id = await _setup_approved_gate(await _session_factory())
    try:
        old = (await _start_command(Session, org_id, gate_id, owner_id)).id
        await _set_command(Session, old, status="dead_letter", failure_kind="not_sent")
        async with Session() as s:
            gate = (await s.execute(select(Gate).where(Gate.id == gate_id))).scalar_one()
            publication_id, ad_connection_id = uuid.UUID(gate.scope_key), gate.sealed_ads_connection_id
        _setup_org_scoped_app(app, Session, org_id, user_id=owner_id)
        async with _client_for(app) as client:
            r = await client.post(f"/api/v2/organizations/{org_id}/publications/{publication_id}/boosts", json=_boost_body(ad_connection_id=ad_connection_id))
            assert r.status_code in (200, 201), r.text
        async with Session() as s:
            await _approve_gate(s, gate_id, owner_id)
        _setup_org_scoped_app(app, Session, org_id, user_id=owner_id)
        async with _client_for(app) as client:
            r_start = await client.post(f"/api/v2/organizations/{org_id}/ads-boosts/{gate_id}/start")
            assert r_start.status_code == 201, r_start.text
            assert r_start.json()["command_id"] != str(old)  # a second start row, for the new seal
            r = await client.post(f"/api/v2/organizations/{org_id}/ads-boosts/{gate_id}/pause")
        assert r.status_code == 201, r.text
        assert r.json()["operation"] == "pause"
    finally:
        app.dependency_overrides.clear()
        await engine.dispose()


async def _reseal_and_approve(Session, org_id, owner_id, gate_id):
    """The person asks for the boost again (the real request path re-seals the same gate) and it is approved again."""
    import uuid

    from sqlalchemy import select

    from app.main import app
    from app.models.gate import Gate
    from tests.test_3806_ads_boost_execution import _boost_body
    from tests.test_3806_ads_boost_gate import _approve_gate

    async with Session() as s:
        gate = (await s.execute(select(Gate).where(Gate.id == gate_id))).scalar_one()
        publication_id, ad_connection_id = uuid.UUID(gate.scope_key), gate.sealed_ads_connection_id
    _setup_org_scoped_app(app, Session, org_id, user_id=owner_id)
    try:
        async with _client_for(app) as client:
            r = await client.post(f"/api/v2/organizations/{org_id}/publications/{publication_id}/boosts", json=_boost_body(ad_connection_id=ad_connection_id))
        assert r.status_code in (200, 201), r.text
    finally:
        app.dependency_overrides.clear()
    async with Session() as s:
        await _approve_gate(s, gate_id, owner_id)


async def test_after_a_reseal_adopt_does_not_take_the_old_seals_start(monkeypatch):
    """Qadir 4870 (07:19Z): adopt-existing picked the gate's newest start by gate alone — an old seal's «outcome unknown» start
    too — and took it on with the old approval (old budget · old content). Now only the current seal's start can be adopted."""
    from tests.test_4404_publish_worker_no_open_tx_realdb import _command
    from tests.test_4412_boost_adopt_existing_realdb import _adopt, _stopped_unknown

    engine, Session, org_id, owner_id, gate_id, command, creates = await _stopped_unknown("[sandbox:create-unknown]", monkeypatch)
    try:
        await _reseal_and_approve(Session, org_id, owner_id, gate_id)
        r = await _adopt(Session, org_id, owner_id, gate_id)
        assert r.status_code == 409, r.text  # nothing of the current seal to adopt
        assert creates == [1]  # no provider call beyond the first (stopped) start
        assert (await _command(Session, command.id)).status == "dead_letter"  # the old start is left as it was
    finally:
        await engine.dispose()


async def test_an_old_seals_command_is_refused_where_every_execution_passes(monkeypatch):
    """The root (Qadir 07:19Z ①): every execution path (worker · retry · adopt) goes through the execution context, which checked
    only that the gate is approved — not that the command belongs to the current seal. An old seal's start retried by hand after a
    re-seal ran with the old approval. Now the context refuses it before any call, with a reason code (ADS_BOOST_SEAL_REPLACED)."""
    from app.main import app
    from tests.test_4404_publish_worker_no_open_tx_realdb import _command, _tick
    from tests.test_4412_boost_adopt_existing_realdb import _stopped_unknown

    engine, Session, org_id, owner_id, gate_id, command, creates = await _stopped_unknown("[sandbox:create-unknown]", monkeypatch)
    try:
        await _reseal_and_approve(Session, org_id, owner_id, gate_id)
        _setup_org_scoped_app(app, Session, org_id, user_id=owner_id)
        try:
            async with _client_for(app) as client:  # a stale screen retries the old start
                # the card's own retry for «outcome unknown»: the person confirms no campaign exists (confirmed_no_campaign)
                r = await client.post(f"/api/v2/organizations/{org_id}/publication-commands/{command.id}/retry", json={"confirmed_no_campaign": True})
        finally:
            app.dependency_overrides.clear()
        assert r.status_code in (200, 201), r.text
        await _tick(Session)
        old = await _command(Session, command.id)
        assert (old.status, old.reason_code) == ("blocked_unapproved", "ADS_BOOST_SEAL_REPLACED"), (old.status, old.reason_code, old.last_error)
        assert creates == [1]  # nothing reached the provider for the old seal
    finally:
        await engine.dispose()


def _status_calls(monkeypatch) -> list[str]:
    import app.services.ads_sandbox_campaign as sandbox

    real = sandbox.set_campaign_status
    calls: list[str] = []

    async def spy(client, **kwargs):
        calls.append(kwargs["status"])
        return await real(client, **kwargs)

    monkeypatch.setattr(sandbox, "set_campaign_status", spy)
    return calls


async def _retry_by_hand(Session, org_id, owner_id, command_id):
    from app.main import app

    _setup_org_scoped_app(app, Session, org_id, user_id=owner_id)
    try:
        async with _client_for(app) as client:
            r = await client.post(f"/api/v2/organizations/{org_id}/publication-commands/{command_id}/retry")
        assert r.status_code in (200, 201), r.text
    finally:
        app.dependency_overrides.clear()


async def test_a_pause_of_an_older_seal_still_runs_after_a_reseal(monkeypatch):
    """PO 08:13Z ① — a pause stops money: the seal check is for the commands that spend (start · resume) only. A pause pressed
    before a re-seal that got stuck (dead_letter) and is retried after it must still switch the campaign off — refusing it would
    leave the campaign spending (a regression the seal check alone would have brought)."""
    from tests.test_4404_publish_worker_no_open_tx_realdb import _command, _run, _tick
    from tests.test_e4fc29fa_site_post_orchestration import _session_factory
    from app.services.ads_boost_execution import request_ads_boost_pause

    engine, Session, org_id, _project_id, owner_id, gate_id = await _setup_approved_gate(await _session_factory())
    statuses = _status_calls(monkeypatch)
    try:
        await _start_command(Session, org_id, gate_id, owner_id)
        await _tick(Session)
        assert (await _run(Session, gate_id)).status == "running"
        async with Session() as s:
            pause = await request_ads_boost_pause(s, org_id=org_id, gate_id=gate_id, requester_member_id=owner_id)
            await s.commit()
            pause_id = pause.id
        await _set_command(Session, pause_id, status="dead_letter", failure_kind="transient")  # stuck before the re-seal
        await _reseal_and_approve(Session, org_id, owner_id, gate_id)
        before = list(statuses)
        await _retry_by_hand(Session, org_id, owner_id, pause_id)
        await _tick(Session)
        assert (await _command(Session, pause_id)).status == "completed"
        assert statuses[len(before):] == ["PAUSED"]
    finally:
        await engine.dispose()


async def test_a_resume_of_an_older_seal_is_refused_after_a_reseal(monkeypatch):
    """The other side of the same rule: a resume spends again — an older seal's resume retried after a re-seal is refused before
    any call (ADS_BOOST_SEAL_REPLACED), like an older start."""
    from tests.test_4404_publish_worker_no_open_tx_realdb import _command, _run, _tick
    from tests.test_e4fc29fa_site_post_orchestration import _session_factory
    from app.services.ads_boost_execution import request_ads_boost_pause, request_ads_boost_resume

    engine, Session, org_id, _project_id, owner_id, gate_id = await _setup_approved_gate(await _session_factory())
    statuses = _status_calls(monkeypatch)
    try:
        await _start_command(Session, org_id, gate_id, owner_id)
        await _tick(Session)
        async with Session() as s:
            await request_ads_boost_pause(s, org_id=org_id, gate_id=gate_id, requester_member_id=owner_id)
            await s.commit()
        await _tick(Session)
        assert (await _run(Session, gate_id)).status == "paused"
        async with Session() as s:
            resume = await request_ads_boost_resume(s, org_id=org_id, gate_id=gate_id, requester_member_id=owner_id)
            await s.commit()
            resume_id = resume.id
        await _set_command(Session, resume_id, status="dead_letter", failure_kind="transient")
        await _reseal_and_approve(Session, org_id, owner_id, gate_id)
        before = list(statuses)
        await _retry_by_hand(Session, org_id, owner_id, resume_id)
        await _tick(Session)
        stopped = await _command(Session, resume_id)
        assert (stopped.status, stopped.reason_code) == ("blocked_unapproved", "ADS_BOOST_SEAL_REPLACED"), (stopped.status, stopped.reason_code, stopped.last_error)
        assert statuses[len(before):] == []  # nothing switched back on
    finally:
        await engine.dispose()
