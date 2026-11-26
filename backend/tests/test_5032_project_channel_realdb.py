"""story #5032 (C2 · «a channel is a project» — server piece 1) — real Postgres, real HTTP routes.

Pinned here (PO decision: no new `type` value — a `group` room carrying `conversations.is_project_channel`, at most one per project):
- migration 0502: the column exists and defaults to false; the partial unique index refuses a SECOND channel for one project and allows any number of
  rooms that are not a channel (and a channel whose project is gone);
- the list and the single GET carry `is_project_channel` (channel true · ordinary room false);
- `ensure_project_channel`: first call makes it (group · title = project name · participant = the creator), the second returns the same room, a lost
  race reads the winner's room;
- creating a project sets its channel up (the creating person or agent is its participant) and a channel that cannot be set up never fails the project;
- an access grant (person or agent) seats them in the channel — setting it up first for a project that has none — and a revoke takes them out;
- renaming the project retitles the channel.
"""
from __future__ import annotations

import uuid

import pytest
from sqlalchemy import text
from sqlalchemy.exc import IntegrityError

from tests.test_1994_backlink_api_realdb import _make_agent_member, _make_human_member
from tests.test_4846_ac14_room_reads_realdb import _as
from tests.test_4846_org_chat_rooms_realdb import (  # noqa: F401 — fixtures used by name
    _REAL_DB_URL,
    _callers,
    _dispose_global_engine_after_test,
    _world,
)

pytestmark = [
    pytest.mark.skipif(not _REAL_DB_URL, reason="real Postgres 필요"),
    pytest.mark.anyio,
]


@pytest.fixture
def anyio_backend():
    return "asyncio"


async def _create_project(Session, w, caller, name):
    r = await _as(Session, w, caller, "POST", "/api/v2/projects", {"name": name, "org_id": str(w.org)})
    assert r.status_code == 201, r.text
    body = r.json()
    return (body.get("data") or body)["id"]


async def _channel_rows(Session, project_id):
    async with Session() as s:
        return (await s.execute(
            text("SELECT id, type, title, created_by, org_id FROM conversations WHERE project_id = :p AND is_project_channel"),
            {"p": str(project_id)},
        )).all()


async def _participants(Session, conv_id):
    async with Session() as s:
        rows = (await s.execute(
            text("SELECT member_id FROM conversation_participants WHERE conversation_id = :c"), {"c": str(conv_id)},
        )).scalars().all()
    return {str(r) for r in rows}


# ── migration 0502 ────────────────────────────────────────────────────────────────────────────────────────


async def test_the_column_defaults_to_false_and_the_partial_unique_index_has_the_agreed_shape():
    engine, Session, w = await _world()
    try:
        async with Session() as s:
            col = (await s.execute(text(
                "SELECT is_nullable, column_default, data_type FROM information_schema.columns "
                "WHERE table_name = 'conversations' AND column_name = 'is_project_channel'"
            ))).one()
            assert col.data_type == "boolean" and col.is_nullable == "NO" and col.column_default == "false"
            # a row written without saying anything about it is not a channel — the existing rooms of the world are all false
            n_true = (await s.execute(text(
                "SELECT count(*) FROM conversations WHERE org_id = :o AND is_project_channel"), {"o": str(w.org)})).scalar_one()
            assert n_true == 0
            idx = (await s.execute(text(
                "SELECT indexdef FROM pg_indexes WHERE indexname = 'uq_conversations_project_channel'"))).scalar_one()
            assert "UNIQUE" in idx and "(project_id)" in idx and "is_project_channel" in idx and "project_id IS NOT NULL" in idx
    finally:
        await engine.dispose()


async def _insert_room(s, org, project, *, channel):
    await s.execute(
        text(
            "INSERT INTO conversations (id, org_id, project_id, type, status, is_project_channel) "
            "VALUES (gen_random_uuid(), :o, :p, 'group', 'open', :c)"
        ),
        {"o": str(org), "p": str(project) if project else None, "c": channel},
    )


async def test_two_channels_for_one_project_are_refused_but_many_ordinary_rooms_and_other_projects_are_not():
    engine, Session, w = await _world()
    try:
        async with Session() as s:
            await _insert_room(s, w.org, w.p1, channel=True)
            await s.commit()
        async with Session() as s:
            with pytest.raises(IntegrityError) as ei:
                await _insert_room(s, w.org, w.p1, channel=True)
                await s.commit()
            assert "uq_conversations_project_channel" in str(ei.value.orig)
        async with Session() as s:
            # not a channel: any number (the world already holds several P1 rooms)
            await _insert_room(s, w.org, w.p1, channel=False)
            await _insert_room(s, w.org, w.p1, channel=False)
            # another project has its own channel; a channel with no project (the project was deleted → SET NULL) is outside the index
            await _insert_room(s, w.org, w.p2, channel=True)
            await _insert_room(s, w.org, None, channel=True)
            await _insert_room(s, w.org, None, channel=True)
            await s.commit()
    finally:
        await engine.dispose()


# ── the response field ────────────────────────────────────────────────────────────────────────────────────


async def test_list_and_single_get_carry_is_project_channel_true_for_the_channel_false_for_other_rooms():
    engine, Session, w = await _world()
    try:
        pid = await _create_project(Session, w, "participant", "chan-resp")
        (chan,) = await _channel_rows(Session, pid)
        conv_id = str(chan.id)

        r = await _as(Session, w, "participant", "GET", f"/api/v2/conversations/{conv_id}")
        assert r.status_code == 200, r.text
        assert r.json()["is_project_channel"] is True
        r = await _as(Session, w, "participant", "GET", f"/api/v2/conversations/{w.r_human}")
        assert r.status_code == 200, r.text
        assert r.json()["is_project_channel"] is False

        r = await _as(Session, w, "participant", "GET", "/api/v2/conversations", None)
        assert r.status_code == 200, r.text
        rows = {x["id"]: x for x in r.json()["data"]}
        assert rows[conv_id]["is_project_channel"] is True
        assert rows[str(w.r_human)]["is_project_channel"] is False
    finally:
        await engine.dispose()


# ── ensure_project_channel ────────────────────────────────────────────────────────────────────────────────


async def test_ensure_makes_the_channel_once_and_returns_the_same_room_after():
    from app.models.project import Project
    from app.services.project_channel import ensure_project_channel

    engine, Session, w = await _world()
    try:
        async with Session() as s:
            project = (await s.get(Project, w.p2))
            first = await ensure_project_channel(s, org_id=w.org, project=project, creator_member_id=w.h_d)
            await s.commit()
            second = await ensure_project_channel(s, org_id=w.org, project=project, creator_member_id=w.h_a)
            await s.commit()
        assert first.id == second.id
        assert first.type == "group" and first.is_project_channel is True and first.title == project.name and first.project_id == w.p2
        assert first.created_by == w.h_d
        assert await _participants(Session, first.id) == {str(w.h_d)}, "the creator alone — the second call (another creator) touched nobody"
        assert len(await _channel_rows(Session, w.p2)) == 1
    finally:
        await engine.dispose()


async def test_a_lost_race_reads_the_winners_room_and_leaves_the_callers_transaction_usable(monkeypatch):
    """two requests both find no channel: the second's insert meets the unique index and must return the first's room, not raise or poison the transaction"""
    from app.models.project import Project
    from app.services import project_channel as pc

    engine, Session, w = await _world()
    try:
        async with Session() as s:
            winner = await pc.ensure_project_channel(s, org_id=w.org, project=await s.get(Project, w.p2), creator_member_id=w.h_d)
            await s.commit()
        real = pc.get_project_channel
        calls = {"n": 0}

        async def blind_once(db, *, project_id):
            calls["n"] += 1
            return None if calls["n"] == 1 else await real(db, project_id=project_id)

        monkeypatch.setattr(pc, "get_project_channel", blind_once)
        async with Session() as s:
            loser = await pc.ensure_project_channel(s, org_id=w.org, project=await s.get(Project, w.p2), creator_member_id=w.h_a)
            assert loser.id == winner.id
            assert calls["n"] == 2, "the first read saw nothing, the insert collided, the second read found the winner's room"
            assert (await s.execute(text("SELECT 1"))).scalar_one() == 1, "the transaction is still usable"
            await s.commit()
        assert len(await _channel_rows(Session, w.p2)) == 1
        assert await _participants(Session, winner.id) == {str(w.h_d)}, "the loser seated nobody"
    finally:
        await engine.dispose()


# ── creating a project ────────────────────────────────────────────────────────────────────────────────────


async def test_creating_a_project_sets_up_its_channel_with_the_creating_person_in_it():
    engine, Session, w = await _world()
    try:
        pid = await _create_project(Session, w, "participant", "My Project 5032")
        rows = await _channel_rows(Session, pid)
        assert len(rows) == 1
        c = rows[0]
        assert c.type == "group" and c.title == "My Project 5032" and str(c.org_id) == str(w.org)
        assert str(c.created_by) == str(w.h_a)
        assert await _participants(Session, c.id) == {str(w.h_a)}
        async with Session() as s:
            n_msgs = (await s.execute(text("SELECT count(*) FROM conversation_messages WHERE conversation_id = :c"), {"c": str(c.id)})).scalar_one()
        assert n_msgs == 0, "set up quietly: no message"
        # the old rooms are not touched: still the same 'group' rooms with the mark off
        async with Session() as s:
            n = (await s.execute(text("SELECT count(*) FROM conversations WHERE project_id = :p AND is_project_channel"), {"p": str(w.p1)})).scalar_one()
        assert n == 0
    finally:
        await engine.dispose()


async def test_an_agent_that_creates_a_project_is_the_channels_participant():
    engine, Session, w = await _world()
    try:
        pid = await _create_project(Session, w, "agent_plain", "By An Agent 5032")
        (c,) = await _channel_rows(Session, pid)
        assert await _participants(Session, c.id) == {str(w.g_plain)}
    finally:
        await engine.dispose()


async def test_a_channel_that_cannot_be_made_never_fails_the_project(monkeypatch):
    from app.services import project_channel as pc

    async def boom(*_a, **_k):
        raise RuntimeError("channel broke")

    monkeypatch.setattr(pc, "ensure_project_channel", boom)
    engine, Session, w = await _world()
    try:
        pid = await _create_project(Session, w, "participant", "No Channel Yet 5032")
        assert await _channel_rows(Session, pid) == []
        async with Session() as s:
            assert (await s.execute(text("SELECT count(*) FROM projects WHERE id = :p"), {"p": pid})).scalar_one() == 1
            assert (await s.execute(text("SELECT count(*) FROM project_access WHERE project_id = :p"), {"p": pid})).scalar_one() == 1, "the creator's seat is there too"
    finally:
        await engine.dispose()


async def test_renaming_the_project_retitles_its_channel():
    engine, Session, w = await _world()
    try:
        pid = await _create_project(Session, w, "participant", "Before 5032")
        r = await _as(Session, w, "participant", "PATCH", f"/api/v2/projects/{pid}", {"name": "After 5032"})
        assert r.status_code == 200, r.text
        (c,) = await _channel_rows(Session, pid)
        assert c.title == "After 5032"
    finally:
        await engine.dispose()


# ── access grant / revoke ─────────────────────────────────────────────────────────────────────────────────


async def test_granting_an_agent_access_seats_it_in_the_channel_and_revoking_takes_it_out():
    engine, Session, w = await _world()
    try:
        pid = await _create_project(Session, w, "participant", "Grant Agent 5032")
        async with Session() as s:
            other_agent = await _make_agent_member(s, w.org, w.p2)   # an agent of the organization with no seat on this project
        (c,) = await _channel_rows(Session, pid)
        assert await _participants(Session, c.id) == {str(w.h_a)}

        r = await _as(Session, w, "org_owner", "POST", f"/api/v2/projects/{pid}/access", {"member_id": str(other_agent)})
        assert r.status_code == 201, r.text
        record_id = r.json()["id"]
        assert await _participants(Session, c.id) == {str(w.h_a), str(other_agent)}

        r = await _as(Session, w, "org_owner", "DELETE", f"/api/v2/projects/{pid}/access/{record_id}")
        assert r.status_code == 200, r.text
        assert await _participants(Session, c.id) == {str(w.h_a)}
    finally:
        await engine.dispose()


async def test_granting_a_person_access_seats_them_in_the_channel_and_revoking_takes_them_out():
    engine, Session, w = await _world()
    try:
        pid = await _create_project(Session, w, "participant", "Grant Person 5032")
        async with Session() as s:
            other, _user = await _make_human_member(s, w.org, w.p2)
        (c,) = await _channel_rows(Session, pid)

        r = await _as(Session, w, "org_owner", "POST", f"/api/v2/projects/{pid}/access", {"org_member_id": str(other)})
        assert r.status_code == 201, r.text
        record_id = r.json()["id"]
        assert await _participants(Session, c.id) == {str(w.h_a), str(other)}

        r = await _as(Session, w, "org_owner", "DELETE", f"/api/v2/projects/{pid}/access/{record_id}")
        assert r.status_code == 200, r.text
        assert await _participants(Session, c.id) == {str(w.h_a)}
    finally:
        await engine.dispose()


async def test_a_grant_on_a_project_that_has_no_channel_yet_sets_it_up_first():
    """projects made before this story have no channel: the first grant sets it up (title = the project's name), with the grantee as its participant"""
    engine, Session, w = await _world()
    try:
        assert await _channel_rows(Session, w.p2) == []
        async with Session() as s:
            agent = await _make_agent_member(s, w.org, w.p1)
        r = await _as(Session, w, "org_owner", "POST", f"/api/v2/projects/{w.p2}/access", {"member_id": str(agent)})
        assert r.status_code == 201, r.text
        (c,) = await _channel_rows(Session, w.p2)
        assert c.title == "P2"
        assert await _participants(Session, c.id) == {str(agent)}
        # …and a second grant reuses it
        r2 = await _as(Session, w, "org_owner", "POST", f"/api/v2/projects/{w.p2}/access", {"org_member_id": str(w.h_a)})
        assert r2.status_code == 201, r2.text
        (c2,) = await _channel_rows(Session, w.p2)
        assert c2.id == c.id and await _participants(Session, c.id) == {str(agent), str(w.h_a)}
    finally:
        await engine.dispose()


async def test_a_channel_that_cannot_be_updated_never_fails_the_grant(monkeypatch):
    from app.services import project_channel as pc

    async def boom(*_a, **_k):
        raise RuntimeError("channel broke")

    monkeypatch.setattr(pc, "add_project_channel_participant", boom)
    engine, Session, w = await _world()
    try:
        async with Session() as s:
            agent = await _make_agent_member(s, w.org, w.p1)
        r = await _as(Session, w, "org_owner", "POST", f"/api/v2/projects/{w.p2}/access", {"member_id": str(agent)})
        assert r.status_code == 201, r.text
        async with Session() as s:
            assert (await s.execute(text("SELECT count(*) FROM project_access WHERE project_id = :p AND member_id = :m"), {"p": str(w.p2), "m": str(agent)})).scalar_one() == 1
    finally:
        await engine.dispose()
