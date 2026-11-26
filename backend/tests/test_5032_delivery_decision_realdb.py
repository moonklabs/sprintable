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
    _make_org_owner,
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


# ── the report rests on what the router saw (codex 8555c7136: other-organization / deleted rows · alias people · one snapshot) ──


async def _plant_participant(Session, conv, member_id) -> None:
    """a participant row put in by hand (the table has no member foreign key — a legacy row, a bridge mapping, a road that skipped the org check)."""
    from app.models.conversation import ConversationParticipant

    async with Session() as s:
        s.add(ConversationParticipant(conversation_id=conv, member_id=member_id))
        await s.commit()


async def test_12_an_agent_row_of_another_organization_is_never_reported():
    engine, Session = await _session_factory()
    try:
        org, conv, humans, bots = await _room(Session)
        async with Session() as s:
            other_org = await _make_org(s)
            other_project = await _make_project(s, other_org.id)
            stranger = await _make_agent_member(s, other_org.id, other_project.id)
        await _plant_participant(Session, conv, stranger)
        from app.main import app

        sent = await _as(app, Session, humans[0][1], org, _say(conv, "who is in here", mentioned_ids=[str(stranger)]))
        assert sent.status_code == 201, sent.text
        assert sent.json()[KEY] == _decision(agents_not_delivered=bots, humans=1), sent.json()
        assert str(stranger) not in str(sent.json()[KEY])
        row = _row_of(await _list(app, Session, humans[0][1], org, conv), sent.json()["data"]["id"])
        assert str(stranger) not in str(row[KEY]), row  # nor kept on the line for the sender's later reads
    finally:
        await engine.dispose()


async def test_13_a_deleted_agent_is_never_reported():
    engine, Session = await _session_factory()
    try:
        org, conv, humans, bots = await _room(Session)
        from sqlalchemy import text

        async with Session() as s:
            await s.execute(text("UPDATE members SET deleted_at = now() WHERE id = :m"), {"m": bots[0]})
            await s.commit()
        from app.main import app

        sent = await _as(app, Session, humans[0][1], org, _say(conv, "after the agent was deleted"))
        assert sent.status_code == 201, sent.text
        assert sent.json()[KEY] == _decision(agents_not_delivered=[bots[1]], humans=1), sent.json()
        assert str(bots[0]) not in str(sent.json()[KEY])
    finally:
        await engine.dispose()


async def test_14_a_person_stored_under_an_old_alias_id_is_counted_as_delivered():
    """a participant row under the legacy id of a person (`member_identity_aliases`): the router resolves it to the canonical id and decides for THAT id, so the report counts from the decisions —
    matched against the raw row it never equals and the count fell short (and an org_member with no `members` anchor is a person too)."""
    engine, Session = await _session_factory()
    try:
        org, conv, humans, bots = await _room(Session, people=2, agents=1)
        (_sender, sender_user), (aliased, _aliased_user) = humans
        from sqlalchemy import text

        legacy = uuid.uuid4()
        async with Session() as s:
            await s.execute(text("DELETE FROM conversation_participants WHERE conversation_id = :c AND member_id = :m"), {"c": conv, "m": aliased})
            await s.execute(
                text("INSERT INTO member_identity_aliases (alias_id, member_id, org_id, alias_source) VALUES (:a, :m, :o, 'human_team_member')"),
                {"a": legacy, "m": aliased, "o": org},
            )
            await s.commit()
        await _plant_participant(Session, conv, legacy)
        from app.main import app

        sent = await _as(app, Session, sender_user, org, _say(conv, "to the person under the old id"))
        assert sent.status_code == 201, sent.text
        assert sent.json()[KEY] == _decision(agents_not_delivered=bots, humans=1), sent.json()
        assert str(legacy) not in str(sent.json()[KEY]) and str(aliased) not in str(sent.json()[KEY])
    finally:
        await engine.dispose()


async def test_15_a_person_with_only_an_org_member_row_is_counted():
    engine, Session = await _session_factory()
    try:
        org, conv, humans, bots = await _room(Session, people=1, agents=1)
        from app.models.project import OrgMember
        from app.models.user import User

        grant_only = uuid.uuid4()
        uid = uuid.uuid4()
        async with Session() as s:
            s.add(User(id=uid, email=f"go-{uid.hex[:8]}@test.com", hashed_password="x"))
            await s.commit()
            s.add(OrgMember(id=grant_only, org_id=org, user_id=uid, role="member"))  # no `members` anchor, no project access
            await s.commit()
        await _plant_participant(Session, conv, grant_only)
        from app.main import app

        sent = await _as(app, Session, humans[0][1], org, _say(conv, "to a grant-only person"))
        assert sent.status_code == 201, sent.text
        assert sent.json()[KEY] == _decision(agents_not_delivered=bots, humans=1), sent.json()
    finally:
        await engine.dispose()


async def test_16_an_inactive_agent_follows_the_routers_own_rule():
    """an inactive agent no longer holds the room's project (`has_project_access` asks `is_active`), so the router cuts it from a room that has one: it is in the room, called, and NOT delivered — reported as such
    (the same line as an agent that lost the project), while an active agent called in the same line is delivered."""
    engine, Session = await _session_factory()
    try:
        org, conv, humans, bots = await _room(Session)
        from sqlalchemy import text

        async with Session() as s:
            await s.execute(text("UPDATE members SET is_active = false WHERE id = :m"), {"m": bots[0]})
            await s.commit()
        from app.main import app

        sent = await _as(app, Session, humans[0][1], org, _say(conv, "both called", mentioned_ids=[str(bots[0]), str(bots[1])]))
        assert sent.status_code == 201, sent.text
        assert sent.json()[KEY] == _decision(agents_delivered=[bots[1]], agents_not_delivered=[bots[0]], humans=1), sent.json()
    finally:
        await engine.dispose()


async def test_17_an_agent_the_router_delivered_is_reported_even_if_the_participant_read_lagged_behind():
    """the delivered side always comes from the router itself: an agent in its decisions that the participant snapshot does not hold (added in the instant between the two reads) is still «delivered»,
    and the sender is taken out under its alias id too."""
    engine, Session = await _session_factory()
    try:
        org, conv, humans, bots = await _room(Session, people=1, agents=2)
        from sqlalchemy import text

        from app.routers.conversations import _delivery_decision_of

        legacy_sender = uuid.uuid4()
        async with Session() as s:
            await s.execute(
                text("INSERT INTO member_identity_aliases (alias_id, member_id, org_id, alias_source) VALUES (:a, :m, :o, 'human_team_member')"),
                {"a": legacy_sender, "m": humans[0][0], "o": org},
            )
            await s.commit()
            got = await _delivery_decision_of(s, org, humans[0][0], {bots[1], legacy_sender}, {bots[0], humans[0][0]}, set())
        # the sender is in the router's ids under its own id and in the snapshot under the alias: in no list
        assert got == _decision(agents_delivered=[bots[0]], agents_not_delivered=[bots[1]], humans=0), got
        async with Session() as s:
            again = await _delivery_decision_of(s, org, legacy_sender, {bots[1]}, {bots[0], humans[0][0]}, set())
        assert again == _decision(agents_delivered=[bots[0]], agents_not_delivered=[bots[1]], humans=0), again  # a sender that comes in by the alias id is taken out as its canonical member
    finally:
        await engine.dispose()


# ── the stored key never leaves by any road but the sender's own read (PO: «look first») ──────────────────────────────────────────────


async def _tables_holding(Session, needle: str) -> set[str]:
    """every base table of the schema that holds `needle` in any row's text — the whole-database answer to «where else did the key get written»."""
    from sqlalchemy import text

    async with Session() as s:
        names = (await s.execute(text("SELECT table_name FROM information_schema.tables WHERE table_schema = 'public' AND table_type = 'BASE TABLE'"))).scalars().all()
        hits = set()
        for n in names:
            found = (await s.execute(text(f'SELECT 1 FROM "{n}" t WHERE t::text LIKE :p LIMIT 1'), {"p": f"%{needle}%"})).first()
            if found:
                hits.add(n)
    return hits


async def test_18_the_key_is_stored_on_the_line_only_and_no_other_reader_or_copy_of_the_line_carries_it(monkeypatch):
    """the fact first: the key IS in the column (`conversation_messages.metadata`) — so what keeps it from a recipient or an observer is the read paths, each pinned here. Read paths: the recipients' list · single ·
    replies · their live frames (a person's and an agent's connection) · an observer (an organization owner who is not in the room: the admin read) · the events / bell / activity / webhook-delivery rows (a whole-database
    scan: no table but the line itself holds the key) · the webhook job's arguments."""
    engine, Session = await _session_factory()
    try:
        org, conv, humans, bots = await _room(Session, people=3, agents=1)
        (sender, sender_user), (other, other_user), (third, third_user) = humans
        async with Session() as s:
            owner_id, owner_user = await _make_org_owner(s, org)
        from sqlalchemy import text

        import app.services.conversation_webhook as cw
        from app.main import app

        calls: list[dict] = []

        async def _capture(**kw):
            calls.append(kw)

        monkeypatch.setattr(cw, "deliver_conversation_message_webhook", _capture)
        conns = {m: _open_connections(m) for m in (sender, other, third, bots[0])}
        try:
            sent = await _as(app, Session, sender_user, org, _say(conv, "to the room", client_nonce="n-18"))
            assert sent.status_code == 201, sent.text
            msg_id = sent.json()["data"]["id"]
            assert sent.json()[KEY] == _decision(agents_not_delivered=bots, humans=2)
            assert "data" in sent.json() and KEY not in sent.json()["data"]  # the answer's message copy has no key — it rides at the top level
            frames = {m: _frames(q, msg_id) for m, q in conns.items()}
        finally:
            _close_connections(sender, other, third, bots[0])

        # 1 · the key is stored on the line (and so the readers below are what hide it)
        async with Session() as s:
            stored = (await s.execute(text("SELECT metadata -> 'delivery_decision' FROM conversation_messages WHERE id = :i"), {"i": msg_id})).scalar_one()
        assert stored == _decision(agents_not_delivered=bots, humans=2), stored
        # 2 · only the sender's own live frame has it; a person's and an agent's connection of someone else do not
        assert [f.get(KEY) for f in frames[sender]] == [_decision(agents_not_delivered=bots, humans=2)]
        for who in (other, third, bots[0]):
            assert all(KEY not in f for f in frames[who]), (who, frames[who])
        # 3 · recipients and the observer read the line by every route: no key
        await _as(app, Session, sender_user, org, _say(conv, "a reply", thread_id=msg_id))
        for user in (other_user, third_user, owner_user):
            async def reads(c):
                return (await c.get(f"/api/v2/conversations/{conv}/messages"),
                        await c.get(f"/api/v2/conversations/{conv}/messages/{msg_id}"),
                        await c.get(f"/api/v2/conversations/{conv}/messages/{msg_id}/replies"))
            listing, single, replies = await _as(app, Session, user, org, reads)
            if user is not owner_user:  # a room participant reads all three; the organization owner who is not in the room is turned away by the participant gate (403) — either way no key
                assert (listing.status_code, single.status_code, replies.status_code) == (200, 200, 200), (listing.text, single.text, replies.text)
            assert KEY not in listing.text and KEY not in single.text and KEY not in replies.text, "the key left by a read of someone who is not the sender"
        # 4 · the bot reads (an agent's own key)
        assert KEY not in (await _as(app, Session, bots[0], org, lambda c: c.get(f"/api/v2/conversations/{conv}/messages"), agent=True)).text
        # 5 · nothing else was written with it: events · activity · bell · webhook deliveries · … (every table but the line)
        assert await _tables_holding(Session, KEY) == {"conversation_messages"}
        # 6 · the webhook job is handed fields, not the line's metadata
        assert calls and all(KEY not in repr(c) for c in calls), calls
    finally:
        await engine.dispose()


async def test_19_a_deleted_line_serves_no_decision_even_to_its_sender():
    engine, Session = await _session_factory()
    try:
        org, conv, humans, bots = await _room(Session)
        (_sender, sender_user) = humans[0]
        from app.main import app

        sent = await _as(app, Session, sender_user, org, _say(conv, "to be taken back"))
        msg_id = sent.json()["data"]["id"]
        assert _row_of(await _list(app, Session, sender_user, org, conv), msg_id)[KEY]  # alive: the sender has it
        gone = await _as(app, Session, sender_user, org, lambda c: c.delete(f"/api/v2/conversations/{conv}/messages/{msg_id}"))
        assert gone.status_code == 200, gone.text
        tomb = _row_of(await _list(app, Session, sender_user, org, conv), msg_id)
        assert tomb["deleted_at"] is not None and KEY not in tomb, tomb
        single = await _as(app, Session, sender_user, org, lambda c: c.get(f"/api/v2/conversations/{conv}/messages/{msg_id}"))
        assert KEY not in single.text, single.text
    finally:
        await engine.dispose()


def test_20_no_code_path_dumps_or_copies_the_whole_metadata_column():
    """the audit of «who serialises or copies `msg_metadata` whole», kept as a ratchet: every use of the column in `app/` is a KEYED read (`["k"]` · `.get("k")`), a write, a merge into the same line, or one of the few
    named exceptions; every new row's metadata is a literal the code builds (never another row's); no ORM line is dumped by `jsonable_encoder` / `_mapping` / `__table__` / `asdict`; raw SQL reads `metadata ->` only.
    A new road that sends the stored `delivery_decision` / `delivery_withheld` out (they are the sender's alone) fails here and must go through `_msg_payload`'s sender rule or filter them."""
    import ast
    import re
    from pathlib import Path

    import app as app_pkg

    root = Path(app_pkg.__file__).parent
    bad: list[str] = []
    merge_files = {"routers/conversations.py", "services/approval_delivery.py"}  # `{**(msg.msg_metadata or {}), K: v}` onto the SAME line / `**existing_root.msg_metadata` back onto the SAME row
    for path in sorted(root.rglob("*.py")):
        rel = path.relative_to(root).as_posix()
        src = path.read_text()
        tree = ast.parse(src)
        parent: dict[int, ast.AST] = {}
        for p in ast.walk(tree):
            for c in ast.iter_child_nodes(p):
                parent[id(c)] = p
        for node in ast.walk(tree):
            # new rows: the metadata of a `ConversationMessage(...)` is built here, never taken from another row
            if isinstance(node, ast.Call) and getattr(node.func, "id", getattr(node.func, "attr", None)) == "ConversationMessage":
                for kw in node.keywords:
                    if kw.arg == "msg_metadata":
                        v = kw.value
                        ok = isinstance(v, (ast.Dict, ast.Constant)) or (isinstance(v, ast.Name) and v.id == "msg_metadata_val") \
                            or (isinstance(v, ast.Call) and getattr(v.func, "id", "") == "_combined_msg_metadata")
                        if not ok:
                            bad.append(f"{rel}:{node.lineno} a new line takes its metadata from {ast.dump(v)[:60]}")
            if not (isinstance(node, ast.Attribute) and node.attr == "msg_metadata"):
                continue
            if isinstance(node.ctx, ast.Store):
                continue
            p = parent[id(node)]
            while isinstance(p, ast.BoolOp):  # `(x.msg_metadata or {})`
                node, p = p, parent[id(p)]
            if isinstance(p, ast.Subscript) and p.value is node:
                continue  # ["key"]
            if isinstance(p, ast.Attribute) and p.attr == "get":
                call = parent[id(p)]
                if isinstance(call, ast.Call) and call.args and isinstance(call.args[0], ast.Constant) and isinstance(call.args[0].value, str):
                    continue  # .get("key")
            if isinstance(p, ast.Attribute) and p.attr == "label" and rel == "services/backlinks.py":
                continue  # the select of the column whose `event` key alone is read
            if isinstance(p, ast.Dict) and rel in merge_files and any(k is None and v is node for k, v in zip(p.keys, p.values)):
                continue
            if isinstance(p, ast.UnaryOp) and isinstance(p.op, ast.Not):
                continue  # `not x.msg_metadata`
            if isinstance(p, ast.Call) and getattr(p.func, "id", "") == "isinstance":
                continue
            if isinstance(p, ast.Call) and getattr(p.func, "id", "") == "_chat_message_event_summary" and rel == "services/backlinks.py":
                continue  # reads `.get("event")` only
            bad.append(f"{rel}:{node.lineno} reads the whole stored metadata")
        if "ConversationMessage" in src:
            for m in re.finditer(r"jsonable_encoder\(|\._mapping\b|ConversationMessage\.__table__\b|\basdict\(", src):
                bad.append(f"{rel} dumps a row whole near offset {m.start()}")
        for m in re.finditer(r"conversation_messages\.metadata(?!\s*->)", src):
            bad.append(f"{rel} raw SQL reads the whole metadata column near offset {m.start()}")
    assert not bad, "\n".join(bad)
