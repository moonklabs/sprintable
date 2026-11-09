"""story #4846 (AC6) — a chat room WITHOUT a project takes attachments, and the room (not a project) is who may read them.

What this pins (real PG, migrated schema; storage faked):
- the path rule: a room without a project stores under `org/<org>/chat/<room>/…`; the files it already holds from when it had a project (`org/<org>/project/<any>/chat/<room>/…`,
  legacy `chat/<any>/<room>/…`) stay readable because the room binds them; another organization, another room and an empty file name never pass;
- sending a message with an attachment in such a room registers the asset with NO project, and every door (list · single · authorize by asset id · authorize by room and path)
  answers a participant yes and a non-participant — a member of the organization, even the organization's owner in a room with a person — no;
- the room's single GET hands the web where to put a file (`attachment_path_prefix`), for a room with a project and for one without;
- the MCP upload builds the project-less path and the send-time limit check recognises it;
- deleting a project does NOT take the chat files of its rooms with it: the asset rows are kept (re-homed to no project, as the room's), the stored objects are not touched,
  the room still opens them to its participants and still refuses everyone else; what was measured before this change (assets cascade, no job deletes the objects) is pinned too.
"""
from __future__ import annotations

import uuid
from unittest.mock import patch

import pytest

from tests.test_1994_backlink_api_realdb import _client_for, _setup_app_agent, _setup_app_human
from tests.test_4846_org_chat_rooms_realdb import (  # noqa: F401 — fixtures used by name
    _REAL_DB_URL,
    _callers,
    _delete_project,
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


class _FakeStorage:
    """a stored object of 3 bytes for every path; what put_object received is kept for the MCP upload test"""

    def __init__(self):
        self.put: dict[str, bytes] = {}
        self.deleted: list[str] = []

    async def head_object(self, container, path):
        return 3

    async def download_object(self, container, path):
        return b"abc"

    async def put_object(self, container, path, data, content_type=None):
        self.put[path] = data
        return True

    async def delete_object(self, container, path):
        self.deleted.append(path)
        return True


# ── the path rule ────────────────────────────────────────────────────────────────────────────────────────────────────

def test_the_path_rule_for_a_room_without_a_project():
    from app.services.asset_registry import path_in_source_scope

    org, other_org, room, other_room, proj = (uuid.uuid4() for _ in range(5))
    ok = [
        f"org/{org}/chat/{room}/a.txt",                                 # the new home of a project-less room's files
        f"org/{org}/chat/{room}/mcp/{uuid.uuid4()}-a.txt",
        f"org/{org}/project/{proj}/chat/{room}/a.txt",                  # kept from when the room had a project
        f"org/{org}/project/{uuid.uuid4()}/chat/{room}/a.txt",          # whichever project it was
        f"chat/{proj}/{room}/a.txt",                                    # legacy
        f"org/{org}/chat/{room}/{uuid.uuid4()}-한글.png",                 # a Korean file name as the MCP upload keeps it (Python's \\w): the characters themselves
    ]
    bad = [
        f"org/{other_org}/chat/{room}/a.txt",                           # another organization
        f"org/{org}/chat/{other_room}/a.txt",                           # another room
        f"org/{org}/chat/{room}/",                                      # no file
        f"org/{org}/chat/{room}",                                       # no file segment
        f"org/{org}/project/{proj}/chat/{other_room}/a.txt",
        f"org/{other_org}/project/{proj}/chat/{room}/a.txt",
        f"org/{org}/project//chat/{room}/a.txt",                        # an empty project segment is not «any project»
        f"org/{org}/story/{room}/a.txt",                                # not the chat namespace
        f"project/{proj}/chat/{room}/a.txt",
        f"chat/{room}/a.txt",
        f"chat/{proj}/{other_room}/a.txt",                              # the legacy form of ANOTHER room
        # a path that walks or has an empty segment is not a path into the room's namespace (a store that normalizes paths would resolve it elsewhere)
        f"org/{org}/chat/{room}/../../../{other_org}/chat/{other_room}/secret.txt",
        f"org/{org}/chat/{room}/./a.txt",
        f"org/{org}/chat/{room}//a.txt",
        f"org/{org}/chat/{room}/x//y.txt",                              # an empty segment further in
        f"org/{org}/project/{proj}/chat/{room}/../{other_room}/a.txt",
        f"chat/{proj}/{room}/../{other_room}/a.txt",
        f"org/{org}/chat/{room}/..\\..\\x.txt",                            # a backslash
        f"org/{org}/chat/{room}/a\x00.txt",                                # a NUL
        f"org/{org}/chat/{room}/a\nb.txt",                                 # a control character
        f"org/{org}/chat/{room}/%2e%2e/{uuid.uuid4()}/x.txt",             # an encoded walk
        f"org/{org}/chat/{room}/a%2fb.txt",
        f"org/{org}/chat/{room}/{uuid.uuid4()}-%ED%95%9C%EA%B8%80.png",    # a percent-encoded name: no uploader of ours makes an object with a `%` in its name
    ]
    for p in ok:
        assert path_in_source_scope(p, "conversation_message", None, room, org), p
    for p in bad:
        assert not path_in_source_scope(p, "conversation_message", None, room, org), p
    # a room WITH a project is exactly as before: its own project only, never the project-less home
    assert path_in_source_scope(f"org/{org}/project/{proj}/chat/{room}/a.txt", "conversation_message", proj, room, org)
    assert not path_in_source_scope(f"org/{org}/chat/{room}/a.txt", "conversation_message", proj, room, org)
    assert not path_in_source_scope(f"org/{org}/project/{uuid.uuid4()}/chat/{room}/a.txt", "conversation_message", proj, room, org)
    # …and the walking forms are refused for every kind of source and both namespaces, not only for a room without a project (they were never refused before)
    for walking in (f"org/{org}/project/{proj}/chat/{room}/../{other_room}/a.txt", f"org/{org}/project/{proj}/chat/{room}/./a.txt"):
        assert not path_in_source_scope(walking, "conversation_message", proj, room, org), walking
    story = uuid.uuid4()
    assert path_in_source_scope(f"org/{org}/project/{proj}/story/{story}/a.png", "story", proj, story, org)
    assert not path_in_source_scope(f"org/{org}/project/{proj}/story/{story}/../{uuid.uuid4()}/a.png", "story", proj, story, org)
    assert not path_in_source_scope(f"org/{org}/project/{proj}/doc/{story}/../x/a.png", "doc", proj, story, org)


def test_the_prefix_the_server_hands_out_is_inside_the_rule_it_checks():
    from app.services.asset_registry import path_in_source_scope
    from app.services.mcp_attachment_upload import chat_attachment_path_prefix

    org, room, proj = uuid.uuid4(), uuid.uuid4(), uuid.uuid4()
    for project in (None, proj):
        prefix = chat_attachment_path_prefix(org, project, room)
        assert prefix.endswith("/") and path_in_source_scope(prefix + "f.png", "conversation_message", project, room, org), (project, prefix)


# ── sending, and who opens the file ──────────────────────────────────────────────────────────────────────────────────

async def _send_with_file(Session, w, caller, room, path, name="a.txt"):
    from app.main import app

    kind, _member, user = _callers(w)[caller]
    await (_setup_app_human if kind == "human" else _setup_app_agent)(app, Session, user, w.org)
    try:
        async with _client_for(app) as c:
            with patch("app.services.storage.get_storage_provider", return_value=_FakeStorage()):
                return await c.post(f"/api/v2/conversations/{room}/messages", json={
                    "content": "see file",
                    "attachments": [{"url": path, "name": name, "size": 3, "content_type": "text/plain"}],
                })
    finally:
        app.dependency_overrides.clear()


async def _asset_of(Session, path):
    from sqlalchemy import text

    async with Session() as s:
        return (await s.execute(text("SELECT id, project_id FROM assets WHERE object_path = :p AND deleted_at IS NULL"), {"p": path})).first()


async def _doors(Session, w, caller, asset_id, room, path):
    """(list finds it, single read, authorize by asset id, authorize by room + path) as status booleans for this caller"""
    from app.main import app

    kind, _member, user = _callers(w)[caller]
    await (_setup_app_human if kind == "human" else _setup_app_agent)(app, Session, user, w.org)
    try:
        async with _client_for(app) as c:
            lst = await c.get("/api/v2/assets")
            body = lst.json()
            items = body.get("data", body) if isinstance(body, dict) else body
            items = items.get("items", items) if isinstance(items, dict) else items
            listed = any(str(i.get("id")) == str(asset_id) for i in (items or [])) if lst.status_code == 200 else False
            single = (await c.get(f"/api/v2/assets/{asset_id}")).status_code == 200
            by_asset = (await c.get("/api/v2/attachments/authorize", params={"asset_id": str(asset_id)})).status_code == 200
            by_room = (await c.get("/api/v2/attachments/authorize", params={"conversation_id": str(room), "path": path})).status_code == 200
        return listed, single, by_asset, by_room
    finally:
        app.dependency_overrides.clear()


async def test_a_file_sent_in_a_room_without_a_project_is_registered_with_no_project_and_opens_to_the_room_only():
    engine, Session, w = await _world()
    try:
        path = f"org/{w.org}/chat/{w.n_human}/a.txt"
        r = await _send_with_file(Session, w, "participant", w.n_human, path)
        assert r.status_code == 201, r.text                                           # it was 400 ATTACHMENT_NEEDS_PROJECT
        row = await _asset_of(Session, path)
        assert row is not None and row.project_id is None                             # an asset of no project: read by the ROOM rule, not the organization's

        everyone_in = (True, True, True, True)
        nobody = (False, False, False, False)
        assert await _doors(Session, w, "participant", row.id, w.n_human, path) == everyone_in
        assert await _doors(Session, w, "lost_project", row.id, w.n_human, path) == everyone_in      # a participant who has no project of the organization at all
        assert await _doors(Session, w, "agent_participant", row.id, w.n_human, path) == everyone_in
        # a non-participant: a member of the organization with a project, the organization's owner (a person is in the room: private), an agent that is not in it
        assert await _doors(Session, w, "member_outside", row.id, w.n_human, path) == nobody
        assert await _doors(Session, w, "org_owner", row.id, w.n_human, path) == nobody
        assert await _doors(Session, w, "agent_plain", row.id, w.n_human, path) == nobody
    finally:
        await engine.dispose()


async def test_a_file_in_an_agents_only_room_without_a_project_opens_to_the_organization_owner():
    engine, Session, w = await _world()
    try:
        path = f"org/{w.org}/chat/{w.n_agents}/a.txt"
        r = await _send_with_file(Session, w, "agent_participant", w.n_agents, path)
        assert r.status_code == 201, r.text
        row = await _asset_of(Session, path)
        assert row is not None and row.project_id is None
        assert await _doors(Session, w, "org_owner", row.id, w.n_agents, path) == (True, True, True, True)     # the room has no person: the owner/admin rule of reads
        assert await _doors(Session, w, "member_outside", row.id, w.n_agents, path) == (False, False, False, False)
        assert await _doors(Session, w, "agent_plain", row.id, w.n_agents, path) == (False, False, False, False)
    finally:
        await engine.dispose()


async def test_a_path_that_names_another_room_is_not_registered_and_the_message_still_goes():
    """the registry never trusts a path: a file named under ANOTHER room's home is not registered as this room's (no asset), as it was never"""
    engine, Session, w = await _world()
    try:
        path = f"org/{w.org}/chat/{w.n_agents}/stolen.txt"                           # the home of a different room
        r = await _send_with_file(Session, w, "participant", w.n_human, path)
        assert r.status_code == 201, r.text
        assert await _asset_of(Session, path) is None
    finally:
        await engine.dispose()


async def test_a_walking_url_is_not_registered_and_the_message_still_goes():
    """codex round: a participant sends an `https://` url (it skips the schema's path check) that walks out of the room's namespace — it must not become an asset
    of this room, whatever the store would make of it; the message itself is still sent."""
    engine, Session, w = await _world()
    try:
        for url in (
            f"https://storage.googleapis.com/sprintable-memo-attachments/org/{w.org}/chat/{w.n_human}/../../../{uuid.uuid4()}/chat/{uuid.uuid4()}/secret.txt",
            f"https://storage.googleapis.com/sprintable-memo-attachments/org/{w.org}/project/{w.p1}/chat/{w.r_human}/../{w.n_human}/secret.txt",
        ):
            room = w.n_human if "/chat/" in url and f"/project/{w.p1}/" not in url else w.r_human
            r = await _send_with_file(Session, w, "participant", room, url)
            assert r.status_code == 201, r.text
            from sqlalchemy import text

            async with Session() as s:
                n = (await s.execute(text("SELECT count(*) FROM assets WHERE object_path LIKE '%secret.txt'"))).scalar_one()
            assert n == 0, url
    finally:
        await engine.dispose()


async def test_an_agent_that_is_not_in_the_room_cannot_upload_into_it():
    from app.main import app

    engine, Session, w = await _world()
    try:
        await _setup_app_agent(app, Session, w.g_plain, w.org)           # has the organization's project, is not a participant of the project-less room
        try:
            async with _client_for(app) as c:
                with patch("app.routers.conversations.get_storage_provider", return_value=_FakeStorage()):
                    r = await c.post(f"/api/v2/conversations/{w.n_agents}/attachments", json={
                        "name": "a.txt", "content_base64": "YWJj", "content_type": "text/plain",
                    })
            assert r.status_code == 403, r.text
        finally:
            app.dependency_overrides.clear()
    finally:
        await engine.dispose()


# ── the single GET hands out the prefix ──────────────────────────────────────────────────────────────────────────────

async def test_the_room_hands_out_where_its_files_go():
    from app.main import app

    engine, Session, w = await _world()
    try:
        await _setup_app_human(app, Session, w.u_a, w.org)
        try:
            async with _client_for(app) as c:
                with_project = (await c.get(f"/api/v2/conversations/{w.r_human}")).json()
                without = (await c.get(f"/api/v2/conversations/{w.n_human}")).json()
        finally:
            app.dependency_overrides.clear()
        data = lambda b: b.get("data", b)   # noqa: E731
        assert data(with_project)["attachment_path_prefix"] == f"org/{w.org}/project/{w.p1}/chat/{w.r_human}/"
        assert data(without)["attachment_path_prefix"] == f"org/{w.org}/chat/{w.n_human}/"
    finally:
        await engine.dispose()


# ── the MCP upload ───────────────────────────────────────────────────────────────────────────────────────────────────

async def test_the_mcp_upload_into_a_room_without_a_project_builds_the_organization_path():
    from app.main import app
    from app.routers.conversations import _is_mcp_upload_object_path

    engine, Session, w = await _world()
    try:
        storage = _FakeStorage()
        await _setup_app_agent(app, Session, w.g_p, w.org)
        try:
            async with _client_for(app) as c:
                with patch("app.routers.conversations.get_storage_provider", return_value=storage):
                    r = await c.post(f"/api/v2/conversations/{w.n_agents}/attachments", json={
                        "name": "a.txt", "content_base64": "YWJj", "content_type": "text/plain",
                    })
            assert r.status_code in (200, 201), r.text                                 # it was 400 ATTACHMENT_NEEDS_PROJECT
            url = (r.json().get("data") or r.json())["url"]
        finally:
            app.dependency_overrides.clear()
        assert url.startswith(f"org/{w.org}/chat/{w.n_agents}/mcp/"), url
        assert "None" not in url
        assert _is_mcp_upload_object_path(url)                                          # the send-time limit check recognises it
        assert not _is_mcp_upload_object_path(f"org/{w.org}/chat/{w.n_agents}/not-mcp/x.txt")
        assert _is_mcp_upload_object_path(f"org/{w.org}/project/{w.p1}/chat/{w.r_agents}/mcp/x.txt")      # the project shape is unchanged
        from app.services.mcp_attachment_upload import is_mcp_upload_object_path

        assert not is_mcp_upload_object_path(f"org/{w.org}/story/{w.r_agents}/mcp/x.txt", kind="story")   # only the chat namespace has a project-less shape
    finally:
        await engine.dispose()


# ── deleting a project keeps the chat files of its rooms ─────────────────────────────────────────────────────────────

async def test_deleting_a_project_keeps_the_chat_files_of_its_rooms_and_their_readers():
    """MEASURED before this change (a project with a room that holds a file, deleted): the asset rows went with the project (ON DELETE CASCADE) and no job deletes the
    stored objects — so the room would keep a message pointing at a file that no longer opened. Now the rows are re-homed to no project first: the same number of asset rows
    survive, the stored object is untouched, the room (which outlives its project) still opens the file to its participants and to nobody else."""
    from sqlalchemy import text

    engine, Session, w = await _world()
    try:
        path = f"org/{w.org}/project/{w.p1}/chat/{w.r_human}/a.txt"                    # a file attached while the room had its project
        r = await _send_with_file(Session, w, "participant", w.r_human, path)
        assert r.status_code == 201, r.text
        row = await _asset_of(Session, path)
        assert row is not None and row.project_id == w.p1
        async with Session() as s:                                                      # another file of the same project that is NOT a chat file: it goes with the project
            await s.execute(text(
                "INSERT INTO assets (id, org_id, project_id, container, object_path, name, content_type, size_bytes) "
                "VALUES (gen_random_uuid(), :o, :p, 'c', :path, 'doc.txt', 'text/plain', 3)"
            ), {"o": w.org, "p": w.p1, "path": f"org/{w.org}/project/{w.p1}/doc/{uuid.uuid4()}/doc.txt"})
            await s.commit()
            # a file that is a chat file AND another context's (a doc): it carries a chat link, so it is the room's too and is kept (the read rule is closed in that
            # direction: a project-less file with a chat link is read by its room whatever other link it has); the doc it belonged to goes with the project
            mixed = f"org/{w.org}/project/{w.p1}/chat/{w.r_human}/mixed.txt"
            await s.execute(text(
                "INSERT INTO assets (id, org_id, project_id, container, object_path, name, content_type, size_bytes) "
                "VALUES (gen_random_uuid(), :o, :p, 'c', :path, 'mixed.txt', 'text/plain', 3)"
            ), {"o": w.org, "p": w.p1, "path": mixed})
            mixed_message = uuid.uuid4()
            from app.models.conversation import ConversationMessage

            s.add(ConversationMessage(
                id=mixed_message, conversation_id=w.r_human, sender_id=w.h_a, content="mixed",
                attachments=[{"url": mixed, "name": "mixed.txt", "content_type": "text/plain", "size": 3}],
            ))
            await s.flush()
            for source_type, source_id in (("conversation_message", mixed_message), ("doc", uuid.uuid4())):
                await s.execute(text(
                    "INSERT INTO asset_links (id, asset_id, org_id, source_type, source_id) "
                    "SELECT gen_random_uuid(), id, :o, :t, :sid FROM assets WHERE object_path = :path"
                ), {"o": w.org, "t": source_type, "sid": source_id, "path": mixed})
            mixed_id = (await s.execute(text("SELECT id FROM assets WHERE object_path = :p"), {"p": mixed})).scalar_one()
            await s.commit()
            before = (await s.execute(text("SELECT count(*) FROM assets WHERE org_id = :o AND project_id = :p"), {"o": w.org, "p": w.p1})).scalar_one()
        assert before == 3                                                             # the chat file, a doc file, the mixed file

        resp = await _delete_project(Session, w, w.p1)
        assert resp.status_code == 200, resp.text                                       # it was 409 PROJECT_HAS_CHAT_ATTACHMENTS

        async with Session() as s:
            assert (await s.execute(text("SELECT count(*) FROM projects WHERE id = :p"), {"p": w.p1})).scalar_one() == 0
            kept = (await s.execute(text("SELECT id, project_id FROM assets WHERE object_path = :p"), {"p": path})).first()
            assert kept is not None and kept.id == row.id and kept.project_id is None   # the chat file's row survived, as the room's
            gone = (await s.execute(text("SELECT count(*) FROM assets WHERE object_path LIKE '%/doc/%' AND org_id = :o"), {"o": w.org})).scalar_one()
            left = (await s.execute(text("SELECT object_path, project_id FROM assets WHERE object_path LIKE '%/doc/%' AND org_id = :o"), {"o": w.org})).all()
            mixed_row = (await s.execute(text("SELECT id, project_id FROM assets WHERE object_path = :p"), {"p": mixed})).first()
            assert mixed_row is not None and mixed_row.id == mixed_id and mixed_row.project_id is None   # the mixed file's row is kept too, as the room's
            assert gone == 0, left                                                      # what carries no chat link went with the project, as before
            room = (await s.execute(text("SELECT project_id FROM conversations WHERE id = :c"), {"c": w.r_human})).first()
            assert room is not None and room.project_id is None                         # the room stays, without its project

        # …and the file still opens for the room, through every door, and for nobody else
        everyone_in = (True, True, True, True)
        assert await _doors(Session, w, "participant", row.id, w.r_human, path) == everyone_in
        assert await _doors(Session, w, "lost_project", row.id, w.r_human, path) == everyone_in
        assert await _doors(Session, w, "member_outside", row.id, w.r_human, path) == (False, False, False, False)
        assert await _doors(Session, w, "org_owner", row.id, w.r_human, path) == (False, False, False, False)

        # the MIXED file (also a doc's) is kept too, as the room's: the participant opens it through every door, a person outside the room through none — and the doc link
        # that is left pointing at the deleted doc does not make it the organization's
        assert await _doors(Session, w, "participant", mixed_id, w.r_human, mixed) == everyone_in
        assert await _doors(Session, w, "lost_project", mixed_id, w.r_human, mixed) == everyone_in
        assert await _doors(Session, w, "member_outside", mixed_id, w.r_human, mixed) == (False, False, False, False)
        assert await _doors(Session, w, "org_owner", mixed_id, w.r_human, mixed) == (False, False, False, False)
    finally:
        await engine.dispose()


async def test_every_path_that_deletes_a_project_goes_through_the_repository_that_keeps_the_files():
    import pathlib
    import re

    root = pathlib.Path(__file__).resolve().parents[1] / "app"
    users = []
    for p in root.rglob("*.py"):
        text = p.read_text(encoding="utf-8")
        if re.search(r"delete\(\s*Project\s*\)|delete\(\s*(?:self\.)?model\s*\)|DELETE FROM projects|\.delete\(\s*project\b|sa_delete\(\s*Project|session\.delete\(\s*proj", text, re.I):
            users.append(str(p.relative_to(root)))
    assert users == [], users     # the project row is deleted only by ProjectRepository.delete (BaseRepository.delete), never by a statement of its own


async def test_what_the_database_does_to_the_files_of_a_deleted_project_is_why_the_repository_re_homes_them_first():
    """THE MEASUREMENT (PO asked for it before the 409 was lifted): delete a project's row with a plain statement, with one chat file and one non-chat file registered under it:
    both asset ROWS go with it (assets.project_id ON DELETE CASCADE: 2 → 0), and no statement or job deletes the stored OBJECT (0 deletions) — so the room would keep a message
    pointing at a file that no longer opens. The repository (the only deleter, see the test above) re-homes the chat file's row first: 2 → 1, objects deleted 0."""
    from sqlalchemy import text

    engine, Session, w = await _world()
    try:
        async def register(s, project, path, source_type, source_id):
            await s.execute(text(
                "INSERT INTO assets (id, org_id, project_id, container, object_path, name, content_type, size_bytes) "
                "VALUES (gen_random_uuid(), :o, :p, 'c', :path, 'f.txt', 'text/plain', 3)"
            ), {"o": w.org, "p": project, "path": path})
            await s.execute(text(
                "INSERT INTO asset_links (id, asset_id, org_id, source_type, source_id) "
                "SELECT gen_random_uuid(), id, :o, :t, :sid FROM assets WHERE object_path = :path"
            ), {"o": w.org, "t": source_type, "sid": source_id, "path": path})

        count = "SELECT count(*) FROM assets WHERE org_id = :o AND object_path LIKE :like"
        like = f"%{w.p2}%"          # P2 has no room: its files are registered by hand
        async with Session() as s:
            await register(s, w.p2, f"org/{w.org}/project/{w.p2}/chat/{w.r_agents}/c.txt", "conversation_message", uuid.uuid4())
            await register(s, w.p2, f"org/{w.org}/project/{w.p2}/doc/{uuid.uuid4()}/d.txt", "doc", uuid.uuid4())
            await s.commit()
            assert (await s.execute(text(count), {"o": w.org, "like": like})).scalar_one() == 2
            await s.execute(text("DELETE FROM projects WHERE id = :p"), {"p": w.p2})      # the plain statement, NOT the repository
            await s.commit()
            assert (await s.execute(text(count), {"o": w.org, "like": like})).scalar_one() == 0   # 2 → 0: the rows went with the project
    finally:
        await engine.dispose()


async def test_a_project_less_chat_file_is_read_by_its_room_whatever_other_link_it_gets():
    """a file with NO project is, to the rest of the asset code, the organization's. A link can reach such a file by a race (a loop artifact filed while its
    project is being deleted), so the closed reading holds: a chat link and no project → the room rule only, however many other links it has."""
    from sqlalchemy import text

    engine, Session, w = await _world()
    try:
        path = f"org/{w.org}/chat/{w.n_human}/a.txt"
        r = await _send_with_file(Session, w, "participant", w.n_human, path)
        assert r.status_code == 201, r.text
        row = await _asset_of(Session, path)
        assert row is not None and row.project_id is None
        async with Session() as s:
            await s.execute(text(
                "INSERT INTO asset_links (id, asset_id, org_id, source_type, source_id) VALUES (gen_random_uuid(), :a, :o, 'loop_artifact', gen_random_uuid())"
            ), {"a": row.id, "o": w.org})
            await s.commit()
        assert await _doors(Session, w, "participant", row.id, w.n_human, path) == (True, True, True, True)
        for outsider in ("member_outside", "org_owner", "agent_plain"):
            assert await _doors(Session, w, outsider, row.id, w.n_human, path) == (False, False, False, False), outsider
    finally:
        await engine.dispose()



async def test_a_korean_file_name_goes_through_the_mcp_upload_and_is_registered_and_opened():
    """measured for the `%` refusal: the MCP upload keeps a Korean name as the characters themselves (Python's `\\w`), the web route reduces it to ASCII (JS `\\w`:
    `route.ts:76`) — neither path has a `%`, so refusing a percent sign costs no legitimate file. The Korean name end to end: upload → send → registered → opened."""
    from app.main import app

    engine, Session, w = await _world()
    try:
        storage = _FakeStorage()
        await _setup_app_agent(app, Session, w.g_p, w.org)
        try:
            async with _client_for(app) as c:
                with patch("app.routers.conversations.get_storage_provider", return_value=storage):
                    up = await c.post(f"/api/v2/conversations/{w.n_agents}/attachments", json={
                        "name": "한글.png", "content_base64": "YWJj", "content_type": "image/png",
                    })
                assert up.status_code in (200, 201), up.text
                att = up.json().get("data") or up.json()
                assert "한글" in att["url"] and "%" not in att["url"], att["url"]
                with patch("app.services.storage.get_storage_provider", return_value=storage):
                    sent = await c.post(f"/api/v2/conversations/{w.n_agents}/messages", json={
                        "content": "한글 그림", "attachments": [att],
                    })
                assert sent.status_code == 201, sent.text
        finally:
            app.dependency_overrides.clear()
        row = await _asset_of(Session, att["url"])
        assert row is not None and row.project_id is None
        assert await _doors(Session, w, "org_owner", row.id, w.n_agents, att["url"]) == (True, True, True, True)
    finally:
        await engine.dispose()


async def test_deleting_a_project_waits_for_a_file_being_attached_to_a_message_and_keeps_it():
    """(connection A) a file of the project that no message carried yet — a chat-namespace file whose earlier message was edited away — is being attached to a message: the
    link is inserted, not committed; (connection B) the project is deleted. The link's reference holds the asset row, so B must wait for A and, once A has committed, SEE the chat
    link and re-home the file instead of letting it go with the project (a message that carries a file whose registry row is gone is the state this piece exists to avoid)."""
    import asyncio

    from sqlalchemy import text

    from app.repositories.project import ProjectRepository

    engine, Session, w = await _world()
    try:
        path = f"org/{w.org}/project/{w.p1}/chat/{w.r_human}/orphan.txt"
        async with Session() as s:
            await s.execute(text(
                "INSERT INTO assets (id, org_id, project_id, container, object_path, name, content_type, size_bytes) "
                "VALUES (gen_random_uuid(), :o, :p, 'c', :path, 'orphan.txt', 'text/plain', 3)"
            ), {"o": w.org, "p": w.p1, "path": path})
            await s.commit()
            asset_id = (await s.execute(text("SELECT id FROM assets WHERE object_path = :p"), {"p": path})).scalar_one()

        a = Session()
        await a.execute(text(
            "INSERT INTO asset_links (id, asset_id, org_id, source_type, source_id) VALUES (gen_random_uuid(), :a, :o, 'conversation_message', gen_random_uuid())"
        ), {"a": asset_id, "o": w.org})                                                 # A: attached, NOT committed

        async def delete_in_b():
            async with Session() as b:
                ok = await ProjectRepository(b, w.org).delete(w.p1)
                await b.commit()
                return ok

        task = asyncio.create_task(delete_in_b())
        # B is waiting on A's uncommitted link: a state, not a time — poll until the database says a session waits on a lock
        for _ in range(2000):
            async with Session() as probe:
                waiting = (await probe.execute(text(
                    "SELECT count(*) FROM pg_stat_activity WHERE datname = current_database() AND wait_event_type = 'Lock' AND pid <> pg_backend_pid()"
                ))).scalar_one()
            if waiting or task.done():
                break
            await asyncio.sleep(0.01)
        assert not task.done(), "the deletion did not wait for the link being attached"
        await a.commit()
        await a.close()
        assert await task is True
        async with Session() as s:
            kept = (await s.execute(text("SELECT id, project_id FROM assets WHERE object_path = :p"), {"p": path})).first()
        assert kept is not None and kept.id == asset_id and kept.project_id is None     # it saw A's chat link: the file is the room's, kept
    finally:
        await engine.dispose()


async def test_the_agent_content_endpoint_reads_a_file_of_a_project_less_room_for_the_room_only():
    """the third consumer of the path rule (besides the registry and the authorize routes): `GET …/messages/{id}/attachments/{i}/content` — a participant (a person without any
    project, an agent in the room) reads the text of a file sent in a room without a project, a person outside the room does not."""
    from app.main import app
    from sqlalchemy import text

    engine, Session, w = await _world()
    try:
        path = f"org/{w.org}/chat/{w.n_human}/a.txt"
        r = await _send_with_file(Session, w, "participant", w.n_human, path)
        assert r.status_code == 201, r.text
        async with Session() as s:
            message_id = (await s.execute(text("SELECT id FROM conversation_messages WHERE conversation_id = :c ORDER BY created_at DESC LIMIT 1"), {"c": w.n_human})).scalar_one()

        async def read(caller):
            kind, _member, user = _callers(w)[caller]
            await (_setup_app_human if kind == "human" else _setup_app_agent)(app, Session, user, w.org)
            try:
                async with _client_for(app) as c:
                    with patch("app.services.chat_attachment_service.get_storage_provider", return_value=_FakeStorage()):
                        return (await c.get(f"/api/v2/conversations/{w.n_human}/messages/{message_id}/attachments/0/content")).status_code
            finally:
                app.dependency_overrides.clear()

        assert await read("participant") == 200
        assert await read("lost_project") == 200
        assert await read("agent_participant") == 200
        assert await read("member_outside") in (403, 404)
        assert await read("org_owner") in (403, 404)
        assert await read("agent_plain") in (403, 404)
    finally:
        await engine.dispose()


async def test_re_homing_follows_the_chat_link_not_the_text_of_the_path_and_never_touches_the_stored_object():
    """a file with a chat-shaped path but no chat link goes with the project (the decision is the link), a file with a link is kept whatever its path says; and deleting the project
    never deletes a stored object (the store's delete is not called — nothing does that, which is why the rows are kept)."""
    from sqlalchemy import text

    engine, Session, w = await _world()
    try:
        storage = _FakeStorage()
        chat_shaped = f"org/{w.org}/project/{w.p1}/chat/{w.r_human}/no-link.txt"
        odd_but_linked = f"org/{w.org}/project/{w.p1}/doc/{uuid.uuid4()}/linked.txt"
        async with Session() as s:
            for path in (chat_shaped, odd_but_linked):
                await s.execute(text(
                    "INSERT INTO assets (id, org_id, project_id, container, object_path, name, content_type, size_bytes) "
                    "VALUES (gen_random_uuid(), :o, :p, 'c', :path, 'f.txt', 'text/plain', 3)"
                ), {"o": w.org, "p": w.p1, "path": path})
            await s.execute(text(
                "INSERT INTO asset_links (id, asset_id, org_id, source_type, source_id) "
                "SELECT gen_random_uuid(), id, :o, 'conversation_message', gen_random_uuid() FROM assets WHERE object_path = :path"
            ), {"o": w.org, "path": odd_but_linked})
            await s.commit()
        with patch("app.services.storage.get_storage_provider", return_value=storage), patch("app.routers.conversations.get_storage_provider", return_value=storage):
            resp = await _delete_project(Session, w, w.p1)
        assert resp.status_code == 200, resp.text
        async with Session() as s:
            rows = {r[0]: r[1] for r in (await s.execute(text("SELECT object_path, project_id FROM assets WHERE object_path = ANY(:p)"), {"p": [chat_shaped, odd_but_linked]})).all()}
        assert chat_shaped not in rows                       # a chat-shaped path with no chat link went with the project
        assert rows.get(odd_but_linked, "missing") is None   # a linked file with a doc-shaped path was kept, as the room's
        assert storage.deleted == []                         # and no stored object was deleted
    finally:
        await engine.dispose()


async def test_a_file_that_only_a_doc_or_a_story_carries_goes_with_the_project():
    """the re-homing decision is «carries a CHAT link», not «carries any link»: a file with a doc link or a story link and no chat link must go with the project — if it were
    re-homed it would be a file with no project and no chat link, i.e. one the whole organization reads. (A surviving mutant of the lens: `chat_linked_clause` changed to «any
    link» passed every other test.)"""
    from sqlalchemy import text

    engine, Session, w = await _world()
    try:
        async with Session() as s:
            for kind, source_type in (("doc", "doc"), ("story", "story"), ("loop", "loop_artifact")):
                path = f"org/{w.org}/project/{w.p1}/{kind}/{uuid.uuid4()}/only.txt"
                await s.execute(text(
                    "INSERT INTO assets (id, org_id, project_id, container, object_path, name, content_type, size_bytes) "
                    "VALUES (gen_random_uuid(), :o, :p, 'c', :path, 'only.txt', 'text/plain', 3)"
                ), {"o": w.org, "p": w.p1, "path": path})
                await s.execute(text(
                    "INSERT INTO asset_links (id, asset_id, org_id, source_type, source_id) "
                    "SELECT gen_random_uuid(), id, :o, :t, gen_random_uuid() FROM assets WHERE object_path = :path"
                ), {"o": w.org, "t": source_type, "path": path})
            await s.commit()
            assert (await s.execute(text("SELECT count(*) FROM assets WHERE object_path LIKE '%/only.txt' AND org_id = :o"), {"o": w.org})).scalar_one() == 3
        resp = await _delete_project(Session, w, w.p1)
        assert resp.status_code == 200, resp.text
        async with Session() as s:
            left = (await s.execute(text("SELECT object_path, project_id FROM assets WHERE object_path LIKE '%/only.txt' AND org_id = :o"), {"o": w.org})).all()
        assert left == [], left                                   # none re-homed: not one of them became an asset with no project for the whole organization to read
    finally:
        await engine.dispose()
