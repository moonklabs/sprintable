"""story #5032 (C2 · «a channel is a project» — server piece 1, the roads that can leave a participant row behind) — real Postgres, real tokens · real keys · real endpoints.

A project's channel room is seated by project access (grant → seat · revoke → unseat). Several things end someone's reach to the project WITHOUT that unseat working, so a participant row can outlive the
access. The channel therefore does not trust the seat alone: its READ (`conversation_auth.channel_project_valid`, one atom of `conversation_readable_predicate`, so the room route · the messages · the list ·
the socket · the bulk consumers all ask it) and its DELIVERY (`conversation_auth.members_holding_channel_project`, called by the recipient resolvers in `member_resolver.py`, by the mention's admission, by
«add a participant» and by the send) ask for the project access NOW — a person or an agent alike — and a channel whose project is gone reads nobody. Every room that is not a project's channel keeps the
4846 rule (being in the room reads it).

Measured here, one question each — «afterwards, can that person / agent still READ the channel, is it still DELIVERED to them, can they still be put in / speak in it»:

  01 an organization member is removed: closed by the request authentication (story #4772 — the organization is dropped from the token) and by the recipient rule (`filter_org_member_ids`); the
     removal also takes their seats out of the organization's channels (`project_channel.unseat_from_project_channels_of_org_quietly`, called from `delete_org_member`)
  02 …and were the SAME seat ever opened again, the stale row would have opened the channel to someone with no access to its project (measured open before the rule: 200) — now closed
  03 the removal's unseat takes exactly the removed person's seats in channels, no one else's, and no ordinary room's
  04 an agent is deleted (= deactivated): closed by its key (`_resolve_api_key`) and by `has_project_access` (`Member.is_active`), delivery by the project cut; the seat is kept (the access is kept) so turning it
     on again brings the channel back
  05 the project is deleted (`conversations.project_id` SET NULL — a room outlives its project, 4846 AC1): the people and agents of the old project read nothing of it and are sent nothing; nobody can speak in it
  06 …while an ordinary room of the deleted project keeps the 4846 rule
  07 a revoke whose unseat failed leaves a seat: it reads · is sent · speaks · sees «working» of nothing
  08 an old grant row that names the person only by their seat is unseated by the revoke
  09 nobody without the project is put in the channel: «add a participant» refuses, a mention does not seat (bell without the words)
"""
from __future__ import annotations

import uuid

import pytest
from sqlalchemy import text

from tests.test_4752_account_delete_realdb import (  # noqa: F401 — fixtures used by name
    _close,
    _dispose_global_engine_after_test,
    _no_rate_limit,
    _REAL_DB_URL,
    _world,
)

pytestmark = [
    pytest.mark.skipif(not _REAL_DB_URL, reason="real Postgres 필요"),
    pytest.mark.anyio,
]


@pytest.fixture
def anyio_backend():
    return "asyncio"


def _H(tokens: dict) -> dict:
    return {"Authorization": f"Bearer {tokens['access_token']}"}


async def _q(w, sql: str, **kw):
    async with w.Session() as s:
        return (await s.execute(text(sql), kw)).all()


async def _participants(w, conv_id) -> set[uuid.UUID]:
    return {r[0] for r in await _q(w, "SELECT member_id FROM conversation_participants WHERE conversation_id = :c", c=conv_id)}


async def _project(w, ot: dict, org, name: str) -> uuid.UUID:
    r = await w.client.post("/api/v2/projects", headers=_H(ot), json={"name": name, "org_id": str(org)})
    assert r.status_code == 201, r.text
    body = r.json()
    return uuid.UUID((body.get("data") or body)["id"])


async def _channel_of(w, pid):
    rows = await _q(w, "SELECT id FROM conversations WHERE project_id = :p AND is_project_channel", p=pid)
    assert len(rows) == 1, rows
    return rows[0][0]


async def _owner_and_channel(w, name: str = "Chan Proj"):
    """an organization with its owner, one project made through the real route (so it has its channel, the owner in it)."""
    _uid, email, org = await w.person(org=True, name="Owner")
    ot = await w.tokens(email)
    pid = await _project(w, ot, org, name)
    return org, ot, pid, await _channel_of(w, pid)


async def _add_person(w, org, ot: dict, pid):
    """a person of the organization, given the project through the real access route (→ seated in the channel); returns (user id, seat id = member id, their tokens)."""
    uid = await w.add_member(org, role="member", name="M")
    seat = (await _q(w, "SELECT id FROM org_members WHERE org_id = :o AND user_id = :u", o=org, u=uid))[0][0]
    r = await w.client.post(f"/api/v2/projects/{pid}/access", headers=_H(ot), json={"org_member_id": str(seat)})
    assert r.status_code == 201, r.text
    return uid, seat, await w.tokens(f"story4752-m-{uid.hex[:10]}@test.com")


async def _add_agent(w, org, ot: dict, pid):
    """an agent of the organization with a real API key, given the project through the real access route (→ seated in the channel); returns (member id, key headers)."""
    from app.repositories.api_key import _generate_key
    from app.models.api_key import ApiKey

    agent = await w.add_agent(org)
    r = await w.client.post(f"/api/v2/projects/{pid}/access", headers=_H(ot), json={"member_id": str(agent)})
    assert r.status_code == 201, r.text
    plaintext, prefix, key_hash = _generate_key()
    async with w.Session() as s:
        s.add(ApiKey(id=uuid.uuid4(), team_member_id=agent, member_id=agent, key_prefix=prefix, key_hash=key_hash))
        await s.commit()
    return agent, {"Authorization": f"Bearer {plaintext}"}


async def _reads(w, headers: dict, chan) -> tuple[int, int]:
    """(the room, its messages) — the two read routes."""
    a = await w.client.get(f"/api/v2/conversations/{chan}", headers=headers)
    b = await w.client.get(f"/api/v2/conversations/{chan}/messages", headers=headers)
    return a.status_code, b.status_code


async def _say(w, ot: dict, chan, words: str, mention=()):
    """the owner says a line in the channel; returns (message id, who got a `conversation.message_created` event, {who got a `conversation:mention` event: its payload})."""
    r = await w.client.post(
        f"/api/v2/conversations/{chan}/messages", headers=_H(ot), json={"content": words, "mentioned_ids": [str(m) for m in mention]},
    )
    assert r.status_code == 201, r.text
    body = r.json()
    mid = uuid.UUID((body.get("data") or body)["id"])
    rows = await _q(w, "SELECT event_type, recipient_id, payload FROM events WHERE source_entity_id = :m", m=mid)
    created = {r[1] for r in rows if r[0] == "conversation.message_created"}
    mentions = {r[1]: r[2] for r in rows if r[0] == "conversation:mention"}
    return mid, created, mentions


async def _delivery_side(w, chan, mid) -> tuple[set[uuid.UUID], set[uuid.UUID]]:
    """the two server-side recipient decisions the whole delivery rests on: the participants a delivery may reach, and the channel router's per-recipient decisions for the message."""
    from app.services.channel_router import route_message
    from app.services.member_resolver import conversation_member_ids_of_its_org

    async with w.Session() as s:
        reach = await conversation_member_ids_of_its_org(s, chan)
        decided = {d.member_id for d in await route_message(mid, s)}
    return reach, decided


# ── ① an organization member is removed ───────────────────────────────────────────────────────────────────────


async def _remove(w, ot: dict, seat):
    r = await w.client.delete(f"/api/v2/org-members/{seat}", headers=_H(ot))
    assert r.status_code == 200, r.text


async def test_01_a_removed_member_reads_nothing_of_the_channel_and_is_sent_nothing_of_it_and_no_row_of_theirs_is_left_in_it():
    engine, w = await _world()
    try:
        org, ot, pid, chan = await _owner_and_channel(w)
        uid, seat, mt = await _add_person(w, org, ot, pid)
        assert seat in await _participants(w, chan)
        assert await _reads(w, _H(mt), chan) == (200, 200), "control: before the removal the member reads the channel"
        mid0, got0, _m = await _say(w, ot, chan, "before the removal")
        assert seat in got0, "control: before the removal the member is sent the line"

        await _remove(w, ot, seat)

        # read: the old token, the same with the organization named in a header, and a token taken after the removal
        assert await _reads(w, _H(mt), chan) == (403, 403)
        assert await _reads(w, {**_H(mt), "X-Org-Id": str(org)}, chan) == (403, 403)
        fresh = await w.tokens(f"story4752-m-{uid.hex[:10]}@test.com")
        got_fresh = await _reads(w, _H(fresh), chan)
        assert 200 not in got_fresh and got_fresh[0] in (400, 403) and got_fresh[1] in (400, 403), got_fresh   # a person with no organization left: «org_id required» / 403
        # …and the socket judge says the same
        from app.services.conversation_auth import socket_can_read_conversation

        async with w.Session() as s:
            assert await socket_can_read_conversation(s, chan, org, member_id=seat, access_user_id=uid, via_agent_key=False) is False

        # delivery: a line said after the removal reaches the others and not them
        mid1, got1, _m = await _say(w, ot, chan, "after the removal")
        assert seat not in got1
        reach, decided = await _delivery_side(w, chan, mid1)
        assert seat not in reach and seat not in decided

        # the row: the removal took the person out of the channel — the seat follows the access
        assert seat not in await _participants(w, chan), "the removal left the person's participant row in the project channel"
    finally:
        await _close(engine, w)


async def test_02_were_the_same_seat_opened_again_the_person_has_no_project_and_so_no_channel():
    """the stale participant row is the whole reason ① needs a fix: a person reads a room by being in it, with no project access asked — so a row left behind by a removal would give the
    channel of a project they have no access to back to them the moment the seat is open again (undone the way `test_4772 … test_02` undoes a removal)."""
    engine, w = await _world()
    try:
        org, ot, pid, chan = await _owner_and_channel(w)
        uid, seat, mt = await _add_person(w, org, ot, pid)
        await _remove(w, ot, seat)
        await w.sql("UPDATE org_members SET deleted_at = NULL WHERE id = :s", s=seat)
        await w.sql("UPDATE members SET is_active = true WHERE id = :s", s=seat)
        assert (await w.client.get("/api/v2/members", headers=_H(mt))).status_code == 200, "control: the seat is open again — the token reads the organization"
        assert not await _q(w, "SELECT 1 FROM project_access WHERE project_id = :p AND org_member_id = :s", p=pid, s=seat), "control: the removal took the project access"
        assert await _reads(w, _H(mt), chan) == (404, 403), "a person with no project access read the project's channel through a row the removal left behind"
    finally:
        await _close(engine, w)


async def test_03_removing_a_member_takes_them_out_of_every_channel_of_the_organization_and_only_theirs():
    engine, w = await _world()
    try:
        org, ot, p1, c1 = await _owner_and_channel(w, "First")
        p2 = await _project(w, ot, org, "Second")
        c2 = await _channel_of(w, p2)
        _u_m, m_seat, _t = await _add_person(w, org, ot, p1)
        _u_n, n_seat, _t = await _add_person(w, org, ot, p1)
        r = await w.client.post(f"/api/v2/projects/{p2}/access", headers=_H(ot), json={"org_member_id": str(m_seat)})
        assert r.status_code == 201, r.text
        assert {m_seat, n_seat} <= await _participants(w, c1) and m_seat in await _participants(w, c2)
        # an ORDINARY room of the same project they are in (not a channel) is not this road's business
        await w.sql(
            "INSERT INTO conversations (id, org_id, project_id, type, status, title) VALUES (gen_random_uuid(), :o, :p, 'group', 'open', 'plain room')", o=org, p=p1,
        )
        plain = (await _q(w, "SELECT id FROM conversations WHERE project_id = :p AND title = 'plain room'", p=p1))[0][0]
        await w.sql("INSERT INTO conversation_participants (id, conversation_id, member_id) VALUES (gen_random_uuid(), :c, :m)", c=plain, m=m_seat)

        await _remove(w, ot, m_seat)

        assert m_seat not in await _participants(w, c1) and m_seat not in await _participants(w, c2)
        assert n_seat in await _participants(w, c1), "someone else's seat is untouched"
        assert m_seat in await _participants(w, plain), "a room that is not a project channel keeps its people (the 4846 rule: a room is the organization's)"
    finally:
        await _close(engine, w)


# ── ② an agent is deleted (deactivated) ───────────────────────────────────────────────────────────────────────


async def test_04_a_deactivated_agent_reads_nothing_of_the_channel_and_is_sent_nothing_of_it_and_turning_it_on_brings_the_channel_back():
    engine, w = await _world()
    try:
        org, ot, pid, chan = await _owner_and_channel(w)
        agent, key = await _add_agent(w, org, ot, pid)
        assert agent in await _participants(w, chan)
        assert await _reads(w, key, chan) == (200, 200), "control: an active agent with the project reads its channel"
        # an agent in a group room is sent only the words that call it (5030), so the room is set to «answer everything» — then every line is the agent's, called or not
        await w.sql("UPDATE conversations SET free_response = true WHERE id = :c", c=chan)
        _m0, got0, _x = await _say(w, ot, chan, "before the deactivation")
        assert agent in got0, "control: an active agent is sent the line"

        r = await w.client.delete(f"/api/v2/team-members/{agent}", headers=_H(ot))
        assert r.status_code == 200, r.text
        assert (await _q(w, "SELECT is_active FROM members WHERE id = :a", a=agent))[0][0] is False

        # read: its key no longer authenticates …
        assert await _reads(w, key, chan) == (401, 401)
        # … and behind the key, the rule that an agent reads a room with a project only while it has the project says no too (asked directly — nothing of the authentication in the way)
        from app.services.conversation_auth import agent_project_valid_for_room, socket_can_read_conversation

        async with w.Session() as s:
            assert await agent_project_valid_for_room(s, caller_is_agent=True, caller_id=agent, conv_project_id=pid, org_id=org) is False
            assert await socket_can_read_conversation(s, chan, org, member_id=agent, access_user_id=agent, via_agent_key=True) is False

        # delivery: a line said after is not sent to it (events, router decisions, the participants a delivery may reach)
        mid1, got1, _x = await _say(w, ot, chan, "after the deactivation")
        assert agent not in got1
        reach, decided = await _delivery_side(w, chan, mid1)
        assert agent not in reach and agent not in decided
        # calling it by name is the one road that still reaches it: the bell with nothing of the words (4846 AC9 — an agent that lost the room's project keeps the mention, not the text)
        secret = f"words-{uuid.uuid4().hex[:8]}"
        _m, _c, mentions = await _say(w, ot, chan, secret, mention=[agent])
        assert secret not in str(mentions.get(agent)), "a deactivated agent was sent the words of the channel in a mention"

        # the seat is kept on purpose (its project access is kept): turning it on again brings the channel back, no re-grant
        assert agent in await _participants(w, chan)
        r = await w.client.patch(f"/api/v2/team-members/{agent}", headers=_H(ot), json={"is_active": True})
        assert r.status_code == 200, r.text
        assert await _reads(w, key, chan) == (200, 200)
        _m2, got2, _x = await _say(w, ot, chan, "after turning it on")
        assert agent in got2
    finally:
        await _close(engine, w)


# ── ③ the project is deleted ──────────────────────────────────────────────────────────────────────────────────


async def test_05_deleting_the_project_closes_its_channel_to_everyone_in_it_and_sends_it_nothing():
    """the room outlives its project (4846 AC1) and its seats stay — but a channel with no project is nobody's: «a room without a project» (the 4846 rule that lets an agent read it with no project) is
    NOT a channel. Without the rule the people and agents of the old project would go on reading and being sent a room that now belongs to nothing."""
    engine, w = await _world()
    try:
        org, ot, pid, chan = await _owner_and_channel(w)
        keep = await _project(w, ot, org, "Keeps the agent")                   # the agent has another project, so its key still authenticates after the deletion
        uid, seat, mt = await _add_person(w, org, ot, pid)
        agent, key = await _add_agent(w, org, ot, pid)
        r = await w.client.post(f"/api/v2/projects/{keep}/access", headers=_H(ot), json={"member_id": str(agent)})
        assert r.status_code == 201, r.text
        assert await _reads(w, _H(mt), chan) == (200, 200) and await _reads(w, key, chan) == (200, 200), "control: before the deletion both read the channel"
        before = await _participants(w, chan)
        assert {seat, agent} <= before

        r = await w.client.delete(f"/api/v2/projects/{pid}", headers=_H(ot))
        assert r.status_code == 200, r.text

        row = (await _q(w, "SELECT project_id, is_project_channel FROM conversations WHERE id = :c", c=chan))[0]
        assert row[0] is None and row[1] is True, "the room outlives its project and is still marked as a channel (so the channel rule keeps closing it)"
        assert await _participants(w, chan) == set(), "the deletion emptied the room in its own transaction: its history stays, nobody is seated in it (the root)"
        # read: the person and the agent (its key still works — another project) are closed; the organization's owner — who is nobody's seat — reads the kept history through the
        # existing «a room with no person in it» door of an organization owner/admin (4846): the history of a deleted project is not lost to the organization
        for who, headers in (("person", _H(mt)), ("agent", key)):
            got = await _reads(w, headers, chan)
            assert got == (404, 403), (who, got)
        assert await _reads(w, _H(ot), chan) == (200, 200)
        # …and with a seat put back by hand (a stale row some other road left) the rule still closes it: the safety net under the root
        await w.sql("INSERT INTO conversation_participants (id, conversation_id, member_id) VALUES (gen_random_uuid(), :c, :m)", c=chan, m=seat)
        await w.sql("INSERT INTO conversation_participants (id, conversation_id, member_id) VALUES (gen_random_uuid(), :c, :m)", c=chan, m=agent)
        for who, headers in (("person", _H(mt)), ("agent", key)):
            got = await _reads(w, headers, chan)
            assert got == (404, 403), (who, got)
        # delivery: a line in it (put in by hand — nobody can say one through the route now) reaches nobody
        mid = uuid.uuid4()
        await w.sql(
            "INSERT INTO conversation_messages (id, conversation_id, sender_id, content, mentioned_ids) VALUES (:m, :c, :s, 'to an orphan channel', '{}')",
            m=mid, c=chan, s=seat,
        )
        reach, decided = await _delivery_side(w, chan, mid)
        assert not reach and not decided, (reach, decided)   # (the seats put back above are still not recipients)
        from app.services.member_resolver import conversation_member_ids_in_org

        async with w.Session() as s:
            assert not await conversation_member_ids_in_org(s, chan, org)
        # …and nobody can say a line in it: the owner is no seat and there is no project to join through; the stale seats are refused
        r = await w.client.post(f"/api/v2/conversations/{chan}/messages", headers=_H(ot), json={"content": "anyone there"})
        assert r.status_code == 403, r.text
        r = await w.client.post(f"/api/v2/conversations/{chan}/messages", headers=_H(mt), json={"content": "anyone there"})
        assert r.status_code == 403, r.text
        # a project made later is free to have its own channel (the one-per-project index never saw the old room)
        again = await _project(w, ot, org, "Second life")
        assert (await _channel_of(w, again)) != chan
    finally:
        await _close(engine, w)


async def test_06_an_ordinary_room_of_a_deleted_project_keeps_the_4846_rule_its_people_still_read_it():
    """the channel rule must not touch a room that is not a channel: an ordinary room of the project outlives it and its people read it (4846 AC1 · AC2)."""
    engine, w = await _world()
    try:
        org, ot, pid, chan = await _owner_and_channel(w)
        uid, seat, mt = await _add_person(w, org, ot, pid)
        await w.sql("INSERT INTO conversations (id, org_id, project_id, type, status, title) VALUES (gen_random_uuid(), :o, :p, 'group', 'open', 'plain')", o=org, p=pid)
        plain = (await _q(w, "SELECT id FROM conversations WHERE project_id = :p AND title = 'plain'", p=pid))[0][0]
        await w.sql("INSERT INTO conversation_participants (id, conversation_id, member_id) VALUES (gen_random_uuid(), :c, :m)", c=plain, m=seat)
        assert await _reads(w, _H(mt), plain) == (200, 200)
        r = await w.client.delete(f"/api/v2/projects/{pid}", headers=_H(ot))
        assert r.status_code == 200, r.text
        assert await _reads(w, _H(mt), plain) == (200, 200), "an ordinary room is not closed by the channel rule"
        assert await _reads(w, _H(mt), chan) == (404, 403)
    finally:
        await _close(engine, w)


# ── a seat that outlived its access (a failed unseat · an old row) ─────────────────────────────────────────────


async def _stale_seat(w, org, ot, pid):
    """a person with a seat in the channel and NO project access: the access row is removed behind the unseat's back (the failed-unseat · old-row · other-road state); returns (user id, seat id, tokens)."""
    uid, seat, mt = await _add_person(w, org, ot, pid)
    await w.sql("DELETE FROM project_access WHERE project_id = :p AND org_member_id = :s", p=pid, s=seat)
    assert seat in await _participants(w, await _channel_of(w, pid))
    return uid, seat, mt


async def test_07_a_seat_that_outlived_the_access_reads_nothing_is_sent_nothing_and_changes_nothing():
    engine, w = await _world()
    try:
        org, ot, pid, chan = await _owner_and_channel(w)
        uid, seat, mt = await _stale_seat(w, org, ot, pid)
        # read · speak · see «working»
        assert await _reads(w, _H(mt), chan) == (404, 403), "a seat that outlived the revoke read the channel"
        r = await w.client.post(f"/api/v2/conversations/{chan}/messages", headers=_H(mt), json={"content": "still here?"})
        assert r.status_code in (403, 404), r.text
        assert (await w.client.get(f"/api/v2/conversations/{chan}/working", headers=_H(mt))).status_code == 403
        # delivery: the events, the router, the bell copy
        secret = f"words-{uuid.uuid4().hex[:8]}"
        mid, got, mentions = await _say(w, ot, chan, secret, mention=[seat])
        assert seat not in got
        reach, decided = await _delivery_side(w, chan, mid)
        assert seat not in reach and seat not in decided
        assert secret not in str(mentions.get(seat)), "the mention carried the words to a seat that outlived the revoke"
        # the changes only a participant may make (every one answers 403 — and changes nothing)
        base = f"/api/v2/conversations/{chan}"
        for method, path, body in (
            ("PATCH", base + "/mute", {"muted": True}),
            ("POST", base + "/read", {}),
            ("POST", base + "/participants", {"member_id": str(seat)}),
            ("PATCH", base + "/status", {"status": "resolved"}),
            ("PATCH", base, {"title": "taken over"}),
        ):
            r = await w.client.request(method, path, headers=_H(mt), json=body)
            assert r.status_code in (403, 404), (method, path, r.status_code, r.text)
        row = (await _q(w, "SELECT title, status FROM conversations WHERE id = :c", c=chan))[0]
        assert row[0] != "taken over" and row[1] == "open"
        # control: the SAME person in an ordinary room they sit in still reads it (the 4846 rule is untouched)
        await w.sql("INSERT INTO conversations (id, org_id, project_id, type, status, title) VALUES (gen_random_uuid(), :o, :p, 'group', 'open', 'plain')", o=org, p=pid)
        plain = (await _q(w, "SELECT id FROM conversations WHERE project_id = :p AND title = 'plain'", p=pid))[0][0]
        await w.sql("INSERT INTO conversation_participants (id, conversation_id, member_id) VALUES (gen_random_uuid(), :c, :m)", c=plain, m=seat)
        assert await _reads(w, _H(mt), plain) == (200, 200)
        r = await w.client.patch(f"/api/v2/conversations/{plain}/mute", headers=_H(mt), json={"muted": True})
        assert r.status_code == 200, r.text
    finally:
        await _close(engine, w)


async def test_07b_a_revoke_whose_unseat_fails_fails_whole_nothing_is_half_done():
    """the root: the unseat is in the revoke's own transaction and is not swallowed — an access that is gone with the seat left behind is the state this story closes."""
    engine, w = await _world()
    try:
        from app.services import project_channel as pc

        org, ot, pid, chan = await _owner_and_channel(w)
        uid, seat, mt = await _add_person(w, org, ot, pid)
        access = (await _q(w, "SELECT id FROM project_access WHERE project_id = :p AND org_member_id = :s", p=pid, s=seat))[0][0]

        real = pc.remove_project_channel_participant

        async def boom(*_a, **_k):
            raise RuntimeError("unseat broke")

        pc.remove_project_channel_participant = boom
        try:
            with pytest.raises(RuntimeError, match="unseat broke"):
                await w.client.delete(f"/api/v2/projects/{pid}/access/{access}", headers=_H(ot))
        finally:
            pc.remove_project_channel_participant = real
        assert await _q(w, "SELECT 1 FROM project_access WHERE id = :a", a=access), "the revoke was kept although its unseat failed"
        assert seat in await _participants(w, chan)
        assert await _reads(w, _H(mt), chan) == (200, 200), "control: nothing moved — the person still has the project and the channel"
    finally:
        await _close(engine, w)


async def test_07c_a_stale_seat_hears_nothing_in_the_bell_and_counts_nothing_unread_and_is_not_listed_by_work_item(monkeypatch):
    engine, w = await _world()
    try:
        org, ot, pid, chan = await _owner_and_channel(w)
        ok_uid, ok_seat, ok_tokens = await _add_person(w, org, ot, pid)             # control: seated with the project
        st_uid, st_seat, st_tokens = await _stale_seat(w, org, ot, pid)             # stale: seated, no project
        # the owner says a line tagged to a work item
        item = uuid.uuid4()
        r = await w.client.post(
            f"/api/v2/conversations/{chan}/messages", headers=_H(ot),
            json={"content": "about a story", "work_item": {"type": "story", "id": str(item)}},
        )
        assert r.status_code == 201, r.text

        async def notes(user):
            return (await _q(w, "SELECT count(*) FROM notifications WHERE user_id = :u AND type = 'conversation.message'", u=user))[0][0]

        assert await notes(ok_uid) == 1, "control: the person who holds the project is told"
        assert await notes(st_uid) == 0, "a stale seat was told of a line of the channel (bell copy · push · personal webhook)"

        # …also when the channel router's pre-check fails (a send never fails for it — the bell then falls back to the seat rows, and the room's own cut must still hold)
        from app.services import channel_router

        real_route, calls = channel_router.route_message, {"n": 0}

        async def broken_once(*a, **k):
            calls["n"] += 1
            if calls["n"] == 1:   # the send's pre-check (its first ask); the later asks of the same send answer as they do
                raise RuntimeError("router down")
            return await real_route(*a, **k)

        monkeypatch.setattr(channel_router, "route_message", broken_once)
        r = await w.client.post(f"/api/v2/conversations/{chan}/messages", headers=_H(ot), json={"content": "second line"})
        assert r.status_code == 201, r.text
        assert await notes(ok_uid) == 2, "control: with the router down the person who holds the project is still told"
        assert await notes(st_uid) == 0, "with the router down a stale seat was told of a line of the channel"
        monkeypatch.undo()

        for who, tokens, want in (("seated", ok_tokens, 2), ("stale", st_tokens, 0)):
            r = await w.client.get("/api/v2/conversations/unread-count", headers=_H(tokens))
            assert r.status_code == 200, r.text
            assert r.json()["count"] == want, (who, r.json())
            r = await w.client.get(f"/api/v2/conversations/by-work-item?work_item_type=story&work_item_id={item}", headers=_H(tokens))
            assert r.status_code == 200, r.text
            listed = {x["id"] for x in r.json()}
            assert (str(chan) in listed) is bool(want), (who, listed)
    finally:
        await _close(engine, w)


async def test_08_an_old_grant_row_that_names_the_person_only_by_their_seat_is_unseated_too():
    engine, w = await _world()
    try:
        org, ot, pid, chan = await _owner_and_channel(w)
        uid, seat, mt = await _add_person(w, org, ot, pid)
        await w.sql("UPDATE project_access SET member_id = NULL WHERE project_id = :p AND org_member_id = :s", p=pid, s=seat)
        access = (await _q(w, "SELECT id FROM project_access WHERE project_id = :p AND org_member_id = :s", p=pid, s=seat))[0][0]
        r = await w.client.delete(f"/api/v2/projects/{pid}/access/{access}", headers=_H(ot))
        assert r.status_code == 200, r.text
        assert seat not in await _participants(w, chan)
        assert await _reads(w, _H(mt), chan) == (404, 403)
    finally:
        await _close(engine, w)


# ── nobody without the project is put in the channel ───────────────────────────────────────────────────────────


async def test_09_a_participant_cannot_add_someone_without_the_project_to_the_channel_and_a_mention_does_not_seat_them():
    engine, w = await _world()
    try:
        org, ot, pid, chan = await _owner_and_channel(w)
        uid, seat, mt = await _add_person(w, org, ot, pid)
        out_uid = await w.add_member(org, role="member", name="Outside")        # in the organization, no access to the project
        out_seat = (await _q(w, "SELECT id FROM org_members WHERE org_id = :o AND user_id = :u", o=org, u=out_uid))[0][0]
        out_tokens = await w.tokens(f"story4752-m-{out_uid.hex[:10]}@test.com")

        # «add a participant»: refused for a person and for an agent without the project; allowed for someone who has it
        r = await w.client.post(f"/api/v2/conversations/{chan}/participants", headers=_H(mt), json={"member_id": str(out_seat)})
        assert r.status_code == 403, r.text
        loose_agent = await w.add_agent(org)
        other = await _project(w, ot, org, "Elsewhere")                          # an agent of the organization, on ANOTHER project only
        r = await w.client.post(f"/api/v2/projects/{other}/access", headers=_H(ot), json={"member_id": str(loose_agent)})
        assert r.status_code == 201, r.text
        r = await w.client.post(f"/api/v2/conversations/{chan}/participants", headers=_H(mt), json={"member_id": str(loose_agent)})
        assert r.status_code == 403, r.text
        assert out_seat not in await _participants(w, chan) and loose_agent not in await _participants(w, chan)
        # a mention: the bell, never the seat and never the words
        secret = f"mention-{uuid.uuid4().hex[:8]}"
        _mid, _got, mentions = await _say(w, ot, chan, secret, mention=[out_seat, loose_agent])
        assert out_seat not in await _participants(w, chan) and loose_agent not in await _participants(w, chan)
        assert secret not in str(mentions.get(out_seat)) and secret not in str(mentions.get(loose_agent))
        assert await _reads(w, _H(out_tokens), chan) == (404, 403)
        # control: the SAME route works in an ordinary room (the rule is the channel's)
        await w.sql("INSERT INTO conversations (id, org_id, project_id, type, status, title) VALUES (gen_random_uuid(), :o, :p, 'group', 'open', 'plain')", o=org, p=pid)
        plain = (await _q(w, "SELECT id FROM conversations WHERE project_id = :p AND title = 'plain'", p=pid))[0][0]
        await w.sql("INSERT INTO conversation_participants (id, conversation_id, member_id) VALUES (gen_random_uuid(), :c, :m)", c=plain, m=seat)
        r = await w.client.post(f"/api/v2/conversations/{plain}/participants", headers=_H(mt), json={"member_id": str(out_seat)})
        assert r.status_code == 201, r.text
        # and the person who DOES hold the project can be added to the channel (control)
        has_uid, has_seat, has_tokens = await _add_person(w, org, ot, pid)
        await w.sql("DELETE FROM conversation_participants WHERE conversation_id = :c AND member_id = :m", c=chan, m=has_seat)
        r = await w.client.post(f"/api/v2/conversations/{chan}/participants", headers=_H(mt), json={"member_id": str(has_seat)})
        assert r.status_code == 201, r.text
        assert await _reads(w, _H(has_tokens), chan) == (200, 200)
    finally:
        await _close(engine, w)


# ── the other doors that read a room: files · A2A tasks ───────────────────────────────────────────────────────


async def test_10_the_files_of_a_channel_open_to_who_holds_its_project_not_to_a_stale_seat():
    from app.services import mcp_attachment_upload

    engine, w = await _world()
    try:
        org, ot, pid, chan = await _owner_and_channel(w)
        ok_uid, ok_seat, ok_tokens = await _add_person(w, org, ot, pid)
        st_uid, st_seat, st_tokens = await _stale_seat(w, org, ot, pid)
        path = mcp_attachment_upload.chat_attachment_path_prefix(org, pid, chan) + "f.png"
        await w.sql(
            "INSERT INTO conversation_messages (id, conversation_id, sender_id, content, mentioned_ids, attachments) "
            "VALUES (gen_random_uuid(), :c, :s, 'file', '{}', CAST(:a AS jsonb))",
            c=chan, s=ok_seat, a='[{"url": "%s", "name": "f.png", "size": 3, "content_type": "image/png"}]' % path,
        )

        async def authorize(tokens):
            r = await w.client.get("/api/v2/attachments/authorize", headers=_H(tokens), params={"conversation_id": str(chan), "path": path})
            return r.status_code

        assert await authorize(ok_tokens) == 200, "control: who holds the project opens the file"
        assert await authorize(st_tokens) == 403, "a seat that outlived the project access opened a file of the channel"
    finally:
        await _close(engine, w)


async def test_11_an_a2a_task_is_handed_back_only_while_its_agent_can_read_the_task_room():
    engine, w = await _world()
    try:
        from app.models.a2a_task import A2ATask
        from app.models.conversation import Conversation, ConversationMessage, ConversationParticipant

        org, ot, pid, chan = await _owner_and_channel(w)
        other = await _project(w, ot, org, "Agent's other project")
        agent, _key = await _add_agent(w, org, ot, pid)
        r = await w.client.post(f"/api/v2/projects/{other}/access", headers=_H(ot), json={"member_id": str(agent)})
        assert r.status_code == 201, r.text
        room, root = uuid.uuid4(), uuid.uuid4()
        task_id = uuid.uuid4()
        async with w.Session() as s:
            s.add(Conversation(id=room, project_id=pid, org_id=org, type="group", title="A2A task"))
            await s.flush()
            s.add(ConversationParticipant(conversation_id=room, member_id=agent))
            s.add(ConversationMessage(id=root, conversation_id=room, sender_id=None, content="do it", thread_id=None))
            await s.flush()
            s.add(ConversationMessage(id=uuid.uuid4(), conversation_id=room, sender_id=agent, content="the agent's answer", thread_id=root))
            s.add(A2ATask(id=task_id, context_id=room, root_message_id=root, member_id=agent, state="TASK_STATE_WORKING", history=[], artifacts=[]))
            await s.commit()

        async def rpc(method, params):
            r = await w.client.post(f"/api/v2/a2a/members/{agent}/rpc", headers=_H(ot), json={"jsonrpc": "2.0", "id": 1, "method": method, "params": params})
            assert r.status_code == 200, r.text
            return r.json()

        got = await rpc("GetTask", {"id": str(task_id)})
        assert "error" not in got or got["error"] is None, got
        assert "the agent's answer" in str(got["result"]), "control: while the agent has the room's project the task is handed back"
        listed = await rpc("ListTasks", {})
        assert listed["result"]["tasks"] and listed["result"]["totalSize"] == 1, "control: and listed"

        # the agent loses the room's project (it keeps another one, so it still resolves)
        access = (await _q(w, "SELECT id FROM project_access WHERE project_id = :p AND member_id = :m", p=pid, m=agent))[0][0]
        r = await w.client.delete(f"/api/v2/projects/{pid}/access/{access}", headers=_H(ot))
        assert r.status_code == 200, r.text

        got = await rpc("GetTask", {"id": str(task_id)})
        assert got["error"] and got["error"]["code"] == -32001, got
        assert "the agent's answer" not in str(got)
        listed = await rpc("ListTasks", {})
        assert listed["result"]["tasks"] == [] and "the agent's answer" not in str(listed)
        assert listed["result"]["totalSize"] == 0, "the count of a list leaked how many tasks of unreadable rooms there are"
    finally:
        await _close(engine, w)


# ── the roots: every road that ends the access takes the seat in its own transaction ───────────────────────────


async def test_12_deleting_the_account_takes_the_persons_seats_out_of_every_channel():
    engine, w = await _world()
    try:
        org, ot, pid, chan = await _owner_and_channel(w)
        uid, seat, mt = await _add_person(w, org, ot, pid)
        assert seat in await _participants(w, chan)
        r = await w.delete(mt)
        assert r.status_code == 200, r.text
        assert seat not in await _participants(w, chan), "the deleted account's seat stayed in the project channel"
        assert await _participants(w, chan), "control: the others are still seated"
    finally:
        await _close(engine, w)


async def test_13_a_replayed_send_message_does_not_hand_back_a_task_whose_room_the_agent_can_no_longer_read():
    engine, w = await _world()
    try:
        org, ot, pid, chan = await _owner_and_channel(w)
        other = await _project(w, ot, org, "Agent's other project")
        agent, _key = await _add_agent(w, org, ot, pid)
        r = await w.client.post(f"/api/v2/projects/{other}/access", headers=_H(ot), json={"member_id": str(agent)})
        assert r.status_code == 201, r.text

        async def send():
            r = await w.client.post(
                f"/api/v2/a2a/members/{agent}/rpc", headers=_H(ot),
                json={"jsonrpc": "2.0", "id": 1, "method": "SendMessage",
                      "params": {"message": {"messageId": "m-replay-1", "role": "ROLE_USER", "parts": [{"text": "please do it"}]}}},
            )
            assert r.status_code == 200, r.text
            return r.json()

        first = await send()
        assert first.get("error") is None, first
        ctx = uuid.UUID(first["result"]["task"]["contextId"])
        again = await send()
        assert again.get("error") is None and again["result"]["task"]["id"] == first["result"]["task"]["id"], "control: the same message id replays the same task"
        room_project = (await _q(w, "SELECT project_id FROM conversations WHERE id = :c", c=ctx))[0][0]
        access = (await _q(w, "SELECT id FROM project_access WHERE project_id = :p AND member_id = :m", p=room_project, m=agent))[0][0]
        r = await w.client.delete(f"/api/v2/projects/{room_project}/access/{access}", headers=_H(ot))
        assert r.status_code == 200, r.text

        gone = await send()
        assert gone["error"] and gone["error"]["code"] == -32001, gone
        assert gone.get("result") is None
    finally:
        await _close(engine, w)


# ── a person with a seat in the organization and no `members` anchor (grant-only) ───────────────────────────


async def _grant_only_person(w, org, ot, pid):
    """a person whose only identity is the org seat (no `members` row — the legacy shape): given the project through the grant route; returns (user id, seat id, tokens)."""
    uid, seat, tokens = await _add_person(w, org, ot, pid)
    await w.sql("UPDATE project_access SET member_id = NULL WHERE org_member_id = :s", s=seat)
    await w.sql("DELETE FROM members WHERE id = :s", s=seat)
    assert not await _q(w, "SELECT 1 FROM members WHERE id = :s", s=seat)
    return uid, seat, tokens


async def test_14_a_grant_only_person_with_the_project_reads_the_channel_and_without_it_does_not():
    engine, w = await _world()
    try:
        org, ot, pid, chan = await _owner_and_channel(w)
        uid, seat, tokens = await _grant_only_person(w, org, ot, pid)
        assert seat in await _participants(w, chan)
        assert await _reads(w, _H(tokens), chan) == (200, 200), "a person who holds the project through the org seat alone was refused its channel"
        mid, got, _m = await _say(w, ot, chan, "to the grant-only person")
        reach, decided = await _delivery_side(w, chan, mid)
        assert seat in reach, "…and was left out of its delivery"
        # the access goes (behind the unseat's back): the same person is closed
        await w.sql("DELETE FROM project_access WHERE org_member_id = :s", s=seat)
        assert await _reads(w, _H(tokens), chan) == (404, 403)
        mid2, _g, _m = await _say(w, ot, chan, "after")
        reach2, decided2 = await _delivery_side(w, chan, mid2)
        assert seat not in reach2 and seat not in decided2
    finally:
        await _close(engine, w)


async def test_15_deleting_the_account_of_a_grant_only_person_takes_their_seat_out_of_the_channel_too():
    engine, w = await _world()
    try:
        org, ot, pid, chan = await _owner_and_channel(w)
        uid, seat, tokens = await _grant_only_person(w, org, ot, pid)
        assert seat in await _participants(w, chan)
        r = await w.delete(tokens)
        assert r.status_code == 200, r.text
        assert seat not in await _participants(w, chan), "the account deletion missed a seat that has no `members` anchor"
    finally:
        await _close(engine, w)


async def test_16_a_prompt_line_that_finishes_after_the_access_went_is_not_written_into_the_channel():
    from app.services.desktop_commands import _write_prompt_line

    engine, w = await _world()
    try:
        org, ot, pid, chan = await _owner_and_channel(w)
        uid, seat, tokens = await _add_person(w, org, ot, pid)
        agent, _key = await _add_agent(w, org, ot, pid)

        async def write(sender):
            async with w.Session() as s:
                await _write_prompt_line(s, org_id=org, conversation_id=chan, sender_id=sender, agent_id=agent, text="do the thing", command_id=uuid.uuid4())
                await s.commit()
            return (await _q(w, "SELECT count(*) FROM conversation_messages WHERE conversation_id = :c AND sender_id = :s AND jsonb_exists(metadata, 'remote_prompt')", c=chan, s=sender))[0][0]

        assert await write(seat) == 1, "control: a holder's line is written"
        await w.sql("DELETE FROM project_access WHERE org_member_id = :s", s=seat)
        await w.sql("DELETE FROM conversation_participants WHERE conversation_id = :c AND member_id = :s", c=chan, s=seat)
        assert await write(seat) == 1, "the person lost the project: nothing more of theirs was written into the channel"
    finally:
        await _close(engine, w)


# ── the A2A read gate: ONE definition, four doors (GetTask · ListTasks · the stream · the SendMessage replay) ───────────


async def _profile_only_agent(w, org, project):
    """an agent placed by PROFILE alone: an active `team_members` row (the view's profile branch), no `members`-side access grant — the shape `_get_agent_member` resolves and `has_project_access` does not know."""
    from app.models.member import AgentProjectProfile

    agent = await w.add_agent(org)
    async with w.Session() as s:
        s.add(AgentProjectProfile(id=uuid.uuid4(), member_id=agent, project_id=project))
        await s.commit()
    return agent


async def _a2a_task(w, org, agent, *, project, seated, room=None):
    """a finished A2A task of `agent` in a room (made here, or `room`) whose participants are `seated`; returns (task id, replay key, marker, room id)."""
    from app.models.a2a_task import A2ATask
    from app.models.conversation import Conversation, ConversationParticipant

    marker = f"answer-{uuid.uuid4().hex[:10]}"
    task_id, cm = uuid.uuid4(), f"cm-{uuid.uuid4().hex[:8]}"
    async with w.Session() as s:
        if room is None:
            room = uuid.uuid4()
            s.add(Conversation(id=room, project_id=project, org_id=org, type="group", title="A2A task"))
            await s.flush()
            for m in seated:
                s.add(ConversationParticipant(conversation_id=room, member_id=m))
        s.add(A2ATask(
            id=task_id, context_id=room, root_message_id=uuid.uuid4(), member_id=agent, state="TASK_STATE_COMPLETED", client_message_id=cm, artifacts=[],
            history=[{"messageId": str(uuid.uuid4()), "role": "ROLE_AGENT", "parts": [{"text": marker}]}],
        ))
        await s.commit()
    return task_id, cm, marker, room


async def _four_doors(w, ot, agent, task_id, cm, marker) -> dict:
    """does the task's marker come back through each of the four doors?"""
    async def call(method, params):
        r = await w.client.post(f"/api/v2/a2a/members/{agent}/rpc", headers=_H(ot), json={"jsonrpc": "2.0", "id": 1, "method": method, "params": params})
        return r.text

    send = {"message": {"messageId": cm, "role": "ROLE_USER", "parts": [{"text": "again"}]}}
    return {
        "get": marker in await call("GetTask", {"id": str(task_id)}),
        "list": marker in await call("ListTasks", {}),
        "replay": marker in await call("SendMessage", send),
        "stream": marker in await call("SendStreamingMessage", send),
    }


async def _list_says(w, agent, org, room) -> bool:
    """the SQL form asked directly: is the task of this room among what ListTasks's condition lets through?"""
    from sqlalchemy import select

    from app.models.a2a_task import A2ATask
    from app.services.conversation_auth import member_reads_room_clause

    async with w.Session() as s:
        return bool((await s.execute(
            select(A2ATask.id).where(A2ATask.context_id == room, member_reads_room_clause(A2ATask.context_id, org_id=org, member_id=agent, is_agent=True))
        )).first())


async def _python_says(w, agent, org, room) -> bool:
    from app.services.conversation_auth import member_reads_room_now

    async with w.Session() as s:
        return await member_reads_room_now(s, conversation_id=room, org_id=org, member_id=agent, is_agent=True)


ALL = {"get": True, "list": True, "replay": True, "stream": True}
NONE = {"get": False, "list": False, "replay": False, "stream": False}


async def test_17_the_a2a_gate_lets_the_agent_in_its_own_room_through_all_four_doors_and_keeps_every_other_out_of_all_four():
    engine, w = await _world()
    try:
        org, ot, pid, chan = await _owner_and_channel(w)

        # (a) an agent placed by profile alone, in its own task room: read through all four doors, and listed
        prof = await _profile_only_agent(w, org, pid)
        t, cm, marker, room = await _a2a_task(w, org, prof, project=pid, seated=[prof])
        assert await _four_doors(w, ot, prof, t, cm, marker) == ALL, "an agent placed by profile alone was refused its own task room"
        assert await _python_says(w, prof, org, room) is True and await _list_says(w, prof, org, room) is True

        # (b) a task whose agent is not in the room (not the one it was handed to · no seat): refused at all four, by both forms
        other = await _profile_only_agent(w, org, pid)
        t, cm, marker, room = await _a2a_task(w, org, prof, project=pid, seated=[other])
        assert await _four_doors(w, ot, prof, t, cm, marker) == NONE, "a task of an agent that is no participant of its room was handed back"
        assert await _python_says(w, prof, org, room) is False and await _list_says(w, prof, org, room) is False

        # (c) a deactivated agent: the route itself turns it away at all four; and in a room WITHOUT a project (where the project term asks nothing) the gate still refuses it — in both forms
        gone = await _profile_only_agent(w, org, pid)
        t, cm, marker, room = await _a2a_task(w, org, gone, project=pid, seated=[gone])
        _t2, _cm2, _m2, bare_room = await _a2a_task(w, org, gone, project=None, seated=[gone])
        assert await _python_says(w, gone, org, bare_room) is True and await _list_says(w, gone, org, bare_room) is True, "control: while active, a room without a project is read"
        r = await w.client.delete(f"/api/v2/team-members/{gone}", headers=_H(ot))
        assert r.status_code == 200, r.text
        assert await _four_doors(w, ot, gone, t, cm, marker) == NONE
        assert await _python_says(w, gone, org, room) is False and await _list_says(w, gone, org, room) is False
        assert await _python_says(w, gone, org, bare_room) is False and await _list_says(w, gone, org, bare_room) is False, "a deactivated agent passed in a room that has no project"

        # (d) a task whose room is the project's CHANNEL: while the agent holds the project (grant + profile) it reads; with the grant gone and the profile (and the seat) left — the channel's own rule — refused at all four
        held, _key = await _add_agent(w, org, ot, pid)
        # (the grant route placed it with a profile too: both rows exist)
        t, cm, marker, room = await _a2a_task(w, org, held, project=pid, seated=[], room=chan)
        assert held in await _participants(w, chan)
        assert await _four_doors(w, ot, held, t, cm, marker) == ALL, "control: an agent that holds the project reads the task of the channel"
        await w.sql("DELETE FROM project_access WHERE project_id = :p AND member_id = :m", p=pid, m=held)
        assert held in await _participants(w, chan) and await _q(w, "SELECT 1 FROM agent_project_profiles WHERE member_id = :m AND project_id = :p", m=held, p=pid)
        assert await _four_doors(w, ot, held, t, cm, marker) == NONE, "an agent that lost the channel's project read the channel through its task"
        assert await _python_says(w, held, org, room) is False and await _list_says(w, held, org, room) is False
    finally:
        await _close(engine, w)
