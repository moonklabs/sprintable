"""story #4404 — the publication worker does not hold a DB transaction open while waiting on provider calls, and «create once»
is kept by explicit claims instead of an uncommitted row.

- Channel publish: the publication row is committed as the claim before the (slow) container upload; during the upload no
  backend is idle in transaction, and a second publisher of the same gate/version gets «in progress» at once (it used to queue
  on the unique INSERT for the whole upload).
- Ads boost start: the campaign is created at most once per run, across commands. A claim that expired **with** the
  provider-call marker and no ids is «outcome unknown» → needs_check, never re-created; one that expired **without** it is
  claimed again and created once.

Real PG; «idle in transaction» is read from pg_stat_activity through a separate autocommit connection during the slow call.
"""
from __future__ import annotations

import asyncio
import os
import time
import uuid
from datetime import UTC, datetime, timedelta

import pytest

from tests.test_3806_ads_boost_execution import _setup_approved_gate
from tests.test_4142_recipe_async_video_publish_command_realdb import (  # noqa: F401 — autouse fixtures of those helpers
    _configure_secrets,
    _create_and_submit_video_draft,
    _local_channel_media_storage,
    _realdb_session,
    _seed_agent,
    _seed_default_role,
    _seed_definition,
    _seed_org_with_owner,
    _seed_recipe_channel_binding,
    _seed_reels_connection,
    _seed_story,
    _seed_system_publisher_teammember_shim,
)

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


def _async_url() -> str:
    url = _REAL_DB_URL
    for prefix in ("postgresql+psycopg2://", "postgresql+asyncpg://", "postgresql://"):
        if url.startswith(prefix):
            return "postgresql+asyncpg://" + url[len(prefix):]
    return url


async def _idle_in_transaction() -> int:
    from sqlalchemy import text
    from sqlalchemy.ext.asyncio import create_async_engine

    engine = create_async_engine(_async_url(), isolation_level="AUTOCOMMIT")
    try:
        async with engine.connect() as conn:
            return (await conn.execute(text(
                "SELECT count(*) FROM pg_stat_activity "
                "WHERE datname = current_database() AND state LIKE 'idle in transaction%' AND pid <> pg_backend_pid()"
            ))).scalar_one()
    finally:
        await engine.dispose()


# ── channel publish ─────────────────────────────────────────────────────────────────────────────────────────────────

async def _approved_video_draft():
    from app.main import app
    from app.services.gate_service import transition_gate
    from tests.recipe_reviewed_draft import reviewed_draft_for

    engine, Session = await _realdb_session()
    async with Session() as s:
        org_id, project_id, owner_member_id, _owner_user_id = await _seed_org_with_owner(s, slug="4404p")
        await _seed_default_role(s, org_id)
        await _seed_system_publisher_teammember_shim(s, org_id, project_id)
        creator_id = await _seed_agent(s, org_id, project_id, name="댄")
        story_id = await _seed_story(s, org_id, project_id)
        await _seed_definition(s)
        connection_id = await _seed_reels_connection(s, org_id)
        await _seed_recipe_channel_binding(s, org_id, connection_id)
    gate_d_id, scoped_gate_id, draft_id = await _create_and_submit_video_draft(
        Session, app, org_id=org_id, story_id=story_id, creator_id=creator_id,
        owner_member_id=owner_member_id, connection_id=connection_id,
    )
    async with Session() as s:
        await transition_gate(
            s, org_id, gate_d_id, "approved", owner_member_id, "ⓓ 발행 승인",
            reviewed_draft=await reviewed_draft_for(s, org_id=org_id, work_item_id=story_id),
        )
        await s.commit()
    return app, engine, Session, org_id, owner_member_id, scoped_gate_id, draft_id


async def test_a_slow_upload_holds_no_transaction_and_a_second_publisher_is_told_in_progress_at_once(monkeypatch):
    import app.services.instagram_sandbox_publish as ig_sandbox
    from sqlalchemy import select

    from app.models.channel_publication import ChannelPublication
    from app.services.channel_posts import ChannelPublishInProgressError, publish_channel_post_draft
    from tests.publish_worker_helpers import run_worker_tick

    app, engine, Session, org_id, owner_member_id, scoped_gate_id, draft_id = await _approved_video_draft()
    seen: dict = {}
    real_create = ig_sandbox.create_reels_container

    async def slow_create(client, **kwargs):
        await asyncio.sleep(0.3)  # the upload
        seen["idle_in_tx"] = await _idle_in_transaction()
        async with Session() as other:  # the claim row is committed, visible to another session
            row = (await other.execute(
                select(ChannelPublication).where(ChannelPublication.gate_id == scoped_gate_id)
            )).scalar_one_or_none()
            seen["claimed_row_visible"] = row is not None and row.container_claimed_at is not None
        started = time.monotonic()
        async with Session() as second:
            try:
                # bounded: before #4404 this INSERT queued behind the first publisher's uncommitted row for the whole upload
                await asyncio.wait_for(publish_channel_post_draft(
                    second, org_id=org_id, draft_id=draft_id, published_by_member_id=owner_member_id,
                ), timeout=10)
                seen["second"] = "published"
            except ChannelPublishInProgressError:
                seen["second"] = "in_progress"
            except TimeoutError:
                seen["second"] = "queued"
        seen["second_seconds"] = time.monotonic() - started
        return await real_create(client, **kwargs)

    monkeypatch.setattr(ig_sandbox, "create_reels_container", slow_create)
    try:
        await run_worker_tick(Session)
        assert seen["idle_in_tx"] == 0
        assert seen["claimed_row_visible"] is True
        assert seen["second"] == "in_progress"
        assert seen["second_seconds"] < 5  # not queued on the INSERT for the whole upload (poll ≈ 3 s at most)
        async with Session() as s:
            rows = (await s.execute(
                select(ChannelPublication).where(ChannelPublication.gate_id == scoped_gate_id)
            )).scalars().all()
        assert len(rows) == 1 and rows[0].external_container_id and rows[0].container_claimed_at is None
    finally:
        app.dependency_overrides.clear()
        await engine.dispose()


# ── ads boost ───────────────────────────────────────────────────────────────────────────────────────────────────────

async def _start_command(Session, org_id, gate_id, owner_id):
    from sqlalchemy import select

    from app.models.publication_command import PublicationCommand
    from app.services.ads_boost_execution import request_ads_boost_start

    async with Session() as s:
        await request_ads_boost_start(s, org_id=org_id, gate_id=gate_id, requester_member_id=owner_id, initiated_by="human")
    async with Session() as s:
        return (await s.execute(select(PublicationCommand).where(
            PublicationCommand.org_id == org_id, PublicationCommand.content_kind == "ads_boost",
        ))).scalar_one()


async def _second_start_command(Session, first) -> uuid.UUID:
    """A second boost_start for the same gate — what a re-approval produces (commands are unique per approved version)."""
    from app.models.publication_command import PublicationCommand

    second = PublicationCommand(
        id=uuid.uuid4(), org_id=first.org_id, gate_id=first.gate_id, destination=first.destination,
        approved_version=uuid.uuid4(), operation=first.operation, toggle_seq=0, content_kind=first.content_kind,
        status="pending", requested_by_member_id=first.requested_by_member_id, initiated_by=first.initiated_by,
    )
    async with Session() as s:
        s.add(second)
        await s.commit()
    return second.id


def _spy_create(monkeypatch, *, delay: float = 0.0, probe=None):
    import app.services.ads_sandbox_campaign as sandbox

    real = sandbox.create_boost_campaign
    calls: list[int] = []

    async def spy(client, **kwargs):
        calls.append(1)
        if delay:
            await asyncio.sleep(delay)
        if probe is not None:
            await probe()
        return await real(client, **kwargs)

    monkeypatch.setattr(sandbox, "create_boost_campaign", spy)
    return calls


async def _tick(Session):
    from tests.publish_worker_helpers import run_worker_tick

    return await run_worker_tick(Session)


async def _command(Session, command_id):
    from app.models.publication_command import PublicationCommand

    async with Session() as s:
        return await s.get(PublicationCommand, command_id)


async def _run(Session, gate_id):
    from sqlalchemy import select

    from app.models.ads_boost_run import AdsBoostRun

    async with Session() as s:
        return (await s.execute(select(AdsBoostRun).where(AdsBoostRun.gate_id == gate_id))).scalar_one_or_none()


async def test_ads_boost_slow_create_holds_no_transaction_and_commits_the_marker_first(monkeypatch):
    from tests.test_e4fc29fa_site_post_orchestration import _session_factory

    engine, Session, org_id, _project_id, owner_id, gate_id = await _setup_approved_gate(await _session_factory())
    seen: dict = {}

    async def probe():
        seen["idle_in_tx"] = await _idle_in_transaction()
        run = await _run(Session, gate_id)
        seen["marker"] = run.create_call_started_at is not None and run.create_claimed_at is not None

    calls = _spy_create(monkeypatch, delay=0.3, probe=probe)
    try:
        await _start_command(Session, org_id, gate_id, owner_id)
        counts = await _tick(Session)
        assert counts["completed"] == 1, counts
        assert calls == [1]
        assert seen == {"idle_in_tx": 0, "marker": True}
        run = await _run(Session, gate_id)
        assert run.campaign_id and run.create_claimed_at is None and run.create_call_started_at is None
    finally:
        await engine.dispose()


async def test_two_start_commands_of_one_gate_in_two_workers_create_the_campaign_once(monkeypatch):
    from tests.test_e4fc29fa_site_post_orchestration import _session_factory

    engine, Session, org_id, _project_id, owner_id, gate_id = await _setup_approved_gate(await _session_factory())
    calls = _spy_create(monkeypatch, delay=0.5)
    try:
        first = await _start_command(Session, org_id, gate_id, owner_id)
        second_id = await _second_start_command(Session, first)
        await asyncio.gather(_tick(Session), _tick(Session))  # two workers, one command each (SKIP LOCKED)
        assert calls == [1], f"the campaign was created {len(calls)} times"
        commands = [await _command(Session, first.id), await _command(Session, second_id)]
        assert sorted(c.status for c in commands) == ["completed", "pending"], [(c.status, c.last_error) for c in commands]
        loser = next(c for c in commands if c.status == "pending")
        assert loser.failure_kind == "transient" and "another command is creating" in (loser.last_error or "")
        # the loser's retry finds the ids and does not create again
        await _tick(Session)  # (not due yet is fine — the next test tick covers it); force it due:
        async with Session() as s:
            from app.models.publication_command import PublicationCommand

            c = await s.get(PublicationCommand, loser.id)
            c.next_attempt_at = None
            await s.commit()
        await _tick(Session)
        assert calls == [1]
        assert (await _command(Session, loser.id)).status == "completed"
    finally:
        await engine.dispose()


async def test_an_expired_claim_with_the_call_marker_and_no_ids_is_never_recreated(monkeypatch):
    from sqlalchemy import update

    from app.models.ads_boost_run import AdsBoostRun
    from app.services.ads_boost_execution import _get_or_create_run
    from tests.test_e4fc29fa_site_post_orchestration import _session_factory

    engine, Session, org_id, _project_id, owner_id, gate_id = await _setup_approved_gate(await _session_factory())
    calls = _spy_create(monkeypatch)
    try:
        async with Session() as s:
            run = await _get_or_create_run(s, org_id=org_id, gate_id=gate_id)
            await s.commit()
            long_ago = datetime.now(UTC) - timedelta(hours=3)
            await s.execute(update(AdsBoostRun).where(AdsBoostRun.id == run.id)
                            .values(create_claimed_at=long_ago, create_call_started_at=long_ago))
            await s.commit()
        command = await _start_command(Session, org_id, gate_id, owner_id)
        await _tick(Session)
        assert calls == [], "outcome unknown must not create again (customer ad spend)"
        c = await _command(Session, command.id)
        assert (c.status, c.failure_kind) == ("dead_letter", "needs_check"), (c.status, c.failure_kind, c.last_error)
        assert "ADS_BOOST_CREATE_OUTCOME_UNKNOWN" in (c.last_error or "") or "never recorded its ids" in (c.last_error or "")
    finally:
        await engine.dispose()


async def test_an_expired_claim_without_the_marker_is_claimed_again_and_created_once(monkeypatch):
    from sqlalchemy import update

    from app.models.ads_boost_run import AdsBoostRun
    from app.services.ads_boost_execution import _get_or_create_run
    from tests.test_e4fc29fa_site_post_orchestration import _session_factory

    engine, Session, org_id, _project_id, owner_id, gate_id = await _setup_approved_gate(await _session_factory())
    calls = _spy_create(monkeypatch)
    try:
        async with Session() as s:
            run = await _get_or_create_run(s, org_id=org_id, gate_id=gate_id)
            await s.commit()
            await s.execute(update(AdsBoostRun).where(AdsBoostRun.id == run.id)
                            .values(create_claimed_at=datetime.now(UTC) - timedelta(hours=3), create_call_started_at=None))
            await s.commit()
        command = await _start_command(Session, org_id, gate_id, owner_id)
        counts = await _tick(Session)
        assert counts["completed"] == 1, counts
        assert calls == [1]
        assert (await _command(Session, command.id)).status == "completed"
    finally:
        await engine.dispose()


async def test_mutation_without_the_claim_two_workers_create_twice(monkeypatch):
    import app.services.ads_boost_execution as execution
    from tests.test_e4fc29fa_site_post_orchestration import _session_factory

    async def always_win(db, run, *, now):
        return True

    monkeypatch.setattr(execution, "_claim_campaign_creation", always_win)
    engine, Session, org_id, _project_id, owner_id, gate_id = await _setup_approved_gate(await _session_factory())
    calls = _spy_create(monkeypatch, delay=0.5)
    try:
        first = await _start_command(Session, org_id, gate_id, owner_id)
        await _second_start_command(Session, first)
        await asyncio.gather(_tick(Session), _tick(Session))
        assert len(calls) == 2  # the double spend the claim prevents
    finally:
        await engine.dispose()


async def test_a_batch_of_two_commands_where_the_first_call_fails_still_completes_the_second(monkeypatch):
    """The worker session now commits mid-command (before each provider call); a failure of the first command's call must
    not leak into the second one on the same session."""
    import app.services.ads_sandbox_campaign as sandbox
    from app.services.meta_ads_campaign import MetaAdsCampaignError
    from tests.test_e4fc29fa_site_post_orchestration import _session_factory

    engine, Session, org_a, _p, owner_a, gate_a = await _setup_approved_gate(await _session_factory())
    engine_b, _Session_b, org_b, _p2, owner_b, gate_b = await _setup_approved_gate(await _session_factory())
    real = sandbox.create_boost_campaign
    calls: list[int] = []

    async def first_fails(client, **kwargs):
        calls.append(1)
        if len(calls) == 1:
            raise MetaAdsCampaignError(
                "META_ADS_CAMPAIGN_CREATE_FAILED", "first command's create failed (injected)", outcome_known=True,
            )
        return await real(client, **kwargs)

    monkeypatch.setattr(sandbox, "create_boost_campaign", first_fails)
    try:
        first = await _start_command(Session, org_a, gate_a, owner_a)
        second = await _start_command(Session, org_b, gate_b, owner_b)
        counts = await _tick(Session)  # one worker, both commands in one batch
        assert len(calls) == 2
        statuses = {(await _command(Session, first.id)).status, (await _command(Session, second.id)).status}
        assert "completed" in statuses and len(statuses) == 2, (statuses, counts)
        failed_run = await _run(Session, gate_a if (await _command(Session, first.id)).status != "completed" else gate_b)
        assert failed_run.create_claimed_at is None and failed_run.create_call_started_at is None  # known failure: released
    finally:
        await engine.dispose()
        await engine_b.dispose()
