"""story #4846 (main hotfix, promotion 10 prerequisite) — the release that is on main today must run on a database whose chat rows may have NO project.

Migrations 0471 / 0472 (coming with the next promotion) make `conversations.project_id` and `events.project_id` nullable and turn their foreign keys into `ON DELETE SET NULL`.
A migration is never rolled back (RUNBOOK: «a migration must work with the previous image too»), so for the moment between «the migration ran» and «the new image serves», and for
any rollback after it, THIS release meets rows with no project: a room made without a project by the new release, its chat event rows, a project deleted by this release
(SET NULL keeps the rows). Before this hotfix three response models required a project and answered 500 for such a row (the bell list, `/events/pending`, `/events/{id}/delivered`).

The test applies the same two `DROP NOT NULL` the migration does (this file is a destructive-schema file: its database is its own), seeds rows with no project and reads them back
through every road this release has for them.
"""
from __future__ import annotations

import os
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


async def _world():
    """an organization with one project; a person and an agent in it; a room WITH the project and a room WITHOUT one, both with the two in them; chat event rows with no project for both."""
    from sqlalchemy import text

    from app.models.event import Event

    import app.models  # noqa: F401 — every model on the metadata
    from app.core.database import Base

    engine, Session = await _session_factory()
    async with engine.begin() as conn:  # the destructive-schema reset leaves the database empty: this file builds the tables it reads
        await conn.run_sync(Base.metadata.create_all)
    async with Session() as s:
        # what 0471 / 0472 do to the two columns (the foreign-key swap is not needed for reading)
        await s.execute(text("ALTER TABLE conversations ALTER COLUMN project_id DROP NOT NULL"))
        await s.execute(text("ALTER TABLE events ALTER COLUMN project_id DROP NOT NULL"))
        await s.commit()
        org = await _make_org(s)
        p1 = await _make_project(s, org.id, "P1")
        h, u = await _make_human_member(s, org.id, p1.id)
        g = await _make_agent_member(s, org.id, p1.id)
        g = g if isinstance(g, uuid.UUID) else g.id
        with_project = await _make_conversation(s, org.id, p1.id, [h, g], h, "group")
        without_project = await _make_conversation(s, org.id, None, [h, g], h, "group")
        events = {}
        for who, rtype in ((h, "human"), (g, "agent")):
            ev = Event(
                project_id=None, org_id=org.id, event_type="conversation.message_created", source_entity_type="conversation_message", source_entity_id=uuid.uuid4(),
                sender_id=h, recipient_id=who, recipient_type=rtype, status="pending",
                payload={"id": str(uuid.uuid4()), "conversation_id": str(without_project), "content": "a line in a room with no project"},
            )
            s.add(ev)
            events[rtype] = ev
        await s.commit()
        ids = {k: v.id for k, v in events.items()}
    return engine, Session, org.id, p1.id, h, u, g, with_project, without_project, ids


async def _call(Session, kind, user, org, method, path):
    from app.main import app

    await (_setup_app_human if kind == "human" else _setup_app_agent)(app, Session, user, org)
    try:
        async with _client_for(app) as c:
            return await c.request(method, path)
    finally:
        app.dependency_overrides.clear()


async def test_the_bell_list_and_its_mark_read_answer_for_a_chat_event_with_no_project():
    engine, Session, org, p1, h, u, g, with_project, without_project, ids = await _world()
    try:
        r = await _call(Session, "human", u, org, "GET", "/api/v2/event-notifications?limit=100")
        assert r.status_code == 200, r.text
        row = [i for i in r.json() if i["id"] == str(ids["human"])]
        assert row and row[0]["project_id"] is None, r.text
        r = await _call(Session, "human", u, org, "PATCH", f"/api/v2/event-notifications/{ids['human']}/read")
        assert r.status_code == 200 and r.json()["project_id"] is None, r.text
    finally:
        await engine.dispose()


async def test_pending_and_delivered_answer_for_a_chat_event_with_no_project():
    engine, Session, org, p1, h, u, g, with_project, without_project, ids = await _world()
    try:
        r = await _call(Session, "agent", g, org, "GET", f"/api/v2/events/pending?recipient_id={g}")
        assert r.status_code == 200, r.text
        row = [i for i in r.json() if i["id"] == str(ids["agent"])]
        assert row and row[0]["project_id"] is None, r.text
        r = await _call(Session, "agent", g, org, "PATCH", f"/api/v2/events/{ids['agent']}/delivered")
        assert r.status_code == 200 and r.json()["project_id"] is None, r.text
    finally:
        await engine.dispose()


async def test_the_room_roads_do_not_fail_for_a_room_with_no_project():
    """the person's room list, the room itself and its messages: whatever this release answers for a room it has no project to place, it is not a server error."""
    engine, Session, org, p1, h, u, g, with_project, without_project, ids = await _world()
    try:
        r = await _call(Session, "human", u, org, "GET", f"/api/v2/conversations?project_id={p1}")
        assert r.status_code == 200, r.text
        assert str(with_project) in r.text                                                     # control: the room WITH the project is listed as always
        for path in (f"/api/v2/conversations/{without_project}", f"/api/v2/conversations/{without_project}/messages", f"/api/v2/conversations/{with_project}"):
            r = await _call(Session, "human", u, org, "GET", path)
            assert r.status_code < 500, (path, r.status_code, r.text)
        r = await _call(Session, "human", u, org, "GET", "/api/v2/activity-stream?limit=20")
        assert r.status_code < 500, r.text
    finally:
        await engine.dispose()


async def test_a_backfill_frame_and_a_gateway_replay_row_carry_no_project_as_none_not_the_text_none():
    """the two SSE builders turn the row into a frame: a missing project is a missing key / null, never the string 'None'."""
    from types import SimpleNamespace

    from app.models.event import Event
    from app.routers.agent_gateway import _row_to_payload
    from app.routers.events import _backfill_frame_data, _event_to_payload

    engine, Session, org, p1, h, u, g, with_project, without_project, ids = await _world()
    try:
        async with Session() as s:
            ev = await s.get(Event, ids["agent"])
            frame = _backfill_frame_data(ev, org, {})
            assert "None" not in {str(v) for v in (frame.get("project_id"),) if v is not None}, frame
            assert _event_to_payload(ev) is not None
        row = SimpleNamespace(
            event_id=str(ids["agent"]), event_type="conversation.message_created", source_entity_type="conversation_message", source_entity_id=None, sender_id=str(h),
            payload={"content": "x", "conversation_id": str(without_project)}, created_at=__import__("datetime").datetime.now(__import__("datetime").timezone.utc),
            recipient_seq=1, project_id=None, org_id=str(org), conversation_title=None, recipient_id=str(g), created_xid=None,
        )
        out = _row_to_payload(row)
        assert out.get("project_id") in (None, ""), out
    finally:
        await engine.dispose()


async def test_the_conversation_response_model_takes_a_room_with_no_project():
    """the model every single-room answer is built from: a room that has no project (a new-release room, or one whose project was deleted) is a valid answer, project_id null."""
    from app.models.conversation import Conversation
    from app.routers.conversations import ConversationResponse

    engine, Session, org, p1, h, u, g, with_project, without_project, ids = await _world()
    try:
        async with Session() as s:
            room = await s.get(Conversation, without_project)
            fields = {n: getattr(room, n, None) for n in ConversationResponse.model_fields if n != "participants" and hasattr(room, n)}
            out = ConversationResponse.model_validate({**fields, "participants": []}) if "participants" in ConversationResponse.model_fields else ConversationResponse.model_validate(fields)
        assert out.project_id is None
    finally:
        await engine.dispose()


async def test_an_attachment_upload_into_a_room_with_no_project_is_refused_not_stored_under_the_text_none():
    """the MCP upload builds `org/<org>/project/<project>/chat/<room>/…`: a room with no project has no such path — refused (422) before anything is stored; the room WITH a project is as before."""
    import base64

    from app.main import app

    engine, Session, org, p1, h, u, g, with_project, without_project, ids = await _world()
    try:
        await _setup_app_human(app, Session, u, org)
        body = {"content_base64": base64.b64encode(b"hello").decode(), "name": "note.txt", "content_type": "text/plain"}
        try:
            async with _client_for(app) as c:
                r = await c.post(f"/api/v2/conversations/{without_project}/attachments", json=body)
        finally:
            app.dependency_overrides.clear()
        assert r.status_code == 422 and "project" in r.text.lower(), (r.status_code, r.text)
        assert "project/None" not in r.text
    finally:
        await engine.dispose()


def test_no_project_is_no_attachment_scope_but_a_manual_source_keeps_its_free_path():
    from app.services.asset_registry import path_in_source_scope

    org, room = uuid.uuid4(), uuid.uuid4()
    assert path_in_source_scope(f"org/{org}/project/None/chat/{room}/f.png", "conversation_message", None, room, org_id=org) is False
    assert path_in_source_scope(f"chat/None/{room}/f.png", "conversation_message", None, room) is False
    assert path_in_source_scope("anything/at/all.png", "manual", None, room) is True                      # unchanged: manual sources carry no path rule
    proj = uuid.uuid4()
    assert path_in_source_scope(f"org/{org}/project/{proj}/chat/{room}/f.png", "conversation_message", proj, room, org_id=org) is True   # the normal case, unchanged


async def test_a_member_who_is_not_in_a_group_room_with_no_project_cannot_post_into_it_or_join_it():
    """kadir's lens on this change: the member check of `send_message` has no project to check for a room without one, and the auto-join of a group room would seat any member of the
    organization who knows the room's id. This release cannot see such a room (its reads answer 404), so the write answers the same 404 — and nobody is seated."""
    from sqlalchemy import func, select

    from app.main import app
    from app.models.conversation import ConversationParticipant

    engine, Session, org, p1, h, u, g, with_project, without_project, ids = await _world()
    try:
        async with Session() as s:
            p2 = await _make_project(s, org, "P2")
            outsider, u_out = await _make_human_member(s, org, p2.id)        # in the organization, NOT in the room, no access to P1

        async def count():
            async with Session() as s:
                return (await s.execute(select(func.count()).select_from(ConversationParticipant).where(ConversationParticipant.conversation_id == without_project))).scalar_one()

        async def post(user, room):
            await _setup_app_human(app, Session, user, org)
            try:
                async with _client_for(app) as c:
                    return await c.post(f"/api/v2/conversations/{room}/messages", json={"content": "let me in", "mentioned_ids": []})
            finally:
                app.dependency_overrides.clear()

        before = await count()
        r = await post(u_out, without_project)
        assert r.status_code == 404, (r.status_code, r.text)
        assert await count() == before, "nobody is seated by a refused post"
        r = await post(u_out, with_project)                                    # control: a room WITH a project asks the project of the member, as always
        assert r.status_code == 403, (r.status_code, r.text)
    finally:
        await engine.dispose()
