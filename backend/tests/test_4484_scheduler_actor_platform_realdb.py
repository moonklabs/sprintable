"""story #4484 — what the scheduler did is recorded as the platform's, not a person's.

PO 02:17Z · 06:56Z: a command's activity was always written with the command's requester as a human actor — the approver or
whoever started the boost — so the history read «{사람} · 자동 중지(광고비 상한 도달)» for a pause the server made. The one place
a command's activity is written now records a command the scheduler sent as actor_type «platform» with no actor (activity_log's
rule; 4485 draws it «시스템»): the cap · approval-withdrawn · unreadable-spend pauses and the start made on the sealed start date.
A person's press stays theirs. Rows written before stay as they were.
"""
from __future__ import annotations

import os
from datetime import datetime, timedelta, timezone

import pytest

from tests.test_3475_publishing_metrics import _client_for
from tests.test_4404_publish_worker_no_open_tx_realdb import _start_command, _tick
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


async def _rows(Session, gate_id, action):
    from sqlalchemy import select

    from app.models.activity_log import ActivityLog

    async with Session() as s:
        return (await s.execute(
            select(ActivityLog).where(ActivityLog.entity_id == gate_id, ActivityLog.action == action).order_by(ActivityLog.created_at)
        )).scalars().all()


async def _history(Session, org_id, owner_id, gate_id):
    """The gate history through its real route (project access and all): the post is on a real story (on_a_story)."""
    from app.main import app
    from tests.test_2975_gate_activity_audit_trail_realdb import _setup_app

    await _setup_app(app, Session, org_id, owner_id)
    try:
        async with _client_for(app) as client:
            r = await client.get(f"/api/v2/gates/{gate_id}/activity")
        assert r.status_code == 200, r.text
        return r.json()
    finally:
        app.dependency_overrides.clear()


async def _setup(monkeypatch, *, budget_minor=100_000, approve=True):
    from tests.test_3806_ads_boost_execution import _setup_approved_gate
    from tests.test_4460_cancel_this_boost_realdb import _provider
    from tests.test_e4fc29fa_site_post_orchestration import _session_factory

    engine, Session, org_id, _project_id, owner_id, gate_id = await _setup_approved_gate(
        await _session_factory(), budget_minor=budget_minor, approve=approve, on_a_story=True,
    )
    return engine, Session, org_id, owner_id, gate_id, _provider(monkeypatch)


def _platform(row) -> bool:
    return (row.actor_type, row.actor_id) == ("platform", None)


async def test_the_caps_pause_is_the_platforms(monkeypatch):
    from app.services.ads_spend_snapshots import refresh_ads_boost_spend_now

    engine, Session, org_id, owner_id, gate_id, _calls = await _setup(monkeypatch, budget_minor=10_000)
    try:
        await _start_command(Session, org_id, gate_id, owner_id)
        await _tick(Session)
        async with Session() as s:
            await refresh_ads_boost_spend_now(s, org_id=org_id, gate_id=gate_id, requester_member_id=owner_id)
        await _tick(Session)
        [row] = await _rows(Session, gate_id, "ads_boost_paused")
        assert _platform(row) and row.context.get("reason") == "cap_reached"
        [shown] = [h for h in await _history(Session, org_id, owner_id, gate_id) if h["action"] == "ads_boost_paused"]
        assert (shown["actor_type"], shown["actor_id"], shown["actor_name"]) == ("platform", None, None)
        [started] = await _rows(Session, gate_id, "ads_boost_started")
        assert (started.actor_type, started.actor_id) == ("human", owner_id)  # the person's [시작] stays theirs
    finally:
        await engine.dispose()


async def test_the_approval_withdrawn_pause_is_the_platforms(monkeypatch):
    from tests.test_4466_money_stops_off_approved_realdb import _reopen, _spend_tick

    engine, Session, org_id, owner_id, gate_id, _calls = await _setup(monkeypatch)
    try:
        await _start_command(Session, org_id, gate_id, owner_id)
        await _tick(Session)
        await _reopen(Session, org_id, owner_id, gate_id)
        await _spend_tick(Session)
        await _tick(Session)
        [row] = await _rows(Session, gate_id, "ads_boost_paused")
        assert _platform(row) and row.context.get("reason") == "approval_gone"
    finally:
        await engine.dispose()


async def test_the_start_on_the_sealed_start_date_is_the_platforms(monkeypatch):
    from app.services.ads_boost_execution import process_due_ads_boost_starts

    engine, Session, org_id, owner_id, gate_id, _calls = await _setup(monkeypatch)
    try:
        async with Session() as s:
            await process_due_ads_boost_starts(s, now=datetime.now(timezone.utc) + timedelta(days=60))
        await _tick(Session)
        [row] = await _rows(Session, gate_id, "ads_boost_started")
        assert _platform(row) and row.context.get("initiated_by") == "scheduler"
    finally:
        await engine.dispose()


async def test_a_persons_pause_stays_the_persons(monkeypatch):
    from app.services.ads_boost_execution import request_ads_boost_pause

    engine, Session, org_id, owner_id, gate_id, _calls = await _setup(monkeypatch)
    try:
        await _start_command(Session, org_id, gate_id, owner_id)
        await _tick(Session)
        async with Session() as s:
            await request_ads_boost_pause(s, org_id=org_id, gate_id=gate_id, requester_member_id=owner_id)
        await _tick(Session)
        [row] = await _rows(Session, gate_id, "ads_boost_paused")
        assert (row.actor_type, row.actor_id) == ("human", owner_id)
    finally:
        await engine.dispose()
