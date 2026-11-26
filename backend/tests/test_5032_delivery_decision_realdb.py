"""story #5032 (C2 · «who a sent line was delivered to» — server piece 2) — real Postgres, real HTTP routes, the real `route_message`.

The web draws one line under the sender's bubble («→ only @X got it» / «→ only people got it — the agents did not»). That line must rest on what the SERVER decided, not on what the screen guesses from the
room's list, so the send now reports it — to the sender only:

    delivery_decision = {"agents_delivered": [member id…], "agents_not_delivered": [member id…], "humans_delivered": <count>}

  · from the room's participant rows (the sender left out): an agent in the router's decisions (less the agents the send then holds back) is «delivered», any other agent «not delivered» (muted · «only when
    called» · chain cap · no project NOW in a channel — no reason, no name carried); people are only COUNTED (never who);
  · the send answer carries it at the top level (`delivery`, the blocked count, is another key and is left alone); the sent line keeps it in its metadata, MERGED with what the metadata already holds, and the
    sender's later reads (list · single · replies) and the sender's own echo carry it — nobody else's payload has the key at all;
  · the router did not decide (its pre-check failed → `decisions` is empty) → NOT reported: an unknown decision is never told as «nobody gets it».

  01 group room (2 people + 2 agents), a line that calls nobody → no agent, one person
  02 a line that calls one agent → that agent delivered, the other not
  03 a one-to-one with an agent → delivered
  04 an agent that muted the room is not delivered even when it is called
  05 visibility: the sender's list · single · replies and echo carry it; another person's list · single · echo · the agent's own read do not
  06 pre-check failed → no key in the answer, in the sender's reads or in the echo (and the message is still sent)
  07 together with the blocked count: both keys, neither overwrites the other, in the answer and on the sender's later reads
  08 an agent that sends: the answer carries it, the agent's own read carries it, a person's does not
  09 a channel: an agent that lost the project (its seat outlived the access) is «not delivered» — the same fact the read rule gives (it reads nothing)
  10 an agent the send holds back after the router (`blocked_agent_ids` — a command its runtime cannot take) is «not delivered» though the router decided it
  11 the shape is closed: three keys, ids as strings, the sender in none of them
"""
from __future__ import annotations

import asyncio
import uuid

import pytest

from tests.test_1994_backlink_api_realdb import (
    _client_for,
    _make_agent_member,
    _make_conversation,
    _make_human_member,
    _make_org,
    _make_project,
    _session_factory,
    _setup_app_agent,
    _setup_app_human,
)
from tests.test_4752_account_delete_realdb import (  # noqa: F401 — fixtures used by name
    _REAL_DB_URL,
    _dispose_global_engine_after_test,
    _no_rate_limit,
)
from tests.test_5032_channel_residual_access_realdb import (  # noqa: F401 — `_world` is a fixture-like helper used by the channel test
    _H,
    _add_agent,
    _add_person,
    _close,
    _owner_and_channel,
    _q,
    _reads,
    _world,
)

pytestmark = [
    pytest.mark.skipif(not _REAL_DB_URL, reason="real Postgres 필요"),
    pytest.mark.anyio,
]

KEY = "delivery_decision"


@pytest.fixture
def anyio_backend():
    return "asyncio"


async def _as(app, Session, user_id, org_id, fn, *, agent: bool = False):
    if agent:
        await _setup_app_agent(app, Session, user_id, org_id)
    else:
        await _setup_app_human(app, Session, user_id, org_id)
    try:
        async with _client_for(app) as client:
            return await fn(client)
    finally:
        app.dependency_overrides.clear()


async def _room(Session, *, people: int = 2, agents: int = 2, conv_type: str = "group"):
    """an org with a project, `people` people, `agents` agents, and one room of all of them; the first person is the sender."""
    async with Session() as s:
        org = await _make_org(s)
        project = await _make_project(s, org.id)
        humans = [await _make_human_member(s, org.id, project.id) for _ in range(people)]
        bots = [await _make_agent_member(s, org.id, project.id) for _ in range(agents)]
        conv = await _make_conversation(s, org.id, project.id, [h[0] for h in humans] + bots, humans[0][0], conv_type=conv_type)
    return org.id, conv, humans, bots


def _say(conv, words="hello", **extra):
    async def _go(c):
        return await c.post(f"/api/v2/conversations/{conv}/messages", json={"content": words, **extra})
    return _go


def _decision(agents_delivered=(), agents_not_delivered=(), humans=0) -> dict:
    return {
        "agents_delivered": sorted(str(a) for a in agents_delivered),
        "agents_not_delivered": sorted(str(a) for a in agents_not_delivered),
        "humans_delivered": humans,
    }


async def _list(app, Session, who, org, conv, **kw) -> list[dict]:
    r = await _as(app, Session, who, org, lambda c: c.get(f"/api/v2/conversations/{conv}/messages"), **kw)
    assert r.status_code == 200, r.text
    return r.json()["data"]


def _open_connections(member_id) -> asyncio.Queue:
    from app.routers import events as ev

    q: asyncio.Queue = asyncio.Queue(maxsize=100)
    ev._agent_connections[str(member_id)].add(q)
    return q


def _close_connections(*member_ids) -> None:
    from app.routers import events as ev

    for mid in member_ids:
        ev._agent_connections.pop(str(mid), None)


def _frames(q: asyncio.Queue, msg_id: str) -> list[dict]:
    out = []
    while not q.empty():
        f = q.get_nowait()
        if f.get("event_type") == "conversation.message_created" and f.get("id") == msg_id:
            out.append(f)
    return out


async def test_01_a_group_line_that_calls_nobody_reaches_no_agent_and_one_other_person():
    engine, Session = await _session_factory()
    try:
        org, conv, humans, bots = await _room(Session)
        from app.main import app

        sent = await _as(app, Session, humans[0][1], org, _say(conv, "no one is called"))
        assert sent.status_code == 201, sent.text
        assert sent.json()[KEY] == _decision(agents_not_delivered=bots, humans=1), sent.json()
    finally:
        await engine.dispose()


async def test_02_a_line_that_calls_one_agent_reaches_that_agent_only():
    engine, Session = await _session_factory()
    try:
        org, conv, humans, bots = await _room(Session)
        from app.main import app

        sent = await _as(app, Session, humans[0][1], org, _say(conv, "you there?", mentioned_ids=[str(bots[0])]))
        assert sent.status_code == 201, sent.text
        assert sent.json()[KEY] == _decision(agents_delivered=[bots[0]], agents_not_delivered=[bots[1]], humans=1), sent.json()
    finally:
        await engine.dispose()


async def test_03_a_one_to_one_with_an_agent_delivers_to_it():
    engine, Session = await _session_factory()
    try:
        org, conv, humans, bots = await _room(Session, people=1, agents=1, conv_type="dm")
        from app.main import app

        sent = await _as(app, Session, humans[0][1], org, _say(conv, "hi"))
        assert sent.status_code == 201, sent.text
        assert sent.json()[KEY] == _decision(agents_delivered=[bots[0]], humans=0), sent.json()
    finally:
        await engine.dispose()


async def test_04_an_agent_that_muted_the_room_is_not_delivered_even_when_called():
    engine, Session = await _session_factory()
    try:
        org, conv, humans, bots = await _room(Session)
        from app.models.notification_preference import NotificationPreference

        async with Session() as s:
            s.add(NotificationPreference(
                id=uuid.uuid4(), member_id=bots[0], scope_type="conversation", scope_id=conv, channel="sse", level="mute",
            ))
            await s.commit()
        from app.main import app

        sent = await _as(app, Session, humans[0][1], org, _say(conv, "both called", mentioned_ids=[str(bots[0]), str(bots[1])]))
        assert sent.status_code == 201, sent.text
        assert sent.json()[KEY] == _decision(agents_delivered=[bots[1]], agents_not_delivered=[bots[0]], humans=1), sent.json()
    finally:
        await engine.dispose()


async def test_05_only_the_sender_ever_sees_it_in_reads_and_echo():
    engine, Session = await _session_factory()
    try:
        org, conv, humans, bots = await _room(Session)
        (sender, sender_user), (other, other_user) = humans
        from app.main import app

        mine, theirs = _open_connections(sender), _open_connections(other)
        try:
            sent = await _as(app, Session, sender_user, org, _say(conv, "root", client_nonce="n-1"))
            assert sent.status_code == 201, sent.text
            msg_id = sent.json()["data"]["id"]
            expected = _decision(agents_not_delivered=bots, humans=1)

            # the echo to the sender's other tabs carries it · the person who received the line does not
            [echo] = _frames(mine, msg_id)
            assert echo.get(KEY) == expected, echo
            [their_frame] = _frames(theirs, msg_id)
            assert KEY not in their_frame, their_frame
        finally:
            _close_connections(sender, other)

        reply = await _as(app, Session, sender_user, org, _say(conv, "a reply", thread_id=msg_id))
        assert reply.status_code == 201, reply.text

        async def one(c):
            return await c.get(f"/api/v2/conversations/{conv}/messages/{msg_id}")

        async def replies(c):
            return await c.get(f"/api/v2/conversations/{conv}/messages/{msg_id}/replies")

        # the sender: list · single · replies (the reply's own decision)
        s_rows = await _list(app, Session, sender_user, org, conv)
        assert _row_of(s_rows, msg_id)[KEY] == expected, s_rows
        s_one = await _as(app, Session, sender_user, org, one)
        assert s_one.json()[KEY] == expected, s_one.json()
        s_replies = (await _as(app, Session, sender_user, org, replies)).json()["data"]
        assert next(m for m in s_replies if m["id"] == reply.json()["data"]["id"])[KEY] == _decision(agents_not_delivered=bots, humans=1)

        # everybody else: the key is not there at all (not null, not empty) — a person who received it, and an agent that did not
        o_rows = await _list(app, Session, other_user, org, conv)
        assert KEY not in next(m for m in o_rows if m["id"] == msg_id), o_rows
        o_one = await _as(app, Session, other_user, org, one)
        assert KEY not in o_one.json(), o_one.json()
        assert all(KEY not in m for m in (await _as(app, Session, other_user, org, replies)).json()["data"])
        a_rows = await _list(app, Session, bots[0], org, conv, agent=True)
        assert all(KEY not in m for m in a_rows), a_rows
        # …and the raw metadata is not served either
        assert all(KEY not in (m.get("metadata") or {}) for m in o_rows)
    finally:
        await engine.dispose()


async def test_06_a_failed_precheck_reports_nothing_and_the_line_is_still_sent(monkeypatch):
    engine, Session = await _session_factory()
    try:
        org, conv, humans, bots = await _room(Session)
        (sender, sender_user), (other, _other_user) = humans
        from app.main import app
        from app.services import channel_router

        async def broken(*_a, **_k):
            raise channel_router.ChannelRouterError("router down")

        monkeypatch.setattr(channel_router, "route_message", broken)
        mine = _open_connections(sender)
        try:
            sent = await _as(app, Session, sender_user, org, _say(conv, "router is down"))
            assert sent.status_code == 201, sent.text
            assert KEY not in sent.json(), sent.json()  # not «{agents_delivered: [], humans_delivered: 0}» — it is unknown
            msg_id = sent.json()["data"]["id"]
            [echo] = _frames(mine, msg_id)
            assert KEY not in echo, echo
        finally:
            _close_connections(sender, other)
        assert KEY not in _row_of(await _list(app, Session, sender_user, org, conv), msg_id)
        assert await _q_count(Session, msg_id) == 1, "the line was stored"
    finally:
        await engine.dispose()


def _row_of(rows: list[dict], msg_id) -> dict:
    return next(m for m in rows if m["id"] == msg_id)


async def _q_count(Session, msg_id) -> int:
    from sqlalchemy import text

    async with Session() as s:
        return (await s.execute(text("SELECT count(*) FROM conversation_messages WHERE id = :i"), {"i": msg_id})).scalar_one()


async def test_07_the_blocked_count_and_the_decision_live_side_by_side_neither_overwrites_the_other():
    engine, Session = await _session_factory()
    try:
        org, conv, humans, bots = await _room(Session, people=3, agents=1)
        (sender, sender_user), (blocker, blocker_user), (other, _other_user) = humans
        from app.main import app

        blocked = await _as(app, Session, blocker_user, org,
                            lambda c: c.post("/api/v2/user-blocks", json={"blocked_member_id": str(sender)}))
        assert blocked.status_code == 201, blocked.text
        sent = await _as(app, Session, sender_user, org, _say(conv, "after the block"))
        assert sent.status_code == 201, sent.text
        body = sent.json()
        withheld = {"withheld_count": 1, "reason": "recipient_blocked_sender", "conversation_type": "group"}
        assert body["delivery"] == withheld, body  # the old key is as it was
        assert body[KEY] == _decision(agents_not_delivered=bots, humans=1), body  # the blocker is not counted as delivered, the other person is
        msg_id = body["data"]["id"]
        row = _row_of(await _list(app, Session, sender_user, org, conv), msg_id)
        assert row["delivery_withheld"] == withheld and row[KEY] == _decision(agents_not_delivered=bots, humans=1), row
        # the blocker sees neither
        b_row = _row_of(await _list(app, Session, blocker_user, org, conv), msg_id)
        assert "delivery_withheld" not in b_row and KEY not in b_row, b_row
    finally:
        await engine.dispose()


async def test_08_an_agent_that_sends_gets_it_in_the_answer_and_its_own_read_and_a_person_does_not():
    engine, Session = await _session_factory()
    try:
        org, conv, humans, bots = await _room(Session)
        (_sender, person_user) = humans[0]
        from app.main import app

        sent = await _as(app, Session, bots[0], org, _say(conv, "from an agent", mentioned_ids=[str(bots[1])]), agent=True)
        assert sent.status_code == 201, sent.text
        # the other agent is called; the two people hear an agent's line (no mute · «all» for a person)
        assert sent.json()[KEY] == _decision(agents_delivered=[bots[1]], humans=2), sent.json()
        msg_id = sent.json()["data"]["id"]
        assert _row_of(await _list(app, Session, bots[0], org, conv, agent=True), msg_id)[KEY] == sent.json()[KEY]
        assert KEY not in _row_of(await _list(app, Session, person_user, org, conv), msg_id)
    finally:
        await engine.dispose()


async def test_09_in_a_channel_an_agent_whose_seat_outlived_its_project_is_not_delivered_and_reads_nothing():
    engine, w = await _world()
    try:
        org, ot, pid, chan = await _owner_and_channel(w)
        _uid, person_seat, _mt = await _add_person(w, org, ot, pid)
        kept, kept_headers = await _add_agent(w, org, ot, pid)
        lost, lost_headers = await _add_agent(w, org, ot, pid)
        # the project access goes behind the unseat's back: the participant row stays (the state the channel rule exists for)
        await w.sql("DELETE FROM project_access WHERE project_id = :p AND member_id = :a", p=pid, a=lost)
        assert lost in {r[0] for r in await _q(w, "SELECT member_id FROM conversation_participants WHERE conversation_id = :c", c=chan)}
        owner_seat = (await _q(w, "SELECT m.id FROM members m JOIN org_members o ON o.id = m.id WHERE o.org_id = :o AND o.role = 'owner' AND m.name = 'Owner'", o=org))[0][0]

        r = await w.client.post(
            f"/api/v2/conversations/{chan}/messages", headers=_H(ot),
            json={"content": "both called", "mentioned_ids": [str(kept), str(lost)]},
        )
        assert r.status_code == 201, r.text
        # the agent that still holds the project and was called is delivered; the one that lost it is not, whatever the router's reason; the one other person (the owner is the sender) is counted
        assert r.json()[KEY] == _decision(agents_delivered=[kept], agents_not_delivered=[lost], humans=1), r.json()
        assert str(owner_seat) not in str(r.json()[KEY]) and str(person_seat) not in str(r.json()[KEY])  # people are only counted
        # consistent with the read rule: the agent that is «not delivered» reads nothing of the channel; the delivered one reads it
        assert 200 not in await _reads(w, lost_headers, chan), "an agent that lost the project read the channel"
        assert await _reads(w, kept_headers, chan) == (200, 200)
        # the sender's later read carries the same decision
        rows = (await w.client.get(f"/api/v2/conversations/{chan}/messages", headers=_H(ot))).json()["data"]
        assert next(m for m in rows if m["id"] == r.json()["data"]["id"])[KEY] == r.json()[KEY]
    finally:
        await _close(engine, w)


async def test_10_an_agent_the_send_holds_back_after_the_router_is_not_delivered(monkeypatch):
    """the router decided the called agent; then `_command_capability_gate` (a slash command its runtime cannot take) holds it back from the delivery — the report must say what happened, not what the router first said."""
    engine, Session = await _session_factory()
    try:
        org, conv, humans, bots = await _room(Session)
        from app.main import app
        from app.routers import conversations as conv_mod

        async def hold(db, conv_, msg, sender, org_id):
            return {bots[0]}, []

        monkeypatch.setattr(conv_mod, "_command_capability_gate", hold)
        sent = await _as(app, Session, humans[0][1], org, _say(conv, "called", mentioned_ids=[str(bots[0]), str(bots[1])]))
        assert sent.status_code == 201, sent.text
        assert sent.json()[KEY] == _decision(agents_delivered=[bots[1]], agents_not_delivered=[bots[0]], humans=1), sent.json()
    finally:
        await engine.dispose()


async def test_11_the_shape_is_closed_ids_as_strings_and_the_sender_is_in_none_of_them():
    engine, Session = await _session_factory()
    try:
        org, conv, humans, bots = await _room(Session)
        from app.main import app

        sent = await _as(app, Session, humans[0][1], org, _say(conv, "shape", mentioned_ids=[str(bots[1])]))
        got = sent.json()[KEY]
        assert set(got) == {"agents_delivered", "agents_not_delivered", "humans_delivered"}, got
        assert all(isinstance(i, str) for i in got["agents_delivered"] + got["agents_not_delivered"])
        assert isinstance(got["humans_delivered"], int) and not isinstance(got["humans_delivered"], bool)
        assert str(humans[0][0]) not in str(got) and str(humans[1][0]) not in str(got)  # nobody who is a person is named
        # a room with only the sender in it: all zero, still reported (the router decided: nobody)
        async with Session() as s:
            org2 = await _make_org(s)
            project2 = await _make_project(s, org2.id)
            solo, solo_user = await _make_human_member(s, org2.id, project2.id)
            conv2 = await _make_conversation(s, org2.id, project2.id, [solo], solo, conv_type="group")
        alone = await _as(app, Session, solo_user, org2.id, _say(conv2, "talking to myself"))
        assert alone.status_code == 201, alone.text
        assert alone.json()[KEY] == _decision(), alone.json()
    finally:
        await engine.dispose()
