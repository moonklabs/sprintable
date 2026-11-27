"""story 5053 — a word that enters a room by the CARD ROAD reaches an OPEN list live, not only on the next refresh.

dev 11-27 (live-lift, 390 and 1440): the server's order was right (re-read = the card room first) but a list left open never moved — the roads other than `send_message` called
`_dispatch_conversation_event`, which INSERTS the Event rows and RETURNS the live frames for the caller to push after the commit; they dropped the return. Now one wrapper
(`dispatch_conversation_event_live`) pushes them with the commit, for every such road.
"""
from __future__ import annotations

import re
import uuid
from pathlib import Path

import pytest

from tests.test_5041_agent_action_realdb import (  # the same seed / «who makes the next call» as the approval-flow tests
    _REAL_DB_URL,
    _act_as,
    _client_for,
    _dispose_global_engine_after_test,  # noqa: F401  (autouse fixture)
    _seed,
    _session_factory,
    anyio_backend,  # noqa: F401
)

pytestmark = [pytest.mark.skipif(not _REAL_DB_URL, reason="needs a real PG (PARITY/ALEMBIC_DATABASE_URL)")]


def _capture(monkeypatch):
    seen: list[tuple[str, dict]] = []

    def fake(member_id, payload, _from_listener=False):
        seen.append((str(member_id), payload))
        return True

    monkeypatch.setattr("app.routers.events._push_to_agent", fake)
    return seen


@pytest.mark.anyio
async def test_the_approval_card_and_its_result_line_are_pushed_live(monkeypatch):
    from app.main import app

    seen = _capture(monkeypatch)
    engine, Session = await _session_factory()
    try:
        async with Session() as s:
            d = await _seed(s)
        await _act_as(app, Session, d["agent_id"], d["org_id"], api_key=True)
        async with _client_for(app) as c:
            ask = await c.delete(f"/api/v2/stories/{d['story_id']}")
        assert ask.status_code == 202, ask.text
        cards = [(m, p) for m, p in seen if p.get("event_type") == "conversation.message_created"]
        to_person = [p for m, p in cards if m == str(d["admin_om"])]
        assert to_person, f"the person's open list heard of the card (pushes: {[(m[:8], p.get('event_type')) for m, p in seen]})"
        assert to_person[0].get("conversation_id") and to_person[0].get("created_at"), "the frame carries what the list needs to lift the room: the room and the moment"

        before = len(seen)
        await _act_as(app, Session, d["admin_user"], d["org_id"])
        async with _client_for(app) as c:
            pressed = await c.post(f"/api/v2/agent-actions/{ask.json()['request_id']}/decision", json={"decision": "approve"})
        assert pressed.status_code == 200, pressed.text
        after = [(m, p) for m, p in seen[before:] if p.get("event_type") == "conversation.message_created"]
        assert not any(m == str(d["agent_id"]) for m, _ in seen), "an agent gets NO live frame from these roads — only the people's open lists do (C0: an agent is delivered only what calls it)"
    finally:
        app.dependency_overrides.clear()
        await engine.dispose()


async def _flow(monkeypatch, *, bare: bool):
    """ask + press once; returns (frames pushed, the Event rows of the agent and of the person, the seed)"""
    from sqlalchemy import text

    from app.main import app
    from app.routers import conversations as conv_mod

    if bare:
        async def dropped(db, conversation, msg, org_id, sender, **kwargs):
            await conv_mod._dispatch_conversation_event(db, conversation, msg, org_id, sender, **kwargs)

        monkeypatch.setattr("app.routers.conversations.dispatch_conversation_event_live", dropped)
    seen = _capture(monkeypatch)
    engine, Session = await _session_factory()
    try:
        async with Session() as s:
            d = await _seed(s)
        await _act_as(app, Session, d["agent_id"], d["org_id"], api_key=True)
        async with _client_for(app) as c:
            ask = await c.delete(f"/api/v2/stories/{d['story_id']}")
        await _act_as(app, Session, d["admin_user"], d["org_id"])
        async with _client_for(app) as c:
            await c.post(f"/api/v2/agent-actions/{ask.json()['request_id']}/decision", json={"decision": "approve"})
        async with Session() as s:
            events = {who: (await s.execute(text("SELECT count(*) FROM events WHERE recipient_id = :r AND event_type = 'conversation.message_created'"), {"r": d[key]})).scalar_one() for who, key in (("agent", "agent_id"), ("person", "admin_om"))}
        return seen, events, d
    finally:
        app.dependency_overrides.clear()
        await engine.dispose()


@pytest.mark.anyio
async def test_the_live_frames_add_nothing_on_the_agents_side(monkeypatch):
    """PO 11-27 (C0 5030): the card roads now push frames — the AGENT's side must not grow: the same Event rows for the agent as the road that dropped them, and no frame to the agent;
    only the person's list is told"""
    live_seen, live_events, d = await _flow(monkeypatch, bare=False)
    monkeypatch.undo()
    bare_seen, bare_events, _ = await _flow(monkeypatch, bare=True)
    assert live_events["agent"] == bare_events["agent"] >= 1, "the agent's deliveries (Event rows) are exactly what they were"
    assert live_events["person"] == bare_events["person"]
    assert not any(p.get("event_type") == "conversation.message_created" for _, p in bare_seen)
    recipients = {m for m, p in live_seen if p.get("event_type") == "conversation.message_created"}
    assert recipients == {str(d["admin_om"])}, f"frames go to the person only — never the agent (got {len(recipients)} recipient(s))"


@pytest.mark.anyio
async def test_control_with_the_bare_dispatch_the_open_list_hears_nothing(monkeypatch):
    """the control that makes the test above mean something: the road as it was (the return value dropped) pushes nothing"""
    from app.main import app
    from app.routers import conversations as conv_mod

    async def bare(db, conversation, msg, org_id, sender, **kwargs):
        await conv_mod._dispatch_conversation_event(db, conversation, msg, org_id, sender, **kwargs)  # the frames it returns are dropped

    monkeypatch.setattr("app.routers.conversations.dispatch_conversation_event_live", bare)
    seen = _capture(monkeypatch)
    engine, Session = await _session_factory()
    try:
        async with Session() as s:
            d = await _seed(s)
        await _act_as(app, Session, d["agent_id"], d["org_id"], api_key=True)
        async with _client_for(app) as c:
            ask = await c.delete(f"/api/v2/stories/{d['story_id']}")
        assert ask.status_code == 202, ask.text
        assert [p for _, p in seen if p.get("event_type") == "conversation.message_created"] == [], "without the wrapper no frame leaves (the dev symptom)"
    finally:
        app.dependency_overrides.clear()
        await engine.dispose()


@pytest.mark.anyio
async def test_a_person_without_a_project_grant_gets_the_live_frame_on_the_real_connection_queue(monkeypatch):
    """dev 11-27 (live-lift, 6013 served): the frame was pushed only to recipients the `team_members` VIEW calls «human» — and the view lists a person only once they hold a project
    grant. The organisation's owner (the QA person) holds none, so the owner's open list heard nothing. Here the person has NO grant, the real registry of open streams is used (a queue
    registered the way `/events/stream` registers one), and the frame must arrive on THAT queue — the road the browser listens on."""
    import asyncio

    from sqlalchemy import text

    from app.main import app
    from app.routers.events import _agent_connections

    engine, Session = await _session_factory()
    try:
        async with Session() as s:
            d = await _seed(s)
            await s.execute(text("DELETE FROM project_access WHERE org_member_id = :o"), {"o": d["admin_om"]})
            await s.commit()
            in_view = (await s.execute(text("SELECT count(*) FROM team_members WHERE id = :i"), {"i": d["admin_om"]})).scalar_one()
        assert in_view == 0, "the premise: without a grant the person is not in the team_members view"
        queue: asyncio.Queue = asyncio.Queue(maxsize=100)
        _agent_connections[str(d["admin_om"])].add(queue)
        agent_queue: asyncio.Queue = asyncio.Queue(maxsize=100)
        _agent_connections[str(d["agent_id"])].add(agent_queue)
        try:
            await _act_as(app, Session, d["agent_id"], d["org_id"], api_key=True)
            async with _client_for(app) as c:
                ask = await c.delete(f"/api/v2/stories/{d['story_id']}")
            assert ask.status_code == 202, ask.text
            await asyncio.sleep(0.2)
            got = []
            while not queue.empty():
                got.append(queue.get_nowait())
            assert [p for p in got if p.get("event_type") == "conversation.message_created" and p.get("conversation_id")], f"the owner's open stream received the card (got {[p.get('event_type') for p in got]})"
            assert agent_queue.empty(), "and the agent's own stream received nothing"
        finally:
            _agent_connections[str(d["admin_om"])].discard(queue)
            _agent_connections[str(d["agent_id"])].discard(agent_queue)
    finally:
        app.dependency_overrides.clear()
        await engine.dispose()


@pytest.mark.anyio
async def test_a_rolled_back_savepoint_pushes_nothing(monkeypatch):
    """a best-effort delivery that fails inside its savepoint must not tell the list about a message that does not exist"""
    from sqlalchemy import select

    from app.models.conversation import Conversation, ConversationMessage
    from app.routers.conversations import dispatch_conversation_event_live
    from app.services.approval_delivery import _get_or_create_approval_dm

    seen = _capture(monkeypatch)
    engine, Session = await _session_factory()
    try:
        async with Session() as s:
            d = await _seed(s)
        from app.models.member import Member

        async with Session() as s:
            agent = (await s.execute(select(Member).where(Member.id == d["agent_id"]))).scalar_one()
            conv = await _get_or_create_approval_dm(s, org_id=d["org_id"], project_id=d["project_id"], requester_id=d["agent_id"], approver_id=d["admin_om"])
            await s.commit()
            msg = ConversationMessage(id=uuid.uuid4(), conversation_id=conv.id, sender_id=d["agent_id"], content="rolled back")
            try:
                async with s.begin_nested():
                    s.add(msg)
                    await s.flush()
                    await dispatch_conversation_event_live(s, conv, msg, d["org_id"], agent)
                    raise RuntimeError("the delivery failed after the dispatch")
            except RuntimeError:
                pass
            await s.commit()
        assert [p for _, p in seen if p.get("event_type") == "conversation.message_created"] == [], "nothing is pushed for a message that was rolled back"

        seen.clear()
        async with Session() as s:
            agent = (await s.execute(select(Member).where(Member.id == d["agent_id"]))).scalar_one()
            conv = (await s.execute(select(Conversation).where(Conversation.id == conv.id))).scalar_one()
            kept = ConversationMessage(id=uuid.uuid4(), conversation_id=conv.id, sender_id=d["agent_id"], content="kept")
            s.add(kept)
            await s.flush()
            await dispatch_conversation_event_live(s, conv, kept, d["org_id"], agent)
            assert seen == [], "nothing leaves before the commit"
            await s.commit()
        assert [p for _, p in seen if p.get("event_type") == "conversation.message_created"], "and the frame leaves with the commit"
    finally:
        await engine.dispose()


def test_no_road_outside_send_message_calls_the_dispatch_bare():
    """the ratchet (the 5053 rule «every road»): outside conversations.py the bare `_dispatch_conversation_event(` is not called — a new road uses the wrapper and the frames leave"""
    root = Path(__file__).resolve().parents[1] / "app"
    offenders = []
    for path in root.rglob("*.py"):
        if path.name == "conversations.py" and path.parent.name == "routers":
            continue
        for n, line in enumerate(path.read_text().splitlines(), 1):
            if re.search(r"await\s+_dispatch_conversation_event\(", line):
                offenders.append(f"{path.relative_to(root)}:{n}")
    assert offenders == [], f"use dispatch_conversation_event_live: {offenders}"
