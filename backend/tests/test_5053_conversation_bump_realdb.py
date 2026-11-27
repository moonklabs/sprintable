"""story 5053 — a message that enters a room by ANY road lifts the room in the list (the conversation list is ordered by `conversations.updated_at`).

Red when: the trigger that raises the room's time is missing (a road that did not raise it by itself — the approval card, a raw insert — leaves the room at its old place) · the trigger LOWERS a room's time ·
the backfill does not correct a room whose last word is later than its `updated_at` · the backfill touches a room that is in step.
"""
from __future__ import annotations

import asyncio
import os
import uuid
from datetime import datetime, timedelta, timezone
from pathlib import Path

import pytest
from sqlalchemy import insert, select, text

from tests.test_5041_agent_action_realdb import (  # noqa: F401 — fixtures used by name
    _REAL_DB_URL,
    _act_as,
    _client_for,
    _dispose_global_engine_after_test,
    _seed,
    _session_factory,
)

def test_in_ci_this_file_is_never_skipped():
    """the tests below need a real PostgreSQL that alembic has migrated (that is where the trigger comes from): locally they skip without one, in CI a missing database is a RED, not a skip"""
    if os.getenv("CI"):
        assert _REAL_DB_URL, "CI has no database url for the realdb tests — the trigger of migration 0506 would go unproved"


pytestmark = [pytest.mark.skipif(not _REAL_DB_URL, reason="needs a real PG (PARITY/ALEMBIC_DATABASE_URL)")]

OLD = datetime.now(timezone.utc) - timedelta(days=96)  # «a room that has not moved for months» (relative, never an absolute date)


@pytest.fixture
def anyio_backend():
    return "asyncio"


async def _room(Session, d, *, title: str, updated_at: datetime, with_agent: bool = True):
    from app.models.conversation import Conversation, ConversationParticipant

    async with Session() as s:
        c = Conversation(id=uuid.uuid4(), org_id=d["org_id"], project_id=d["project_id"], type="group", title=title)
        s.add(c)
        await s.commit()
        s.add(ConversationParticipant(id=uuid.uuid4(), conversation_id=c.id, member_id=d["admin_om"]))
        if with_agent:
            s.add(ConversationParticipant(id=uuid.uuid4(), conversation_id=c.id, member_id=d["agent_id"]))
        await s.commit()
        await s.execute(text("UPDATE conversations SET updated_at = :t WHERE id = :i"), {"t": updated_at, "i": c.id})
        await s.commit()
        return c.id


async def _updated_at(Session, conv_id):
    async with Session() as s:
        return (await s.execute(text("SELECT updated_at FROM conversations WHERE id = :i"), {"i": conv_id})).scalar_one()


async def _first_in_list(app, Session, d):
    await _act_as(app, Session, d["admin_user"], d["org_id"], project_id=d["project_id"])
    async with _client_for(app) as c:
        r = await c.get("/api/v2/conversations?limit=20")
    assert r.status_code == 200, r.text
    rows = r.json()["data"]
    return rows[0]["id"] if rows else None, [x["id"] for x in rows]


@pytest.mark.anyio
@pytest.mark.parametrize("road", ["orm", "core_insert", "route", "approval_card"])
async def test_a_message_from_any_road_lifts_the_room_to_the_top(road):
    from app.main import app
    from app.models.conversation import ConversationMessage

    engine, Session = await _session_factory()
    try:
        async with Session() as s:
            d = await _seed(s)
        target = await _room(Session, d, title="old room", updated_at=OLD)
        other = await _room(Session, d, title="recent room", updated_at=datetime.now(timezone.utc) - timedelta(hours=1))

        if road == "orm":
            async with Session() as s:
                s.add(ConversationMessage(id=uuid.uuid4(), conversation_id=target, sender_id=d["agent_id"], content="by the ORM"))
                await s.commit()
        elif road == "core_insert":
            async with Session() as s:
                await s.execute(insert(ConversationMessage.__table__).values(id=uuid.uuid4(), conversation_id=target, sender_id=d["agent_id"], content="by a bulk insert"))
                await s.commit()
        elif road == "route":
            await _act_as(app, Session, d["admin_user"], d["org_id"], project_id=d["project_id"])
            async with _client_for(app) as c:
                r = await c.post(f"/api/v2/conversations/{target}/messages", json={"content": "hello", "mentioned_ids": []})
            assert r.status_code in (200, 201), r.text
        else:  # the approval card: an agent's ask posts its card into the DM of the person who made the agent — made old on purpose
            from app.services.approval_delivery import _get_or_create_approval_dm

            async with Session() as s:
                dm = await _get_or_create_approval_dm(s, org_id=d["org_id"], project_id=d["project_id"], requester_id=d["agent_id"], approver_id=d["admin_om"])
                await s.commit()
                target = dm.id
                await s.execute(text("UPDATE conversations SET updated_at = :t WHERE id = :i"), {"t": OLD, "i": target})
                await s.commit()
            await _act_as(app, Session, d["agent_id"], d["org_id"], api_key=True)
            async with _client_for(app) as c:
                ask = await c.delete(f"/api/v2/stories/{d['story_id']}")
            assert ask.status_code == 202 and ask.json()["card_delivered"] is True, ask.text

        first, order = await _first_in_list(app, Session, d)
        assert first == str(target), f"{road}: the room that just got a word is first (got order {order}, other room {other})"
        assert (await _updated_at(Session, target)) > OLD
    finally:
        app.dependency_overrides.clear()
        await engine.dispose()


@pytest.mark.anyio
async def test_the_trigger_never_lowers_a_rooms_time():
    from app.models.conversation import ConversationMessage

    engine, Session = await _session_factory()
    try:
        async with Session() as s:
            d = await _seed(s)
        recent = datetime.now(timezone.utc)
        room = await _room(Session, d, title="r", updated_at=recent)
        async with Session() as s:
            s.add(ConversationMessage(id=uuid.uuid4(), conversation_id=room, sender_id=d["agent_id"], content="an old word, entered late", created_at=OLD))
            await s.commit()
        assert abs((await _updated_at(Session, room)) - recent) < timedelta(milliseconds=1), "a message older than the room's time does not move it back"
    finally:
        await engine.dispose()


@pytest.mark.anyio
async def test_the_backfill_job_corrects_the_rooms_out_of_step_in_chunks_and_leaves_the_others():
    from app.models.conversation import ConversationMessage
    from scripts.jobs.backfill_conversation_updated_at import backfill

    engine, Session = await _session_factory()
    try:
        async with Session() as s:
            d = await _seed(s)
        late = OLD + timedelta(days=90)
        stale1 = await _room(Session, d, title="stale 1", updated_at=OLD)
        stale2 = await _room(Session, d, title="stale 2", updated_at=OLD)
        in_step = await _room(Session, d, title="in step", updated_at=late + timedelta(days=3))
        empty = await _room(Session, d, title="no words", updated_at=OLD)
        async with Session() as s:
            for room in (stale1, stale2, in_step):
                s.add(ConversationMessage(id=uuid.uuid4(), conversation_id=room, sender_id=d["agent_id"], content="a word", created_at=late))
            await s.commit()
            # the state the bug left behind: the last word is later than the room's time
            await s.execute(text("UPDATE conversations SET updated_at = :t WHERE id = ANY(CAST(:ids AS uuid[]))"), {"t": OLD, "ids": [str(stale1), str(stale2)]})
            await s.commit()
        # dry-run: counts, writes nothing (the rooms of OTHER tests in this database may be out of step too — only ours are asserted)
        counted = await backfill(Session, chunk=1, apply=False)
        assert counted >= 2
        assert abs((await _updated_at(Session, stale1)) - OLD) < timedelta(milliseconds=1), "a dry-run writes nothing"
        fixed = await backfill(Session, chunk=1, apply=True)  # one room per transaction: every room is still reached
        assert fixed >= 2
        for room in (stale1, stale2):
            assert abs((await _updated_at(Session, room)) - late) < timedelta(milliseconds=1), "corrected to the last word's time"
        assert (await _updated_at(Session, in_step)) == late + timedelta(days=3), "a room in step is not touched"
        assert (await _updated_at(Session, empty)) == OLD, "a room without words is not touched"
        assert await backfill(Session, chunk=7, apply=True) == 0, "a second run finds nothing to do"
    finally:
        await engine.dispose()


@pytest.mark.anyio
async def test_the_backfill_does_not_count_a_tombstoned_word_as_activity():
    """the list preview skips a deleted word; a room lifted by one would show up high with an empty preview"""
    from app.models.conversation import ConversationMessage
    from scripts.jobs.backfill_conversation_updated_at import backfill

    engine, Session = await _session_factory()
    try:
        async with Session() as s:
            d = await _seed(s)
        before, after = OLD + timedelta(days=10), OLD + timedelta(days=60)
        room = await _room(Session, d, title="r", updated_at=OLD)
        async with Session() as s:
            s.add(ConversationMessage(id=uuid.uuid4(), conversation_id=room, sender_id=d["agent_id"], content="a kept word", created_at=before))
            gone = ConversationMessage(id=uuid.uuid4(), conversation_id=room, sender_id=d["agent_id"], content="a later word, then deleted", created_at=after)
            s.add(gone)
            await s.commit()
            await s.execute(text("UPDATE conversation_messages SET deleted_at = now() WHERE id = :i"), {"i": gone.id})
            await s.execute(text("UPDATE conversations SET updated_at = :t WHERE id = :i"), {"t": OLD, "i": room})
            await s.commit()
        await backfill(Session, chunk=50, apply=True)
        assert abs((await _updated_at(Session, room)) - before) < timedelta(milliseconds=1), "the time of the last word that is still there, not the tombstone"
    finally:
        await engine.dispose()


@pytest.mark.anyio
async def test_a_message_stamped_in_the_future_cannot_pin_a_room_to_the_top():
    """codex pass: a hand-stamped / imported message with a future time counts as «now» — a later real word still moves the room"""
    from app.models.conversation import ConversationMessage

    engine, Session = await _session_factory()
    try:
        async with Session() as s:
            d = await _seed(s)
        room = await _room(Session, d, title="r", updated_at=OLD)
        async with Session() as s:
            s.add(ConversationMessage(id=uuid.uuid4(), conversation_id=room, sender_id=d["agent_id"], content="stamped far ahead", created_at=datetime.now(timezone.utc) + timedelta(days=365)))
            await s.commit()
        got = await _updated_at(Session, room)
        assert datetime.now(timezone.utc) - got < timedelta(minutes=1) and got <= datetime.now(timezone.utc), "the future stamp was taken as now"
        async with Session() as s:
            s.add(ConversationMessage(id=uuid.uuid4(), conversation_id=room, sender_id=d["agent_id"], content="a real word after it"))
            await s.commit()
        assert (await _updated_at(Session, room)) >= got, "and a real word still moves the room"
    finally:
        await engine.dispose()


@pytest.mark.anyio
async def test_the_trigger_is_there_because_the_migration_ran():
    """the database of this run was built by alembic: the trigger and its function are the migration's, with the search_path pinned"""
    engine, Session = await _session_factory()
    try:
        async with Session() as s:
            trig = (await s.execute(text("SELECT tgenabled::text AS tgenabled, tgtype FROM pg_trigger WHERE tgname = 'trg_conversation_messages_bump_room' AND NOT tgisinternal"))).one_or_none()
            cfg = (await s.execute(text("SELECT proconfig FROM pg_proc WHERE proname = 'conversation_messages_bump_room'"))).scalar_one_or_none()
        assert trig is not None and trig.tgenabled == "O", "the trigger exists and is enabled"
        assert cfg and any("search_path" in c for c in cfg), "the function pins its search_path"
    finally:
        await engine.dispose()


async def _fan_out(Session, d, approvers, *, label):
    """one approval-card fan-out (the gate road) in its own transaction, the way the app runs it"""
    from app.routers import conversations as conv_router
    from app.services import approval_delivery

    async with Session() as s:
        await approval_delivery.dispatch_approval_request_cards(
            s, org_id=d["org_id"], work_item_type="doc", work_item_id=uuid.uuid4(), project_id=d["project_id"], title=f"fan-out {label}",
            gate_id=uuid.uuid4(), gate_type="merge", requester_id=d["agent_id"], approver_ids=approvers,
        )
        await s.commit()


@pytest.fixture
def slow_dispatch(monkeypatch):
    """a pause after every card is written (while its room is locked): makes the two transactions below overlap the way a busy server would"""
    from app.routers import conversations as conv_router

    real = conv_router._dispatch_conversation_event

    async def slow(*a, **kw):
        await asyncio.sleep(0.6)
        return await real(*a, **kw)

    monkeypatch.setattr(conv_router, "_dispatch_conversation_event", slow)


async def _two_opposite_fan_outs(Session, d):
    a, b = d["admin_om"], d["member_om"]
    results = await asyncio.wait_for(
        asyncio.gather(_fan_out(Session, d, [a, b], label="A"), _fan_out(Session, d, [b, a], label="B"), return_exceptions=True), timeout=60,
    )
    return results


async def _cards_delivered(Session, d) -> int:
    """cards of the two fan-outs that actually landed (the fan-out is best-effort per recipient: a deadlock inside it is logged and that card is LOST — it does not raise)"""
    from app.models.conversation import ConversationMessage

    async with Session() as s:
        rows = (await s.execute(select(ConversationMessage.id).where(ConversationMessage.sender_id == d["agent_id"], ConversationMessage.content.like("'fan-out %")))).all()
    return len(rows)


async def _prepare_rooms(Session, d):
    """the two DMs exist beforehand (creating the same DM from two transactions at once is a different matter)"""
    from app.services.approval_delivery import _get_or_create_approval_dm

    async with Session() as s:
        for who in (d["admin_om"], d["member_om"]):
            await _get_or_create_approval_dm(s, org_id=d["org_id"], project_id=d["project_id"], requester_id=d["agent_id"], approver_id=who)
        await s.commit()


@pytest.mark.anyio
async def test_two_card_fan_outs_in_opposite_orders_queue_instead_of_deadlocking(slow_dispatch):
    engine, Session = await _session_factory()
    try:
        async with Session() as s:
            d = await _seed(s)
        await _prepare_rooms(Session, d)
        results = await _two_opposite_fan_outs(Session, d)
        errors = [r for r in results if isinstance(r, Exception)]
        assert not errors, f"both fan-outs finish: {[type(e).__name__ + ': ' + str(e)[:120] for e in errors]}"
        assert await _cards_delivered(Session, d) == 4, "every approver got both cards: nothing was lost to a deadlock"
    finally:
        await engine.dispose()


@pytest.mark.anyio
async def test_control_without_the_up_front_room_lock_the_same_two_fan_outs_deadlock(slow_dispatch, monkeypatch):
    """the proof that the test above CAN fail: take the up-front lock away and the opposite orders deadlock (this is what the lock in `prepare_card_rooms` prevents)"""
    from app.services import approval_delivery

    async def no_prelock(*a, **kw):
        return None

    monkeypatch.setattr(approval_delivery, "prepare_card_rooms", no_prelock)
    engine, Session = await _session_factory()
    try:
        async with Session() as s:
            d = await _seed(s)
        await _prepare_rooms(Session, d)
        await _two_opposite_fan_outs(Session, d)
        assert await _cards_delivered(Session, d) < 4, "without the lock one fan-out deadlocks and loses a card"
    finally:
        await engine.dispose()
