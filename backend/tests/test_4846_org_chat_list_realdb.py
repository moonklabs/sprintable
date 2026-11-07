"""story #4846 (AC4) — the conversation list is the ORGANIZATION's: the rooms I am in, whatever their project; `project_id` is only a filter
(a project id, or `none`), and every row says its own project (`project_id` · `project_name`, both null for a room without one).

Real PG, migrated schema (the world of test_4846_org_chat_rooms_realdb: two projects, people, agents, four rooms — two with P1, two with none).
"""
from __future__ import annotations

import uuid

import pytest

from tests.test_1994_backlink_api_realdb import _client_for, _make_human_member, _setup_app_agent, _setup_app_human
from tests.test_4846_org_chat_rooms_realdb import (  # noqa: F401 — fixtures used by name
    _REAL_DB_URL,
    _callers,
    _dispose_global_engine_after_test,
    _send,
    _world,
    anyio_backend,
)

pytestmark = [
    pytest.mark.skipif(not _REAL_DB_URL, reason="통합 테스트는 실 PG(PARITY/ALEMBIC_DATABASE_URL) 필요"),
    pytest.mark.anyio,
]


async def _list(Session, w, caller, **params):
    from app.main import app

    kind, _member, user = _callers(w)[caller]
    if kind == "human":
        await _setup_app_human(app, Session, user, w.org)
    else:
        await _setup_app_agent(app, Session, user, w.org)
    try:
        async with _client_for(app) as c:
            return await c.get("/api/v2/conversations", params=params)
    finally:
        app.dependency_overrides.clear()


def _ids(resp):
    return [row["id"] for row in resp.json()["data"]]


async def test_no_project_id_lists_every_room_i_am_in_each_with_its_project():
    engine, Session, w = await _world()
    try:
        r = await _list(Session, w, "participant")          # h_a: in r_human and n_human
        assert r.status_code == 200, r.text
        rows = {row["id"]: row for row in r.json()["data"]}
        assert set(rows) == {str(w.r_human), str(w.n_human)}
        assert r.json()["total"] == 2
        assert rows[str(w.r_human)]["project_id"] == str(w.p1) and rows[str(w.r_human)]["project_name"] == "P1"
        assert rows[str(w.n_human)]["project_id"] is None and rows[str(w.n_human)]["project_name"] is None
        # the rest of a row is the list's own shape (unchanged)
        assert {"participants", "latest_message", "unread_count", "muted", "linked_proof", "updated_at"} <= set(rows[str(w.r_human)])
    finally:
        await engine.dispose()


async def test_the_filter_is_a_project_or_none():
    engine, Session, w = await _world()
    try:
        assert _ids(await _list(Session, w, "participant", project_id=str(w.p1))) == [str(w.r_human)]
        assert _ids(await _list(Session, w, "participant", project_id="none")) == [str(w.n_human)]
        assert _ids(await _list(Session, w, "participant", project_id=str(w.p2))) == []          # a project with none of my rooms
        assert _ids(await _list(Session, w, "participant", project_id="NONE")) == [str(w.n_human)]
    finally:
        await engine.dispose()


async def test_a_participant_who_lost_the_project_still_lists_and_filters_its_rooms():
    """the answer to the web's question: not hidden, and filtering by the project they lost is not a 403 — being in the room is what lists it"""
    engine, Session, w = await _world()
    try:
        r = await _list(Session, w, "lost_project")          # h_d: a participant of both human rooms, with access to P2 only
        assert r.status_code == 200 and set(_ids(r)) == {str(w.r_human), str(w.n_human)}
        r1 = await _list(Session, w, "lost_project", project_id=str(w.p1))
        assert r1.status_code == 200 and _ids(r1) == [str(w.r_human)]
    finally:
        await engine.dispose()


async def test_someone_outside_the_rooms_lists_nothing_of_them():
    engine, Session, w = await _world()
    try:
        for caller in ("member_outside", "org_owner", "agent_project_admin", "agent_plain"):
            r = await _list(Session, w, caller)
            assert r.status_code == 200 and _ids(r) == [] and r.json()["total"] == 0, (caller, r.text)
        # an agent lists the rooms it is in — including the one without a project
        assert set(_ids(await _list(Session, w, "agent_participant"))) == {str(w.r_human), str(w.r_agents), str(w.n_human), str(w.n_agents)}
    finally:
        await engine.dispose()


async def test_order_and_paging_are_the_lists_own_and_total_counts_the_filter():
    engine, Session, w = await _world()
    try:
        await _send(Session, w, w.n_human)          # touches n_human last → the newest first
        r = await _list(Session, w, "participant")
        assert _ids(r)[0] == str(w.n_human)
        page1 = await _list(Session, w, "participant", limit=1, offset=0)
        page2 = await _list(Session, w, "participant", limit=1, offset=1)
        assert page1.json()["total"] == 2 and page2.json()["total"] == 2
        assert _ids(page1) + _ids(page2) == _ids(r)
        none_only = await _list(Session, w, "participant", project_id="none", limit=1)
        assert none_only.json()["total"] == 1
    finally:
        await engine.dispose()


async def test_a_room_whose_project_was_deleted_lists_with_no_project():
    from sqlalchemy import text

    engine, Session, w = await _world()
    try:
        async with Session() as s:
            await s.execute(text("DELETE FROM projects WHERE id = :p"), {"p": w.p1})
            await s.commit()
        rows = {row["id"]: row for row in (await _list(Session, w, "participant")).json()["data"]}
        assert set(rows) == {str(w.r_human), str(w.n_human)} and all(x["project_id"] is None for x in rows.values())
        assert _ids(await _list(Session, w, "participant", project_id="none")) and len(_ids(await _list(Session, w, "participant", project_id="none"))) == 2
    finally:
        await engine.dispose()


async def test_bad_arguments_are_refused_with_a_reason():
    engine, Session, w = await _world()
    try:
        r = await _list(Session, w, "participant", project_id="not-a-project")
        assert r.status_code == 422, r.text
        r = await _list(Session, w, "org_owner", include_agent_conversations="true")           # an admin's agent view is of ONE project
        assert r.status_code == 400, r.text
    finally:
        await engine.dispose()


async def test_the_admins_agent_view_of_one_project_is_unchanged():
    engine, Session, w = await _world()
    try:
        r = await _list(Session, w, "org_owner", project_id=str(w.p1), include_agent_conversations="true")
        assert r.status_code == 200, r.text
        assert _ids(r) == [str(w.r_agents)]          # the agents-only room of P1 (not a participant, no person in it); the room with people is private
    finally:
        await engine.dispose()


async def test_a_room_can_be_created_without_a_project_and_a_foreign_project_is_refused():
    """AC5 on the REST side: `project_id` is optional in the create body — the room has none, lists with none and reads for its participants; a project of
    ANOTHER organization is refused (404) like an unknown one."""
    from app.main import app
    from tests.test_1994_backlink_api_realdb import _make_org, _make_project

    engine, Session, w = await _world()
    try:
        async with Session() as s:
            other_org = await _make_org(s)
            foreign_project = await _make_project(s, other_org.id, "Foreign")
        await _setup_app_human(app, Session, w.u_a, w.org)
        try:
            async with _client_for(app) as c:
                made = await c.post("/api/v2/conversations", json={"type": "group", "participant_ids": [str(w.h_b)]})
                assert made.status_code == 201, made.text
                conv_id = made.json()["id"]
                bad = await c.post("/api/v2/conversations", json={
                    "type": "group", "participant_ids": [str(w.h_b)], "project_id": str(foreign_project.id),
                })
                assert bad.status_code == 403, bad.text      # a person: «no access to this project» (as before)
                single = await c.get(f"/api/v2/conversations/{conv_id}")
                assert single.status_code == 200 and single.json()["data"]["project_id"] is None if "data" in single.json() else single.json()["project_id"] is None
        finally:
            app.dependency_overrides.clear()
        # an agent key does not go through the person's project-access resolution: the project must still be this organization's (404)
        await _setup_app_agent(app, Session, w.g_p, w.org)
        try:
            async with _client_for(app) as c:
                bad_agent = await c.post("/api/v2/conversations", json={
                    "type": "group", "participant_ids": [str(w.g_2)], "project_id": str(foreign_project.id),
                })
            assert bad_agent.status_code == 404, bad_agent.text
        finally:
            app.dependency_overrides.clear()
        listed = await _list(Session, w, "participant", project_id="none")
        assert conv_id in _ids(listed)
        # and the room reads for its participants, not for a stranger
        assert await _status_of(Session, w, "participant", conv_id) == 200
        assert await _status_of(Session, w, "member_outside", conv_id) == 403
    finally:
        await engine.dispose()


async def _status_of(Session, w, caller, conv_id):
    from tests.test_4846_org_chat_rooms_realdb import _status

    return await _status(Session, w, caller, conv_id)


async def test_a_stale_project_header_does_not_block_the_list():
    """codex 1: a participant who lost P1 filters by P1 (the MCP tool sends the project as a header too; the web sends the tab's project) — the list is
    not gated by the header's project access (the admin's agent view checks the project itself)."""
    from app.main import app

    engine, Session, w = await _world()
    try:
        _kind, _member, user = _callers(w)["lost_project"]
        await _setup_app_human(app, Session, user, w.org)
        try:
            async with _client_for(app) as c:
                r = await c.get("/api/v2/conversations", params={"project_id": str(w.p1)}, headers={"X-Project-Id": str(w.p1)})
            assert r.status_code == 200 and _ids(r) == [str(w.r_human)], r.text
        finally:
            app.dependency_overrides.clear()
    finally:
        await engine.dispose()


async def test_someone_of_another_organization_lists_none_of_these_rooms():
    from app.main import app
    from tests.test_1994_backlink_api_realdb import _make_human_member, _make_org, _make_project

    engine, Session, w = await _world()
    try:
        async with Session() as s:
            other_org = await _make_org(s)
            other_project = await _make_project(s, other_org.id, "Other")
            _m, other_user = await _make_human_member(s, other_org.id, other_project.id)
        await _setup_app_human(app, Session, other_user, other_org.id)
        try:
            async with _client_for(app) as c:
                r = await c.get("/api/v2/conversations")
                r_none = await c.get("/api/v2/conversations", params={"project_id": "none"})
            assert r.status_code == 200 and _ids(r) == [] and r_none.status_code == 200 and _ids(r_none) == []
        finally:
            app.dependency_overrides.clear()
    finally:
        await engine.dispose()


async def test_a_project_admin_who_is_an_ordinary_organization_member_cannot_look_at_the_agent_rooms_of_any_view():
    """self-QA round on the head + lens find: the admin view trusted the team_members view's role, which is a PROJECT role — a person who is admin of a project
    but a plain member of the organization listed every agent-only room of `none` (and its last line), and the agents-only rooms of their own project, which a
    read by id refused (measured the same on develop: listed, read 403). The view follows what reads allow: a person needs the ORGANIZATION owner/admin role."""
    from sqlalchemy import text

    from app.main import app

    engine, Session, w = await _world()
    try:
        async with Session() as s:
            h_pa, u_pa = await _make_human_member(s, w.org, w.p1)
            await s.execute(text("UPDATE project_access SET role = 'admin' WHERE member_id = :m"), {"m": h_pa})
            await s.commit()
        await _setup_app_human(app, Session, u_pa, w.org)
        try:
            async with _client_for(app) as c:
                refused = await c.get("/api/v2/conversations", params={"project_id": "none", "include_agent_conversations": "true"})
                own = await c.get("/api/v2/conversations", params={"project_id": str(w.p1), "include_agent_conversations": "true"})
        finally:
            app.dependency_overrides.clear()
        assert refused.status_code == 403, refused.text
        assert own.status_code == 403, own.text          # nor the project they administer: the same room is a 403 to read by id
        none_view = await _list(Session, w, "org_owner", project_id="none", include_agent_conversations="true")
        p1_view = await _list(Session, w, "org_owner", project_id=str(w.p1), include_agent_conversations="true")
        assert none_view.status_code == 200 and _ids(none_view) == [str(w.n_agents)], none_view.text          # the owner sees the room, not an empty answer
        assert p1_view.status_code == 200 and str(w.r_agents) in _ids(p1_view), p1_view.text
        # and what the owner is shown the owner can read: the same room by id
        from tests.test_4846_org_chat_rooms_realdb import _status

        assert await _status(Session, w, "org_owner", w.n_agents) == 200 and await _status(Session, w, "org_owner", w.r_agents) == 200
    finally:
        await engine.dispose()


async def test_the_admins_agent_view_takes_none_for_the_agents_rooms_without_a_project():
    """lens recommendation: the agents' rooms that have no project are in no project's view — `none` finds them (and only the agent-only ones)"""
    engine, Session, w = await _world()
    try:
        r = await _list(Session, w, "org_owner", project_id="none", include_agent_conversations="true")
        assert r.status_code == 200 and _ids(r) == [str(w.n_agents)], r.text       # not n_human (people in it: private), not the rooms of P1
        # only an owner/admin
        assert (await _list(Session, w, "member_outside", project_id="none", include_agent_conversations="true")).status_code == 403
        # and a request for the agent view with no project argument at all is still refused
        assert (await _list(Session, w, "org_owner", include_agent_conversations="true")).status_code == 400
    finally:
        await engine.dispose()


async def test_a_malformed_project_id_is_our_422_not_the_framework_default():
    """pinned by the answer's shape: the route's own reason, not the validation list the framework would give for a UUID parameter"""
    engine, Session, w = await _world()
    try:
        r = await _list(Session, w, "participant", project_id="not-a-project")
        assert r.status_code == 422 and "project id or `none`" in r.text, r.text
    finally:
        await engine.dispose()


async def _grant(Session, w, member, project):
    from app.models.project_access import ProjectAccess

    async with Session() as s:
        s.add(ProjectAccess(id=uuid.uuid4(), project_id=project, org_member_id=None, member_id=member, permission="granted", role="member"))
        await s.commit()


async def _revoke(Session, member, project):
    from sqlalchemy import text

    async with Session() as s:
        await s.execute(text("DELETE FROM project_access WHERE member_id = :m AND project_id = :p"), {"m": member, "p": project})
        await s.commit()


async def _every_listed_room_reads(Session, w, caller):
    """the invariant of the lens: a room the list shows is a room the caller can read"""
    r = await _list(Session, w, caller)
    assert r.status_code == 200, r.text
    from tests.test_4846_org_chat_rooms_realdb import _status

    for conv_id in _ids(r):
        assert await _status(Session, w, caller, conv_id) == 200, (caller, conv_id)
    return set(_ids(r))


async def test_the_list_follows_the_read_predicate_for_an_agent_revoked_one_project_two_projects_and_granted_again():
    """lens blocker: the list gathered «rooms I have a participant row in» without asking the read predicate — an agent whose project was revoked would
    still see the room, with its last line. Now the agent's column: granted · revoked (its only project) · a second project that stays · granted again."""
    from sqlalchemy import text

    from tests.test_1994_backlink_api_realdb import _make_conversation

    engine, Session, w = await _world()
    try:
        # a second project with a room of the agent in it
        async with Session() as s:
            await _grant_second(s, w)
            r_p2 = await _make_conversation(s, w.org, w.p2, [w.g_p, w.g_2], w.g_p, "group")
        rooms_all = {str(w.r_human), str(w.r_agents), str(w.n_human), str(w.n_agents), str(r_p2)}
        assert await _every_listed_room_reads(Session, w, "agent_participant") == rooms_all           # granted on both
        await _revoke(Session, w.g_p, w.p1)                                                           # P1 gone, P2 stays («two projects»)
        got = await _every_listed_room_reads(Session, w, "agent_participant")
        assert got == {str(w.n_human), str(w.n_agents), str(r_p2)}, got
        await _revoke(Session, w.g_p, w.p2)                                                           # now it has no project at all
        got = await _every_listed_room_reads(Session, w, "agent_participant")
        assert got == {str(w.n_human), str(w.n_agents)}, got                                          # only the rooms without a project
        # filtering by the lost project lists nothing for it; the filter `none` lists its project-less rooms
        assert _ids(await _list(Session, w, "agent_participant", project_id=str(w.p1))) == []
        assert set(_ids(await _list(Session, w, "agent_participant", project_id="none"))) == {str(w.n_human), str(w.n_agents)}
        await _grant(Session, w, w.g_p, w.p1)                                                         # granted again → the rooms are back
        assert await _every_listed_room_reads(Session, w, "agent_participant") == {str(w.r_human), str(w.r_agents), str(w.n_human), str(w.n_agents)}
        # a PERSON who lost the project keeps it (the other way round)
        assert {str(w.r_human), str(w.n_human)} <= await _every_listed_room_reads(Session, w, "lost_project")
    finally:
        await engine.dispose()


async def _grant_second(session, w):
    from app.models.project_access import ProjectAccess

    session.add(ProjectAccess(id=uuid.uuid4(), project_id=w.p2, org_member_id=None, member_id=w.g_p, permission="granted", role="member"))
    await session.commit()


async def test_another_organizations_rows_planted_in_the_list_are_not_listed_or_named():
    """lens survivors: the list's organization filter and the project-name lookup's organization filter. A room of ANOTHER organization with a participant
    row naming our member is not listed; a room of ours whose project_id points at a project of ANOTHER organization lists with no project name."""
    from sqlalchemy import text

    from tests.test_1994_backlink_api_realdb import _make_conversation, _make_org, _make_project

    engine, Session, w = await _world()
    try:
        async with Session() as s:
            other_org = await _make_org(s)
            other_project = await _make_project(s, other_org.id, "SecretName")
            foreign_room = await _make_conversation(s, other_org.id, other_project.id, [w.h_a], w.h_a, "group")      # planted: our member in their room
            await s.execute(text("UPDATE conversations SET project_id = :p WHERE id = :c"), {"p": other_project.id, "c": w.r_human})  # planted: their project on our room
            await s.commit()
        r = await _list(Session, w, "participant")
        rows = {row["id"]: row for row in r.json()["data"]}
        assert str(foreign_room) not in rows
        assert rows[str(w.r_human)]["project_name"] is None, rows[str(w.r_human)]
    finally:
        await engine.dispose()


async def test_an_agent_cannot_take_the_none_view_of_the_admins_agent_rooms():
    """lens (5433): the admin check asked `_effective_org_role(project=None)`, which for an agent fell back to «some» team_members row's role — an agent that is
    admin in any project saw the agents-only rooms that belong to no project (previews included) and then got 403 reading them by id. An agent holds no
    organization-wide role: the `none` view is a person's, owner or admin."""
    engine, Session, w = await _world()
    try:
        r = await _list(Session, w, "agent_project_admin", project_id="none", include_agent_conversations="true")
        assert r.status_code == 403, r.text
        # the admin of P1 still takes the view of P1's agents' rooms (its own project)
        ok = await _list(Session, w, "agent_project_admin", project_id=str(w.p1), include_agent_conversations="true")
        assert ok.status_code == 200 and _ids(ok) == [str(w.r_agents)], ok.text
        # and every room that view lists reads (the list is a subset of the reads)
        from tests.test_4846_org_chat_rooms_realdb import _status

        assert await _status(Session, w, "agent_project_admin", w.r_agents) == 200
    finally:
        await engine.dispose()
