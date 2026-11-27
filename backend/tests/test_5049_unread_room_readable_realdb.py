"""story 5049 (PR 2 · «unread») — the bell counts, lists and «reads all» a room's WORDS only for someone who reads that room now. Real Postgres, real tokens, the real routes.

Before: the bell's `unread-count` / list counted every `events` row of the person — a person who lost a project channel (or was taken out of a room) went on counting the room's lines, while the chat's own total
(`conversations/unread-count`, from the person's participant rows) already counted readable rooms alone. Now one definition (`event_room_gate.room_words_lines_readable_clause` — the 4870 read predicate) shares the bell's
count, list and read-all, and every road that takes a person out of a channel marks their unread lines of it read in the SAME transaction. A MENTION line is left exactly as it was (4846 AC9: a person named from outside a room
sees who named them and where; the words are withheld by the gate, the line stays and counts).

  01 readable room: the bell counts every line (3 words-lines + the mention) and the chat total agrees           — channel · group · DM
  02 a seat that outlived its access (no unseat ran): the bell shows the mention only, counts it only, `read-all` leaves the hidden lines UNREAD, and the lines come back when the access does
  03 a proper revoke (unseat): the person's unread words-lines of the channel are read in that transaction; the mention is not; other people and other rooms are not touched
  04 the revoke that rolls back takes the read-marking with it
  05 taken out of a plain room / DM: not counted, not listed (the room is not readable); chat total 0 — already right, pinned
  06 removed from the organization: the channel's lines are read with the seat
  07 the project is deleted: nobody keeps an unread line of its channel
  08 `read-all` marks what is shown and leaves the unreadable room's lines alone
  09 the helper marks only a room's words-lines of the given people (never a mention, never another kind of notification, never an already-read time)
  10 a notification that is not about a room is counted as before
  11 a `dispatched` row with no entity type (NULL) or another kind is never taken for a room's words — counted, listed and read by `read-all` (SQL three-valued logic); the room's own copy follows the room
  12 the helper is narrowed to the rooms' organization and touches only UNREAD words-lines (another organization's row naming the same room id is left alone)
"""
from __future__ import annotations

import uuid

import pytest
from sqlalchemy import text

from tests.test_4752_account_delete_realdb import (  # noqa: F401 — fixtures used by name
    _REAL_DB_URL,
    _dispose_global_engine_after_test,
    _no_rate_limit,
)
from tests.test_5032_channel_residual_access_realdb import (  # noqa: F401
    _H,
    _add_person,
    _close,
    _owner_and_channel,
    _q,
    _remove,
    _say,
    _world,
)

pytestmark = [
    pytest.mark.skipif(not _REAL_DB_URL, reason="real Postgres 필요"),
    pytest.mark.anyio,
]


@pytest.fixture
def anyio_backend():
    return "asyncio"


WORDS = ("conversation.message_created", "conversation.human_intervention_requested")


async def _room(w, org, pid, owner, a, kind) -> uuid.UUID:
    rid = uuid.uuid4()
    key = f"{min(owner, a)}:{max(owner, a)}" if kind == "dm" else None
    await w.sql(
        "INSERT INTO conversations (id, org_id, project_id, type, status, title, dm_pair_key) VALUES (:i, :o, :p, :t, 'open', :ti, :k)",
        i=rid, o=org, p=pid, t="dm" if kind == "dm" else "group", ti=None if kind == "dm" else "plain", k=key,
    )
    for m in (owner, a):
        await w.sql("INSERT INTO conversation_participants (id, conversation_id, member_id) VALUES (gen_random_uuid(), :c, :m)", c=rid, m=m)
    return rid


class _S:
    """one scene: an organization, its owner, a person A and a room of the asked kind that holds 3 unread lines and 1 mention for A."""


async def _scene(w, kind: str, name: str = "P") -> _S:
    s = _S()
    s.org, s.ot, s.pid, chan = await _owner_and_channel(w, name)
    s.owner = (await _q(w, "SELECT m.id FROM members m JOIN org_members o ON o.id = m.id WHERE o.org_id = :o AND o.role = 'owner' AND m.name = 'Owner'", o=s.org))[0][0]
    s.uid, s.a, s.ta = await _add_person(w, s.org, s.ot, s.pid)
    s.chan = chan
    s.room = chan if kind == "channel" else await _room(w, s.org, s.pid, s.owner, s.a, kind)
    if kind != "dm":  # A speaks once — a group line is not a spectator's line then
        r = await w.client.post(f"/api/v2/conversations/{s.room}/messages", headers=_H(s.ta), json={"content": "A speaks"})
        assert r.status_code == 201, r.text
    for i in range(3):
        await _say(w, s.ot, s.room, f"line {i}")
    s.mention_msg, _, _ = await _say(w, s.ot, s.room, "mention A", mention=[s.a])
    return s


async def _nums(w, tok) -> dict:
    bell = (await w.client.get("/api/v2/event-notifications/unread-count", headers=_H(tok))).json()["count"]
    chat = (await w.client.get("/api/v2/conversations/unread-count", headers=_H(tok))).json()["count"]
    rows = (await w.client.get("/api/v2/event-notifications?limit=100", headers=_H(tok))).json()
    unread = [r for r in rows if r["read_at"] is None]
    return {"bell": bell, "chat": chat, "listed": len(unread), "kinds": sorted({r["event_type"] for r in unread})}


async def _db_unread(w, a) -> dict:
    return {k: n for k, n in await _q(w, "SELECT event_type, count(*) FROM events WHERE recipient_id = :a AND read_at IS NULL GROUP BY 1", a=a)}


@pytest.mark.parametrize("kind", ["channel", "group", "dm"])
async def test_01_a_readable_room_is_counted_by_the_bell_and_the_chat_alike(kind):
    engine, w = await _world()
    try:
        s = await _scene(w, kind, f"P1{kind}")
        n = await _nums(w, s.ta)
        # 3 lines + the mention; the chat counts the 4 messages
        assert (n["bell"], n["listed"], n["chat"]) == (4, 4, 4), n
        assert "conversation:mention" in n["kinds"]
    finally:
        await _close(engine, w)


async def test_02_a_seat_that_outlived_its_access_is_not_counted_listed_or_read_by_read_all_and_comes_back_with_the_access():
    engine, w = await _world()
    try:
        s = await _scene(w, "channel", "P2")
        await w.sql("DELETE FROM project_access WHERE project_id = :p AND org_member_id = :s", p=s.pid, s=s.a)  # the failed-unseat state: the seat stays, the access is gone
        n = await _nums(w, s.ta)
        assert (n["bell"], n["listed"], n["chat"]) == (1, 1, 0), n  # the mention only (4846 AC9 — unchanged); the chat already counted nothing
        assert n["kinds"] == ["conversation:mention"]
        before = await _db_unread(w, s.a)
        ra = await w.client.patch("/api/v2/event-notifications/read-all", headers=_H(s.ta))
        assert ra.status_code == 200
        after = await _db_unread(w, s.a)
        assert after.get("conversation.message_created") == before.get("conversation.message_created") and before.get("conversation.message_created"), (before, after)  # never seen → not marked read
        assert "conversation:mention" not in after  # the shown line was read
        # the access comes back: the lines are there again
        r = await w.client.post(f"/api/v2/projects/{s.pid}/access", headers=_H(s.ot), json={"org_member_id": str(s.a)})
        assert r.status_code == 201, r.text
        n2 = await _nums(w, s.ta)
        assert n2["bell"] == 3 and n2["chat"] == 4, n2  # the 3 words-lines (the mention was read by read-all); the chat total comes back as well
    finally:
        await _close(engine, w)


async def test_03_a_proper_revoke_reads_the_persons_lines_of_the_channel_in_that_transaction_and_only_theirs():
    engine, w = await _world()
    try:
        s = await _scene(w, "channel", "P3")
        # a bystander in the same channel and a second room of A's: neither may change
        uid_b, b, tb = await _add_person(w, s.org, s.ot, s.pid)
        await w.client.post(f"/api/v2/conversations/{s.chan}/messages", headers=_H(tb), json={"content": "B speaks"})
        await _say(w, s.ot, s.chan, "after B spoke")
        other = await _room(w, s.org, s.pid, s.owner, s.a, "group")
        await w.client.post(f"/api/v2/conversations/{other}/messages", headers=_H(s.ta), json={"content": "A in the other room"})
        await _say(w, s.ot, other, "other room line")
        b_before, other_before = await _nums(w, tb), None
        a_before = await _nums(w, s.ta)
        acc = (await _q(w, "SELECT id FROM project_access WHERE project_id = :p AND org_member_id = :s", p=s.pid, s=s.a))[0][0]
        r = await w.client.delete(f"/api/v2/projects/{s.pid}/access/{acc}", headers=_H(s.ot))
        assert r.status_code == 200, r.text
        words = (await _q(w, "SELECT count(*) FROM events WHERE recipient_id = :a AND read_at IS NULL AND event_type = 'conversation.message_created' AND payload->>'conversation_id' = :c", a=s.a, c=str(s.chan)))[0][0]
        assert words == 0, "the channel's words-lines of the revoked person were left unread"
        mention = (await _q(w, "SELECT count(*) FROM events WHERE recipient_id = :a AND read_at IS NULL AND event_type = 'conversation:mention'", a=s.a))[0][0]
        assert mention == 1, "the mention must stay as it was"
        a_after = await _nums(w, s.ta)
        # what is left: the mention (never marked) and the other room's one line; the chat counts the other room's one line
        assert (a_after["bell"], a_after["listed"], a_after["chat"]) == (2, 2, 1), (a_before, a_after)
        assert await _nums(w, tb) == b_before, "someone else's count moved"
        # the other room's line is still A's, unread
        assert (await _q(w, "SELECT count(*) FROM events WHERE recipient_id = :a AND read_at IS NULL AND payload->>'conversation_id' = :c", a=s.a, c=str(other)))[0][0] >= 1
    finally:
        await _close(engine, w)


async def test_04_a_revoke_that_rolls_back_leaves_the_lines_unread():
    engine, w = await _world()
    try:
        from app.services.project_channel import unseat_from_project_channel

        s = await _scene(w, "channel", "P4")
        before = await _db_unread(w, s.a)
        async with w.Session() as session:
            await unseat_from_project_channel(session, project_id=s.pid, member_id=s.a)
            await session.rollback()
        assert await _db_unread(w, s.a) == before, "the read-marking survived a rolled-back revoke"
        assert s.a in {r[0] for r in await _q(w, "SELECT member_id FROM conversation_participants WHERE conversation_id = :c", c=s.chan)}
        async with w.Session() as session:
            await unseat_from_project_channel(session, project_id=s.pid, member_id=s.a)
            await session.commit()
        after = await _db_unread(w, s.a)
        assert after.get("conversation.message_created", 0) == 0 and after.get("conversation:mention") == 1, after
    finally:
        await _close(engine, w)


@pytest.mark.parametrize("kind", ["group", "dm"])
async def test_05_taken_out_of_a_plain_room_or_dm_is_not_counted_or_listed_the_chat_total_is_already_right(kind):
    engine, w = await _world()
    try:
        s = await _scene(w, kind, f"P5{kind}")
        assert (await _nums(w, s.ta))["chat"] == 4
        await w.sql("DELETE FROM conversation_participants WHERE conversation_id = :c AND member_id = :m", c=s.room, m=s.a)
        n = await _nums(w, s.ta)
        assert n["chat"] == 0, n  # the participant rows are what the chat counts from: right before this story, pinned now
        assert (n["bell"], n["listed"]) == (1, 1) and n["kinds"] == ["conversation:mention"], n  # the room's words are gone from the bell; the mention (4846 AC9) stays
    finally:
        await _close(engine, w)


async def test_06_removed_from_the_organization_the_channel_lines_are_read_with_the_seat():
    engine, w = await _world()
    try:
        s = await _scene(w, "channel", "P6")
        await _remove(w, s.ot, s.a)
        after = await _db_unread(w, s.a)
        assert after.get("conversation.message_created", 0) == 0, after
        assert after.get("conversation:mention") == 1  # untouched
        assert (await w.client.get("/api/v2/event-notifications/unread-count", headers=_H(s.ta))).status_code != 200  # and the person cannot read anything any more
    finally:
        await _close(engine, w)


async def test_07_a_deleted_project_leaves_nobody_an_unread_line_of_its_channel():
    engine, w = await _world()
    try:
        s = await _scene(w, "channel", "P7")
        r = await w.client.delete(f"/api/v2/projects/{s.pid}", headers=_H(s.ot))
        assert r.status_code == 200, r.text
        unread = (await _q(w, "SELECT count(*) FROM events WHERE read_at IS NULL AND event_type = 'conversation.message_created' AND payload->>'conversation_id' = :c", c=str(s.chan)))[0][0]
        assert unread == 0
        n = await _nums(w, s.ta)
        assert n["chat"] == 0 and n["kinds"] in ([], ["conversation:mention"]), n
    finally:
        await _close(engine, w)


async def test_08_read_all_marks_what_is_shown_and_leaves_an_unreadable_rooms_lines_alone():
    engine, w = await _world()
    try:
        s = await _scene(w, "channel", "P8")
        other = await _room(w, s.org, s.pid, s.owner, s.a, "group")
        await w.client.post(f"/api/v2/conversations/{other}/messages", headers=_H(s.ta), json={"content": "A in the other room"})
        await _say(w, s.ot, other, "other room line")
        await w.sql("DELETE FROM project_access WHERE project_id = :p AND org_member_id = :s", p=s.pid, s=s.a)  # the channel becomes unreadable (seat stays)
        chan_lines = "SELECT count(*) FROM events WHERE recipient_id = :a AND read_at IS NULL AND event_type = 'conversation.message_created' AND payload->>'conversation_id' = :c"
        chan_before = (await _q(w, chan_lines, a=s.a, c=str(s.chan)))[0][0]
        assert chan_before >= 3
        ra = await w.client.patch("/api/v2/event-notifications/read-all", headers=_H(s.ta))
        assert ra.status_code == 200
        assert (await _q(w, chan_lines, a=s.a, c=str(s.chan)))[0][0] == chan_before, "read-all marked the lines of a room the person cannot read"
        other_after = (await _q(w, "SELECT count(*) FROM events WHERE recipient_id = :a AND read_at IS NULL AND payload->>'conversation_id' = :c", a=s.a, c=str(other)))[0][0]
        assert other_after == 0, "read-all left a readable room's line unread"
    finally:
        await _close(engine, w)


async def test_09_the_helper_marks_only_a_rooms_words_lines_of_the_given_people_and_never_a_mention_or_another_notification():
    engine, w = await _world()
    try:
        from app.services.event_room_gate import mark_room_words_lines_read

        s = await _scene(w, "channel", "P9")
        uid_b, b, tb = await _add_person(w, s.org, s.ot, s.pid)
        await w.client.post(f"/api/v2/conversations/{s.chan}/messages", headers=_H(tb), json={"content": "B speaks"})
        await _say(w, s.ot, s.chan, "line for both")
        await w.sql(
            "INSERT INTO events (id, org_id, event_type, source_entity_type, source_entity_id, recipient_id, recipient_type, payload, status) "
            "VALUES (gen_random_uuid(), :o, 'story.assigned', 'story', gen_random_uuid(), :a, 'human', '{}'::jsonb, 'pending')", o=s.org, a=s.a)
        b_before = await _db_unread(w, b)
        async with w.Session() as session:
            n = await mark_room_words_lines_read(session, room_ids=[s.chan], member_ids=[s.a])
            await session.commit()
        assert n >= 3
        a_after = await _db_unread(w, s.a)
        assert a_after.get("conversation.message_created", 0) == 0
        assert a_after.get("conversation:mention") == 1 and a_after.get("story.assigned") == 1, a_after  # a mention and a non-room notification are never marked
        assert await _db_unread(w, b) == b_before, "someone who was not named was marked"
        async with w.Session() as session:  # idempotent: an already-read line keeps its time
            assert await mark_room_words_lines_read(session, room_ids=[s.chan], member_ids=[s.a]) == 0
    finally:
        await _close(engine, w)


async def test_10_a_notification_that_is_not_about_a_room_is_counted_as_before():
    engine, w = await _world()
    try:
        s = await _scene(w, "channel", "P10")
        await w.sql(
            "INSERT INTO events (id, org_id, event_type, source_entity_type, source_entity_id, recipient_id, recipient_type, payload, status) "
            "VALUES (gen_random_uuid(), :o, 'story.assigned', 'story', gen_random_uuid(), :a, 'human', '{}'::jsonb, 'pending')", o=s.org, a=s.a)
        await w.sql("DELETE FROM project_access WHERE project_id = :p AND org_member_id = :s", p=s.pid, s=s.a)
        n = await _nums(w, s.ta)
        assert "story.assigned" in n["kinds"] and n["bell"] == 2, n  # the assignment + the mention; the channel's words are not
    finally:
        await _close(engine, w)


async def _dispatched(w, org, a, *, entity_type, entity_id, event="task.update") -> None:
    await w.sql(
        "INSERT INTO events (id, org_id, event_type, source_entity_type, source_entity_id, recipient_id, recipient_type, payload, status) "
        "VALUES (gen_random_uuid(), :o, 'dispatched', :t, :i, :a, 'human', CAST(:p AS jsonb), 'delivered')",
        o=org, t=entity_type, i=entity_id, a=a, p='{"event_type": "%s", "title": "t"}' % event,
    )


async def test_11_a_dispatched_row_with_no_entity_type_or_another_kind_is_never_taken_for_a_rooms_words():
    """`source_entity_type = 'conversation'` is NULL for a row whose type is NULL, which made `NOT (is-a-words-line)` NULL and dropped the row from the list and the count (and `read-all` skipped it): such a notification
    is not a room's words and must be treated as plain «not». A `conversation` copy (the bell's copy of a room) keeps following the room."""
    engine, w = await _world()
    try:
        s = await _scene(w, "channel", "P11")
        await _dispatched(w, s.org, s.a, entity_type=None, entity_id=None)                                  # ① no entity at all
        await _dispatched(w, s.org, s.a, entity_type="doc", entity_id=uuid.uuid4())                         # ② another kind
        await _dispatched(w, s.org, s.a, entity_type="conversation", entity_id=s.chan, event="room.copy")  # ③ the room's own copy (any kind but a chat message's, so the 4890 hide does not apply)
        n = await _nums(w, s.ta)
        assert (n["bell"], n["listed"]) == (7, 7), n  # 3 lines + the mention + the three dispatched rows
        # the access goes (the seat stays): ① and ② stay, the room's copy goes with the room
        await w.sql("DELETE FROM project_access WHERE project_id = :p AND org_member_id = :s", p=s.pid, s=s.a)
        n = await _nums(w, s.ta)
        assert (n["bell"], n["listed"]) == (3, 3), n  # the mention + ① + ②
        ra = await w.client.patch("/api/v2/event-notifications/read-all", headers=_H(s.ta))
        assert ra.status_code == 200
        left = await _q(w, "SELECT payload->>'event_type', count(*) FROM events WHERE recipient_id = :a AND read_at IS NULL AND event_type = 'dispatched' AND payload->>'event_type' IN ('task.update', 'room.copy') GROUP BY 1", a=s.a)
        assert dict(left) == {"room.copy": 1}, left  # ① and ② ('task.update') were read by read-all; the unreadable room's copy ('room.copy') was not
        n = await _nums(w, s.ta)
        assert (n["bell"], n["listed"]) == (0, 0), n
    finally:
        await _close(engine, w)


async def test_12_the_helper_is_narrowed_to_the_rooms_organization_and_touches_only_unread_words_lines():
    engine, w = await _world()
    try:
        from app.services.event_room_gate import mark_room_words_lines_read

        s = await _scene(w, "channel", "P12a")
        other_org, _ot, _pid, _chan = await _owner_and_channel(w, "P12b")  # another organization
        # a line of ANOTHER organization that names this room id (a crafted / colliding row): it must not be touched
        foreign = uuid.uuid4()
        await w.sql(
            "INSERT INTO events (id, org_id, event_type, source_entity_type, source_entity_id, recipient_id, recipient_type, payload, status) "
            "VALUES (:i, :o, 'conversation.message_created', 'conversation_message', gen_random_uuid(), :a, 'human', CAST(:p AS jsonb), 'delivered')",
            i=foreign, o=other_org, a=s.a, p='{"conversation_id": "%s"}' % s.chan)
        unread_words = (await _q(w, "SELECT count(*) FROM events WHERE recipient_id = :a AND org_id = :o AND read_at IS NULL AND event_type = 'conversation.message_created' AND payload->>'conversation_id' = :c", a=s.a, o=s.org, c=str(s.chan)))[0][0]
        assert unread_words >= 3
        async with w.Session() as session:
            n = await mark_room_words_lines_read(session, room_ids=[s.chan], member_ids=[s.a], org_id=s.org)
            await session.commit()
        assert n >= unread_words  # every unread words-line of the room (the bell's copies of it count too)
        assert (await _q(w, "SELECT read_at IS NULL FROM events WHERE id = :i", i=foreign))[0][0] is True, "another organization's row was marked read"
        async with w.Session() as session:  # control: without the organization the same row IS marked (the narrowing is what protects it)
            await mark_room_words_lines_read(session, room_ids=[s.chan], member_ids=[s.a])
            await session.commit()
        assert (await _q(w, "SELECT read_at IS NULL FROM events WHERE id = :i", i=foreign))[0][0] is False
        async with w.Session() as session:  # and a second run finds nothing unread: only UNREAD lines are ever counted
            assert await mark_room_words_lines_read(session, room_ids=[s.chan], member_ids=[s.a], org_id=s.org) == 0
    finally:
        await _close(engine, w)


async def test_13_every_road_that_unseats_narrows_the_read_marking_to_the_channels_organization():
    engine, w = await _world()
    try:
        from app.services.project_channel import empty_project_channel, unseat_from_project_channel, unseat_from_project_channels_of_org

        s = await _scene(w, "channel", "P13a")
        other_org, _ot, _pid, _chan = await _owner_and_channel(w, "P13b")

        async def foreign_row() -> uuid.UUID:
            i = uuid.uuid4()
            await w.sql(
                "INSERT INTO events (id, org_id, event_type, source_entity_type, source_entity_id, recipient_id, recipient_type, payload, status) "
                "VALUES (:i, :o, 'conversation.message_created', 'conversation_message', gen_random_uuid(), :a, 'human', CAST(:p AS jsonb), 'delivered')",
                i=i, o=other_org, a=s.a, p='{"conversation_id": "%s"}' % s.chan)
            return i

        roads = {
            "one revoke": lambda session: unseat_from_project_channel(session, project_id=s.pid, member_id=s.a),
            "org removal": lambda session: unseat_from_project_channels_of_org(session, org_id=s.org, member_ids={s.a}),
            "project deleted": lambda session: empty_project_channel(session, project_id=s.pid),
        }
        for name, road in roads.items():
            row = await foreign_row()
            async with w.Session() as session:
                await road(session)
                await session.commit()
            assert (await _q(w, "SELECT read_at IS NULL FROM events WHERE id = :i", i=row))[0][0] is True, f"{name}: another organization's row naming the room was marked read"
    finally:
        await _close(engine, w)
