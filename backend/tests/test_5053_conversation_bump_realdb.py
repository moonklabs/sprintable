"""story 5053 — a message that enters a room by ANY road lifts the room in the list (the conversation list is ordered by `conversations.updated_at`).

Red when: the trigger that raises the room's time is missing (a road that did not raise it by itself — the approval card, a raw insert — leaves the room at its old place) · the trigger LOWERS a room's time ·
the backfill does not correct a room whose last word is later than its `updated_at` · the backfill touches a room that is in step.
"""
from __future__ import annotations

import re
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

pytestmark = [pytest.mark.skipif(not _REAL_DB_URL, reason="needs a real PG (PARITY/ALEMBIC_DATABASE_URL)")]

OLD = datetime.now(timezone.utc) - timedelta(days=96)  # «a room that has not moved for months» (relative, never an absolute date)


@pytest.fixture
def anyio_backend():
    return "asyncio"


def _backfill_sql() -> str:
    """the UPDATE the migration runs, read out of the migration's own source (it is written inline in upgrade() so the cutover reading lists it)"""
    src = (Path(__file__).resolve().parent.parent / "alembic/versions/0506_conversation_messages_bump_room.py").read_text()
    m = re.search(r"UPDATE conversations c SET updated_at = LEAST\(m\.last_at, now\(\)\).*?LEAST\(m\.last_at, now\(\)\) > c\.updated_at", src, re.S)
    assert m, "the backfill statement was not found in the migration"
    return m.group(0)


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
async def test_the_backfill_corrects_the_rooms_out_of_step_and_leaves_the_others():
    from app.models.conversation import ConversationMessage

    engine, Session = await _session_factory()
    try:
        async with Session() as s:
            d = await _seed(s)
        late = OLD + timedelta(days=90)
        stale = await _room(Session, d, title="stale", updated_at=OLD)
        in_step = await _room(Session, d, title="in step", updated_at=late + timedelta(days=3))
        empty = await _room(Session, d, title="no words", updated_at=OLD)
        async with Session() as s:
            for room in (stale, in_step):
                s.add(ConversationMessage(id=uuid.uuid4(), conversation_id=room, sender_id=d["agent_id"], content="a word", created_at=late))
            await s.commit()
            # the state the bug left: the last word is later than the room's time
            await s.execute(text("UPDATE conversations SET updated_at = :t WHERE id = :i"), {"t": OLD, "i": stale})
            await s.commit()
        async with Session() as s:
            await s.execute(text(_backfill_sql()))
            await s.commit()
        assert abs((await _updated_at(Session, stale)) - late) < timedelta(milliseconds=1), "corrected to the last word's time"
        assert (await _updated_at(Session, in_step)) == late + timedelta(days=3), "a room in step is not touched"
        assert (await _updated_at(Session, empty)) == OLD, "a room without words is not touched"
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
