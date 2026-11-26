"""story 5034 (C4 step 4) — «show a card in chat» (`POST /api/v2/conversations/{id}/card`), on a real database and the real HTTP routes.

Red when: a person (not an agent key) can call it · an agent can show an object of a project it has no access to · «missing» and «not yours» are told apart to the AGENT (the answers are byte-identical: 404, no list, no hint) ·
the refused card is not posted (the room's people never learn that the agent was refused) · the two refused cards (missing / not yours) differ in shape (an existence oracle for an agent that reads the room) · an agent that is not in the
room can post one · a kind outside the tool's list is accepted · the card is posted with anything but the two (or three) words.
"""
from __future__ import annotations

import uuid

import pytest
from sqlalchemy import text

from tests.test_4846_ac14_room_reads_realdb import _as
from tests.test_4846_org_chat_rooms_realdb import (  # noqa: F401 — fixtures used by name
    _REAL_DB_URL,
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


async def _story(Session, w, project, title="a story"):
    from app.models.pm import Story

    async with Session() as s:
        row = Story(id=uuid.uuid4(), org_id=w.org, project_id=project, title=title, status="backlog")
        s.add(row)
        await s.commit()
        return row.id


async def _cards(Session, room):
    async with Session() as s:
        rows = (await s.execute(text("SELECT sender_id, metadata FROM conversation_messages WHERE conversation_id = :c ORDER BY created_at"), {"c": room})).all()
    return [(r[0], (r[1] or {}).get("card")) for r in rows if (r[1] or {}).get("card")]


async def _texts(Session, room):
    async with Session() as s:
        rows = (await s.execute(text("SELECT content, metadata FROM conversation_messages WHERE conversation_id = :c ORDER BY created_at"), {"c": room})).all()
    return [r[0] for r in rows if (r[1] or {}).get("card")]


def _url(room):
    return f"/api/v2/conversations/{room}/card"


async def test_an_agent_shows_an_object_of_its_project_and_it_is_posted_as_its_card():
    engine, Session, w = await _world()
    try:
        sid = await _story(Session, w, w.p1)
        r = await _as(Session, w, "agent_participant", "POST", _url(w.r_human), {"kind": "story", "ref": str(sid), "note": "the story we talked about"})
        assert r.status_code == 201, r.text
        cards = await _cards(Session, w.r_human)
        assert cards == [(w.g_p, {"kind": "story", "ref": str(sid)})], cards  # the agent's own message · two words only
        assert await _texts(Session, w.r_human) == ["the story we talked about"]  # the agent's own sentence is kept
        listed = await _as(Session, w, "participant", "GET", f"/api/v2/conversations/{w.r_human}/messages")
        rows = listed.json().get("data") or listed.json()
        assert [m["card"] for m in rows if m["card"]] == [{"kind": "story", "ref": str(sid)}]
        r2 = await _as(Session, w, "agent_participant", "POST", _url(w.r_human), {"kind": "story", "ref": str(sid)})
        assert r2.status_code == 201, r2.text
        plain = (await _texts(Session, w.r_human))[-1]
        assert plain != "story" and str(sid) not in plain and len(plain.split()) >= 2, plain  # no note → a line a first-time reader understands, not the bare kind word
    finally:
        await engine.dispose()


async def test_an_object_the_agent_cannot_see_and_one_that_does_not_exist_get_the_SAME_404_for_the_agent_and_the_SAME_refused_card_in_the_room():
    engine, Session, w = await _world()
    try:
        other_project = await _story(Session, w, w.p2)  # exists, but the agent has no access to P2
        missing = uuid.uuid4()                           # does not exist
        answers = []
        for ref in (other_project, missing):
            r = await _as(Session, w, "agent_participant", "POST", _url(w.r_human), {"kind": "story", "ref": str(ref)})
            answers.append((r.status_code, r.text))
        assert answers[0][0] == 404 and answers[0] == answers[1], answers  # byte-identical: no list, no hint, no difference
        assert "refused" not in answers[0][1] and "agent" not in answers[0][1].lower()
        cards = await _cards(Session, w.r_human)
        assert len(cards) == 2, cards  # both refusals are posted
        for (sender, card), ref in zip(cards, (other_project, missing)):
            assert sender == w.g_p
            assert card == {"kind": "story", "ref": str(ref), "refused_for": str(w.g_p)}, card  # the same SHAPE either way — an agent reading the room learns nothing more
        texts = await _texts(Session, w.r_human)
        assert len(texts) == 2 and texts[0] == texts[1], texts  # the same LINE either way
        assert texts[0] != "story" and all(str(x) not in texts[0] for x in (other_project, missing, w.g_p)), texts  # words, naming no object and no agent
    finally:
        await engine.dispose()


@pytest.mark.parametrize("caller", ["participant", "org_owner", "member_outside"])
async def test_a_person_cannot_use_it(caller):
    engine, Session, w = await _world()
    try:
        sid = await _story(Session, w, w.p1)
        r = await _as(Session, w, caller, "POST", _url(w.r_human), {"kind": "story", "ref": str(sid)})
        assert r.status_code == 403 and "agents only" in r.text, r.text
        assert await _cards(Session, w.r_human) == []
    finally:
        await engine.dispose()


async def test_an_agent_that_is_not_in_the_room_cannot_post_there_whatever_it_asks_for():
    engine, Session, w = await _world()
    try:
        sid = await _story(Session, w, w.p1)
        r = await _as(Session, w, "agent_plain", "POST", _url(w.r_human), {"kind": "story", "ref": str(sid)})
        assert r.status_code == 403, r.text
        assert await _cards(Session, w.r_human) == []
    finally:
        await engine.dispose()


@pytest.mark.parametrize("body", [
    {"kind": "gate", "ref": "0d6e953f-6d43-42c1-a87c-b023544497db"},
    {"kind": "deploy", "ref": "0d6e953f-6d43-42c1-a87c-b023544497db"},
    {"kind": "timeline", "ref": "0d6e953f-6d43-42c1-a87c-b023544497db"},
    {"kind": "story", "ref": "not-a-uuid"},
    {"kind": "story", "ref": "0d6e953f-6d43-42c1-a87c-b023544497db", "refused_for": "0d6e953f-6d43-42c1-a87c-b023544497db"},
    {"kind": "story", "ref": "0d6e953f-6d43-42c1-a87c-b023544497db", "html": "<b>"},
    {"kind": "story"},
])
async def test_a_kind_outside_the_tools_list_or_anything_but_kind_ref_note_is_refused(body):
    engine, Session, w = await _world()
    try:
        r = await _as(Session, w, "agent_participant", "POST", _url(w.r_human), body)
        assert r.status_code == 422, (body, r.text)
        assert await _cards(Session, w.r_human) == []
    finally:
        await engine.dispose()


async def test_a_board_is_its_sprints_object_a_sprint_of_another_project_is_refused_like_any_other():
    engine, Session, w = await _world()
    try:
        from app.models.pm import Sprint

        async with Session() as s:
            mine = Sprint(id=uuid.uuid4(), org_id=w.org, project_id=w.p1, title="S1", status="active")
            theirs = Sprint(id=uuid.uuid4(), org_id=w.org, project_id=w.p2, title="S2", status="active")
            s.add_all([mine, theirs])
            await s.commit()
            mine_id, theirs_id = mine.id, theirs.id
        ok = await _as(Session, w, "agent_participant", "POST", _url(w.r_human), {"kind": "kanban", "ref": str(mine_id)})
        assert ok.status_code == 201, ok.text
        no = await _as(Session, w, "agent_participant", "POST", _url(w.r_human), {"kind": "kanban", "ref": str(theirs_id)})
        assert no.status_code == 404, no.text
        kinds = [c for _s, c in await _cards(Session, w.r_human)]
        assert kinds == [{"kind": "kanban", "ref": str(mine_id)}, {"kind": "kanban", "ref": str(theirs_id), "refused_for": str(w.g_p)}], kinds
    finally:
        await engine.dispose()
