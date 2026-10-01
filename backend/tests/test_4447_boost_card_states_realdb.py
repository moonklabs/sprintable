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
