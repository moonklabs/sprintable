"""story #4846 (PR B) — the room's caller and its participants are judged by membership of the ORGANIZATION, not by the project.

- AC11: an agent that has lost every project (profile rows and grants gone — the state a deleted project leaves behind) is still an agent of the room: it
  reads and writes a room without a project it is in, and a room of such agents is still «agents only» for the organization owner.
- deleting a project keeps the chat event rows of its rooms (`events.project_id` FK `SET NULL`, migration 0472);
- the activity stream gets no row for an event without a project (and no violation is logged for it);
- a catalog slash command in a room without a project is answered with a result card carrying `ROOM_HAS_NO_PROJECT`;
- the routes of one room do not ask for the tab's project (`X-Project-Id`): being in the room is the access.
"""
from __future__ import annotations

import logging
import uuid

import pytest

from tests.test_1994_backlink_api_realdb import _client_for, _setup_app_agent, _setup_app_human
from tests.test_4846_org_chat_rooms_realdb import (  # noqa: F401 — fixtures used by name
    _REAL_DB_URL,
    _callers,
    _delete_project,
    _dispose_global_engine_after_test,
    _events,
    _post,
    _send,
    _status,
    _world,
)

pytestmark = [
    pytest.mark.skipif(not _REAL_DB_URL, reason="real Postgres 필요"),
    pytest.mark.anyio,
]


@pytest.fixture
def anyio_backend():
    return "asyncio"


async def _strip_every_project(Session, member_id):
    """The state a deleted project leaves an agent in: no profile row (so it is gone from the `team_members` view) and no grant."""
    from sqlalchemy import text

    async with Session() as s:
        await s.execute(text("DELETE FROM agent_project_profiles WHERE member_id = :m"), {"m": member_id})
        await s.execute(text("DELETE FROM project_access WHERE member_id = :m"), {"m": member_id})
        await s.commit()


async def test_an_agent_that_lost_every_project_still_reads_and_writes_the_room_without_a_project_it_is_in():
    engine, Session, w = await _world()
    try:
        assert await _status(Session, w, "agent_participant", w.n_human) == 200
        await _strip_every_project(Session, w.g_p)
        async with Session() as s:                      # it is gone from the view that the room code used to resolve an agent through
            from sqlalchemy import text

            assert (await s.execute(text("SELECT count(*) FROM team_members WHERE id = :m"), {"m": w.g_p})).scalar_one() == 0
        assert await _status(Session, w, "agent_participant", w.n_human) == 200          # was 400 «Team member not found»
        assert await _post(Session, w, w.g_p, w.n_human, agent=True) == 201
        # a room WITH a project is the one AC12 closes to it (stopping the agent there)
        assert await _status(Session, w, "agent_participant", w.r_human) == 403
        # an agent of another organization is no member here whatever its id (control)
        assert await _status(Session, w, "agent_plain", w.n_human) == 403
    finally:
        await engine.dispose()


async def test_a_room_of_agents_that_lost_their_projects_is_still_agents_only_for_the_organization_owner():
    """Through the `team_members` view such a room read as a room with a person in it (the agents were «not confirmed»), and the owner's view of agents' rooms closed."""
    engine, Session, w = await _world()
    try:
        assert await _status(Session, w, "org_owner", w.n_agents) == 200
        await _strip_every_project(Session, w.g_p)
        await _strip_every_project(Session, w.g_2)
        assert await _status(Session, w, "org_owner", w.n_agents) == 200
        # control: a room with one real person in it stays private to its participants
        assert await _status(Session, w, "org_owner", w.n_human) == 403
    finally:
        await engine.dispose()


async def test_deleting_a_project_keeps_the_chat_event_rows_of_its_rooms():
    from sqlalchemy import text

    engine, Session, w = await _world()
    try:
        msg = await _send(Session, w, w.r_human, mentioned=[w.g_p])
        before = await _events(Session, msg)
        assert before and {p for *_x, p, _s in before} == {w.p1}
        async with Session() as s:
            assert (await s.execute(text(
                "SELECT confdeltype::text FROM pg_constraint WHERE conrelid = 'events'::regclass AND contype = 'f' AND confrelid = 'projects'::regclass"
            ))).scalars().all() == ["n"]                  # the rule itself: ON DELETE SET NULL
        r = await _delete_project(Session, w, w.p1)
        assert r.status_code in (200, 204), r.text
        after = await _events(Session, msg)
        assert len(after) == len(before)                   # not one delivery row went with the project
        assert {p for *_x, p, _s in after} == {None}
    finally:
        await engine.dispose()


async def _activity_rows_for(Session, msg_id):
    from sqlalchemy import text

    async with Session() as s:
        return (await s.execute(text(
            "SELECT count(*) FROM activity_events a WHERE a.source_event_ids && "
            "ARRAY(SELECT id FROM events WHERE source_entity_id = :m)"
        ), {"m": msg_id})).scalar_one()


async def test_a_message_in_a_room_without_a_project_makes_no_activity_row_and_logs_no_violation(caplog):
    engine, Session, w = await _world()
    try:
        caplog.set_level(logging.WARNING)
        with_project = await _send(Session, w, w.r_human, mentioned=[w.g_p])
        no_project = await _send(Session, w, w.n_human, mentioned=[w.g_p])
        assert await _activity_rows_for(Session, no_project) == 0
        assert await _activity_rows_for(Session, with_project) > 0                  # control: a room with a project still feeds the stream
        assert not [r for r in caplog.records if "activity extractor skipped" in r.getMessage()], "the extraction must not even be tried for it"
    finally:
        await engine.dispose()


async def _command_cards(Session, room):
    from sqlalchemy import text

    async with Session() as s:
        return (await s.execute(text(
            "SELECT content, metadata->'server_command' AS sc FROM conversation_messages "
            "WHERE conversation_id = :c AND metadata ? 'server_command' ORDER BY created_at"
        ), {"c": room})).all()


async def _audit_rows(Session, room):
    from sqlalchemy import text

    async with Session() as s:
        return (await s.execute(text("SELECT count(*) FROM chat_command_audit_logs WHERE conversation_id = :c"), {"c": room})).scalar_one()


async def _say(Session, w, room, content):
    from app.main import app

    await _setup_app_human(app, Session, w.u_a, w.org)
    try:
        async with _client_for(app) as c:
            return await c.post(f"/api/v2/conversations/{room}/messages", json={"content": content})
    finally:
        app.dependency_overrides.clear()


async def test_a_catalog_command_in_a_room_without_a_project_is_answered_with_a_card_and_executes_nothing():
    engine, Session, w = await _world()
    try:
        for command in ("/done 1", "/assign 1 someone", "/priority 1 high"):
            r = await _say(Session, w, w.n_human, command)
            assert r.status_code == 201, (command, r.text)
        cards = await _command_cards(Session, w.n_human)
        assert [c.sc for c in cards] == [
            {"command": "done", "outcome": "denied", "code": "ROOM_HAS_NO_PROJECT"},
            {"command": "assign", "outcome": "denied", "code": "ROOM_HAS_NO_PROJECT"},
            {"command": "priority", "outcome": "denied", "code": "ROOM_HAS_NO_PROJECT"},
        ]
        assert all(c.content == "This command works in a room that has a project." for c in cards)
        assert await _audit_rows(Session, w.n_human) == 0                           # nothing was executed, so nothing is audited

        # a command that is not in the catalog is a plain message, as before
        r = await _say(Session, w, w.n_human, "/nothing-like-it please")
        assert r.status_code == 201
        assert len(await _command_cards(Session, w.n_human)) == 3

        # control: the same command in a room WITH a project is executed (here: no such story) and audited, and its card has no code
        r = await _say(Session, w, w.r_human, "/done 999999")
        assert r.status_code == 201
        cards = await _command_cards(Session, w.r_human)
        assert len(cards) == 1 and "code" not in cards[0].sc and cards[0].sc["command"] == "done"
        assert await _audit_rows(Session, w.r_human) == 1
    finally:
        await engine.dispose()


async def test_the_routes_of_one_room_do_not_ask_for_the_tabs_project():
    """A person who is in a room without a project, while their tab points at a project they have no access to, reads and writes the room; the room's own rule stays."""
    from app.main import app

    engine, Session, w = await _world()
    try:
        for caller in ("participant", "lost_project"):
            kind, _member, user = _callers(w)[caller]
            await _setup_app_human(app, Session, user, w.org)
            try:
                async with _client_for(app) as c:
                    # P2 is a project h_a cannot reach; P1 is one h_d cannot reach — the header names the one the caller lacks
                    lacking = w.p2 if caller == "participant" else w.p1
                    headers = {"X-Project-Id": str(lacking)}
                    assert (await c.get(f"/api/v2/conversations/{w.n_human}/messages", headers=headers)).status_code == 200, caller
                    assert (await c.get(f"/api/v2/conversations/{w.n_human}", headers=headers)).status_code == 200, caller
                    assert (await c.post(f"/api/v2/conversations/{w.n_human}/messages", json={"content": "x"}, headers=headers)).status_code == 201, caller
                    assert (await c.post(f"/api/v2/conversations/{w.n_human}/read", json={}, headers=headers)).status_code in (200, 204), caller
                    # control: the room rule is still the room's — a person who is not in the room is refused with the same header
            finally:
                app.dependency_overrides.clear()
        kind, _member, user = _callers(w)["member_outside"]
        await _setup_app_human(app, Session, user, w.org)
        try:
            async with _client_for(app) as c:
                assert (await c.get(f"/api/v2/conversations/{w.n_human}/messages", headers={"X-Project-Id": str(w.p1)})).status_code == 403
                # and a route that is NOT room-bound keeps the project gate (the unread count names a project the caller lacks)
                assert (await c.get("/api/v2/conversations/unread-count", headers={"X-Project-Id": str(w.p2)})).status_code == 403
        finally:
            app.dependency_overrides.clear()
    finally:
        await engine.dispose()


def _dependency_names(dependant):
    names = set()
    for dep in dependant.dependencies:
        if dep.call is not None:
            names.add(getattr(dep.call, "__name__", type(dep.call).__name__))
        names |= _dependency_names(dep)
    return names


async def test_every_route_of_one_room_checks_the_organization_only():
    """Not by sampling: every route whose path is under `/conversations/{conversation_id}` (and the attachment authorize route, which takes a room) is asked for its org
    dependency — none of them may carry the project header gate."""
    from fastapi.routing import APIRoute

    from app.main import app

    room_bound = [
        r for r in app.routes
        if isinstance(r, APIRoute) and (r.path.startswith("/api/v2/conversations/{conversation_id}") or r.path == "/api/v2/attachments/authorize")
    ]
    assert len(room_bound) >= 16, [r.path for r in room_bound]                    # the list is not accidentally empty
    for route in room_bound:
        names = _dependency_names(route.dependant)
        assert "get_verified_org_id_no_project_gate" in names, (route.path, route.methods)
        assert "get_verified_org_id" not in names, (route.path, route.methods)


async def test_a_key_claim_on_a_person_resolves_as_that_person_and_a_deleted_member_is_not_found():
    """The api-key branch of `_resolve_member` asks the `members` anchor for the id, whatever its type (before story #4846 the lookup did not filter by type either),
    so a person's id carrying an `api_key_id` claim is resolved AS A PERSON — never as an agent, never with a wider reach. A member that was deleted is not found: the
    `team_members` view the lookup used to go through left deleted members out (`deleted_at IS NULL`), and the anchor lookup keeps that part of the filter."""
    from fastapi import HTTPException
    from sqlalchemy import text

    from app.dependencies.auth import AuthContext
    from app.routers.conversations import _resolve_member, _resolve_room_member
    from tests.test_1994_backlink_api_realdb import _make_human_member

    engine, Session, w = await _world()
    try:
        async with Session() as s:
            member, _user = await _make_human_member(s, w.org, w.p1)
            person = member if isinstance(member, uuid.UUID) else member.id
            person_user = _user if isinstance(_user, uuid.UUID) else _user.id
        auth = AuthContext(user_id=str(person), email=None, claims={"app_metadata": {"api_key_id": str(uuid.uuid4()), "org_id": str(w.org)}}, org_id=str(w.org))
        async with Session() as s:
            resolved = await _resolve_member(auth, w.org, s, project_id=None)
            assert resolved.id == person and resolved.type == "human"      # a person stays a person (control: the lookup finds the live member)
            assert resolved.user_id == person_user                         # …and keeps the account the old row carried (the creator checks compare it)
        async with Session() as s:
            await s.execute(text("UPDATE members SET deleted_at = now() WHERE id = :m"), {"m": person})
            await s.commit()
        async with Session() as s:
            with pytest.raises(HTTPException) as e:
                await _resolve_member(auth, w.org, s, project_id=None)
            assert e.value.status_code == 400                               # was found (and then read and wrote a room without a project) once the type filter was lifted
            with pytest.raises(HTTPException) as e2:
                await _resolve_room_member(auth, w.org, s, w.n_human)
            assert e2.value.status_code == 403
    finally:
        await engine.dispose()


async def test_after_0472_a_new_event_row_naming_a_project_that_does_not_exist_is_refused_by_the_foreign_key():
    """0472 adds `events_project_id_fkey` `NOT VALID`: the rows that exist are not scanned, but every NEW row is checked at once. Measured here with a row whose every other
    column is filled (the same row with no project goes in — the control), so the refusal is the foreign key's and nothing else's."""
    from sqlalchemy.exc import IntegrityError

    from app.models.event import Event

    engine, Session, w = await _world()
    try:
        def _row(project_id):
            return Event(id=uuid.uuid4(), org_id=w.org, project_id=project_id, event_type="chat.message", recipient_id=w.g_p, recipient_type="agent", payload={})

        async with Session() as s:
            s.add(_row(None))                                                # control: no project is a valid event (a room without a project)
            s.add(_row(w.p1))                                                # control: a real project is a valid event
            await s.commit()
        async with Session() as s:
            s.add(_row(uuid.uuid4()))                                        # a project that does not exist
            with pytest.raises(IntegrityError) as e:
                await s.commit()
            assert "events_project_id_fkey" in str(e.value)
    finally:
        await engine.dispose()


async def test_an_agent_resolved_through_the_anchor_carries_its_runtime_kind():
    """The send path switches its server-publisher branch on `getattr(sender, "runtime_type")` (`system-publisher`), and the `team_members` row the lookup used to return carried it —
    so the caller resolved through the `members` anchor must carry the anchor's `runtime_type`, or every server-issued notice answers 403."""
    from sqlalchemy import text

    from app.dependencies.auth import AuthContext
    from app.routers.conversations import _resolve_member

    engine, Session, w = await _world()
    try:
        async with Session() as s:
            await s.execute(text("UPDATE members SET runtime_type = 'system-publisher' WHERE id = :m"), {"m": w.g_p})
            await s.commit()
        auth = AuthContext(user_id=str(w.g_p), email=None, claims={"app_metadata": {"api_key_id": str(uuid.uuid4()), "org_id": str(w.org)}}, org_id=str(w.org))
        async with Session() as s:
            resolved = await _resolve_member(auth, w.org, s, project_id=None)
        assert resolved.id == w.g_p and resolved.type == "agent"
        assert resolved.runtime_type == "system-publisher"
    finally:
        await engine.dispose()
