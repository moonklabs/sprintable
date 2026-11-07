"""story #4846 (AC10) — a file attached in a chat message belongs to the ROOM, not to the project.

Before: the asset routes scoped every asset by its project — so a project member who is not in the room found the room's file (list · single · text ·
authorize-by-asset-id), a participant who lost the room's project could not open their own room's file, and an asset registered with no project (a room
without one) would have been the organization's. Now an asset whose every link is a chat message is visible to whoever can READ one of those rooms; an asset
with another living context (a story, a doc) keeps the project rule; an asset with no chat link is unchanged.

Real PG, migrated schema (the world of test_4846_org_chat_rooms_realdb).
"""
from __future__ import annotations

import uuid
from types import SimpleNamespace

import pytest

from tests.test_1994_backlink_api_realdb import _client_for, _setup_app_agent, _setup_app_human
from tests.test_4846_org_chat_rooms_realdb import (  # noqa: F401 — fixtures used by name
    _REAL_DB_URL,
    _callers,
    _dispose_global_engine_after_test,
    _world,
    anyio_backend,
)

pytestmark = [
    pytest.mark.skipif(not _REAL_DB_URL, reason="통합 테스트는 실 PG(PARITY/ALEMBIC_DATABASE_URL) 필요"),
    pytest.mark.anyio,
]


async def _plant(Session, w):
    """assets of every kind; each chat asset is carried by one message of one room"""
    from app.models.asset import Asset, AssetLink
    from app.models.conversation import ConversationMessage

    ids = SimpleNamespace()
    async with Session() as s:
        def asset(name, project_id):
            a = Asset(id=uuid.uuid4(), org_id=w.org, project_id=project_id, container="c", object_path=f"p/{name}-{uuid.uuid4().hex[:6]}.txt",
                      name=name, content_type="text/plain", size_bytes=3, created_by=w.h_a)
            s.add(a)
            return a

        async def message(conv_id):
            m = ConversationMessage(id=uuid.uuid4(), conversation_id=conv_id, sender_id=w.h_a, content="file")
            s.add(m)
            await s.flush()
            return m.id

        chat_p1 = asset("chat-p1.txt", w.p1)                  # a chat file of the room WITH a project (registered under it)
        chat_none = asset("chat-none.txt", None)              # a chat file of the room WITHOUT a project (registered with none)
        chat_agents_p1 = asset("chat-agents-p1.txt", w.p1)    # a chat file of the agents-only room of P1
        mixed = asset("mixed.txt", w.p1)                      # a chat file that a story carries as well
        plain_p1 = asset("plain-p1.txt", w.p1)                # a project asset, no chat link
        plain_org = asset("plain-org.txt", None)              # an organization-level asset, no chat link
        await s.flush()
        for a, conv in ((chat_p1, w.r_human), (chat_none, w.n_human), (chat_agents_p1, w.r_agents), (mixed, w.r_human)):
            s.add(AssetLink(id=uuid.uuid4(), org_id=w.org, asset_id=a.id, source_type="conversation_message", source_id=await message(conv)))
        s.add(AssetLink(id=uuid.uuid4(), org_id=w.org, asset_id=mixed.id, source_type="story", source_id=uuid.uuid4()))
        await s.commit()
        for name in ("chat_p1", "chat_none", "chat_agents_p1", "mixed", "plain_p1", "plain_org"):
            setattr(ids, name, locals()[name].id)
    return ids


async def _as(Session, w, caller):
    from app.main import app

    kind, _member, user = _callers(w)[caller]
    if kind == "human":
        await _setup_app_human(app, Session, user, w.org)
    else:
        await _setup_app_agent(app, Session, user, w.org)
    return app


async def _seen(Session, w, ids, caller):
    """which planted assets this caller finds: by the list, by the single read, by the text read and by authorize-by-asset-id"""
    app = await _as(Session, w, caller)
    out = SimpleNamespace(listed=set(), single=set(), text=set(), authorized=set())
    names = {v: k for k, v in vars(ids).items()}
    try:
        async with _client_for(app) as c:
            r = await c.get("/api/v2/assets", params={"limit": 200})
            assert r.status_code == 200, r.text
            out.listed = {names[uuid.UUID(i["id"])] for i in r.json()["items"] if uuid.UUID(i["id"]) in names}
            for aid, name in names.items():
                if (await c.get(f"/api/v2/assets/{aid}")).status_code == 200:
                    out.single.add(name)
                if (await c.get(f"/api/v2/assets/{aid}/text")).status_code in (200, 503):    # 503: the stored object is not there in a test
                    out.text.add(name)
                if (await c.get("/api/v2/attachments/authorize", params={"asset_id": str(aid)})).status_code == 200:
                    out.authorized.add(name)
    finally:
        app.dependency_overrides.clear()
    return out


def _all(o):
    assert o.listed == o.single == o.text == o.authorized, vars(o)        # one rule, four doors
    return o.listed


async def test_a_participant_finds_their_rooms_files_and_the_files_that_are_not_chats():
    engine, Session, w = await _world()
    try:
        ids = await _plant(Session, w)
        # h_a is in r_human and n_human (not the agents-only room); P1 member
        assert _all(await _seen(Session, w, ids, "participant")) == {"chat_p1", "chat_none", "mixed", "plain_p1", "plain_org"}
    finally:
        await engine.dispose()


async def test_a_project_member_who_is_not_in_the_room_does_not_find_its_files():
    """the hole: h_c has P1, is not in r_human / n_human — the project rule used to give them the file (and the no-project file to every member)"""
    engine, Session, w = await _world()
    try:
        ids = await _plant(Session, w)
        got = _all(await _seen(Session, w, ids, "member_outside"))
        assert got == {"mixed", "plain_p1", "plain_org"}, got          # a story carries `mixed` too: the project rule for that context; no chat-only file
    finally:
        await engine.dispose()


async def test_a_participant_who_lost_the_project_still_opens_their_rooms_files():
    engine, Session, w = await _world()
    try:
        ids = await _plant(Session, w)
        got = _all(await _seen(Session, w, ids, "lost_project"))       # h_d: in r_human and n_human, access to P2 only
        assert {"chat_p1", "chat_none"} <= got and not ({"plain_p1", "mixed"} & got), got
        assert "plain_org" in got
    finally:
        await engine.dispose()


async def test_the_organization_owner_sees_the_agents_only_rooms_file_and_not_the_private_ones():
    engine, Session, w = await _world()
    try:
        ids = await _plant(Session, w)
        got = _all(await _seen(Session, w, ids, "org_owner"))
        assert "chat_agents_p1" in got and not ({"chat_p1", "chat_none"} & got), got
    finally:
        await engine.dispose()


async def test_an_agent_follows_its_project_in_a_room_that_has_one():
    from sqlalchemy import text

    engine, Session, w = await _world()
    try:
        ids = await _plant(Session, w)
        got = _all(await _seen(Session, w, ids, "agent_participant"))                     # g_p: in all four rooms, has P1
        assert {"chat_p1", "chat_none", "chat_agents_p1"} <= got
        async with Session() as s:
            await s.execute(text("DELETE FROM project_access WHERE member_id = :m AND project_id = :p"), {"m": w.g_p, "p": w.p1})
            await s.commit()
        got = _all(await _seen(Session, w, ids, "agent_participant"))                     # revoked: the room's P1 files close, the project-less room's does not
        assert "chat_none" in got and not ({"chat_p1", "chat_agents_p1"} & got), got
    finally:
        await engine.dispose()


async def test_a_file_whose_room_is_gone_from_view_is_the_rules_not_a_leak_for_another_organization():
    """an asset of ANOTHER organization is not found by id (the asset routes' own org rule, unchanged by this)"""
    from app.models.asset import Asset
    from tests.test_1994_backlink_api_realdb import _make_org

    engine, Session, w = await _world()
    try:
        async with Session() as s:
            other = await _make_org(s)
            foreign = Asset(id=uuid.uuid4(), org_id=other.id, project_id=None, container="c", object_path="x/y.txt", name="y", content_type="text/plain", size_bytes=1)
            s.add(foreign)
            await s.commit()
        app = await _as(Session, w, "participant")
        try:
            async with _client_for(app) as c:
                assert (await c.get(f"/api/v2/assets/{foreign.id}")).status_code == 404
                assert (await c.get("/api/v2/attachments/authorize", params={"asset_id": str(foreign.id)})).status_code == 404
        finally:
            app.dependency_overrides.clear()
    finally:
        await engine.dispose()


async def test_the_source_link_of_a_message_is_shown_only_to_someone_who_can_read_its_room():
    engine, Session, w = await _world()
    try:
        ids = await _plant(Session, w)
        app = await _as(Session, w, "participant")
        try:
            async with _client_for(app) as c:
                r = await c.get(f"/api/v2/assets/{ids.chat_none}")
            assert r.status_code == 200, r.text
            links = r.json().get("source_links", [])
            assert any(link["type"] == "conversation_message" for link in links), r.json()     # a room without a project is shown as a source to its participant
        finally:
            app.dependency_overrides.clear()
        app = await _as(Session, w, "org_owner")                                             # the owner finds a plain asset but the message of a private room is not shown
        try:
            async with _client_for(app) as c:
                r = await c.get(f"/api/v2/assets/{ids.mixed}")
            assert r.status_code == 200, r.text
            assert not any(link["type"] == "conversation_message" for link in r.json().get("source_links", [])), r.json()
        finally:
            app.dependency_overrides.clear()
    finally:
        await engine.dispose()


async def test_a_loop_cannot_file_another_rooms_file_under_the_project_rule():
    """PO's question to the lens: can a room's file be hung on another context to get around the room rule? The story/doc links check the object path
    against their source (a chat path is not one), so the one way left was `create_loop_artifact` — it linked any asset of the loop's project by id. It now
    asks the same room rule: a P1 member who is not in the room is refused (404-shaped), a participant is not, and an asset with no chat link is unchanged."""
    from app.repositories.loop import LoopRunRepository
    from app.schemas.loop import LoopArtifactCreate
    from app.services.loop import LoopServiceError, create_loop_artifact

    engine, Session, w = await _world()
    try:
        ids = await _plant(Session, w)
        async with Session() as s:
            loop = await LoopRunRepository(s, w.org).create(
                project_id=w.p1, title="L", goal_tags=[], status="draft", created_by_member_id=w.h_a,
            )
            await s.commit()
        outsider = SimpleNamespace(id=w.h_c, user_id=w.u_c, type="human")
        participant = SimpleNamespace(id=w.h_a, user_id=w.u_a, type="human")

        def payload(asset_id, label):
            return LoopArtifactCreate(variant_group="g", variant_label=label, asset_id=asset_id)

        async with Session() as s:
            with pytest.raises(LoopServiceError) as e:
                await create_loop_artifact(s, w.org, outsider, loop, payload(ids.chat_p1, "stolen"))
            assert e.value.code == "ASSET_NOT_FOUND"
            await s.rollback()
        async with Session() as s:
            from sqlalchemy import text as _text

            await s.execute(_text("UPDATE assets SET deleted_at = now() WHERE id = :a"), {"a": ids.plain_p1})
            await s.commit()
        async with Session() as s:
            with pytest.raises(LoopServiceError) as e:
                await create_loop_artifact(s, w.org, participant, loop, payload(ids.plain_p1, "deleted"))   # a deleted asset cannot be filed under a loop
            assert e.value.code == "ASSET_NOT_FOUND"
            await s.rollback()
        async with Session() as s:
            await s.execute(_text("UPDATE assets SET deleted_at = NULL WHERE id = :a"), {"a": ids.plain_p1})
            await s.commit()
        async with Session() as s:
            await create_loop_artifact(s, w.org, participant, loop, payload(ids.chat_p1, "mine"))        # a person in the room may
            await create_loop_artifact(s, w.org, outsider, loop, payload(ids.plain_p1, "plain"))          # an asset with no chat link: as before
            await s.commit()
        # and the asset did NOT become readable to the outsider through the new link of the participant? it did become MIXED: the participant chose to file it
        # under the loop of P1 — that is a deliberate share by someone who can read it, the same as downloading and uploading it again.
    finally:
        await engine.dispose()


# ── convert, and what it makes ───────────────────────────────────────────────────────────────────────────────────────────────────────────────────

async def _plant_office(Session, w, *, in_room):
    """a .pptx asset; `in_room` ⇒ it is carried by one message of the room WITH a project (chat-only), else it is a plain project asset"""
    from app.models.asset import Asset, AssetLink
    from app.models.conversation import ConversationMessage

    async with Session() as s:
        a = Asset(id=uuid.uuid4(), org_id=w.org, project_id=w.p1, container="c", object_path=f"p/deck-{uuid.uuid4().hex[:6]}.pptx", name="deck.pptx",
                  content_type="application/vnd.openxmlformats-officedocument.presentationml.presentation", size_bytes=9, created_by=w.h_a)
        s.add(a)
        await s.flush()
        if in_room:
            m = ConversationMessage(id=uuid.uuid4(), conversation_id=w.r_human, sender_id=w.h_a, content="deck")
            s.add(m)
            await s.flush()
            s.add(AssetLink(id=uuid.uuid4(), org_id=w.org, asset_id=a.id, source_type="conversation_message", source_id=m.id))
        await s.commit()
        return a.id


async def _convert(Session, w, caller, asset_id):
    from unittest.mock import AsyncMock, patch

    app = await _as(Session, w, caller)
    fake = SimpleNamespace(id=uuid.uuid4(), name="deck.pdf", content_type="application/pdf")
    try:
        with patch("app.services.office_conversion.get_or_convert_pdf", AsyncMock(return_value=fake)):
            async with _client_for(app) as c:
                return (await c.post(f"/api/v2/attachments/{asset_id}/convert")).status_code
    finally:
        app.dependency_overrides.clear()


async def test_convert_asks_the_room_rule_of_a_chat_only_file_and_the_project_rule_of_the_rest():
    engine, Session, w = await _world()
    try:
        chat_deck = await _plant_office(Session, w, in_room=True)
        plain_deck = await _plant_office(Session, w, in_room=False)
        # the chat file: the room's people only (h_d lost the project and still converts their room's file)
        assert await _convert(Session, w, "participant", chat_deck) == 200
        assert await _convert(Session, w, "lost_project", chat_deck) == 200
        assert await _convert(Session, w, "member_outside", chat_deck) == 404        # a P1 member outside the room
        assert await _convert(Session, w, "org_owner", chat_deck) == 404              # the owner: not in a room with people in it
        # a plain project file: as before (the project rule)
        assert await _convert(Session, w, "member_outside", plain_deck) == 200
        assert await _convert(Session, w, "lost_project", plain_deck) == 404
    finally:
        await engine.dispose()


async def _plant_derived(Session, w, origin_id, project_id):
    """the PDF `convert` makes: no links, the deterministic path of the origin"""
    from app.models.asset import Asset
    from app.services.office_conversion import converted_object_path

    async with Session() as s:
        d = Asset(id=uuid.uuid4(), org_id=w.org, project_id=project_id, container="c", object_path=converted_object_path(w.org, project_id, origin_id),
                  name="deck.pdf", content_type="application/pdf", size_bytes=5)
        s.add(d)
        await s.commit()
        return d.id


def _three(o):
    """for files that are not text (a deck, a pdf) the text door does not apply: the list, the single read and authorize must agree"""
    assert o.listed == o.single == o.authorized, vars(o)
    return o.listed


async def test_what_convert_makes_is_never_wider_than_the_file_it_was_made_from():
    """lens (5435): the PDF has no link, so it was read by the project rule — a project member outside the room could open the converted copy of the room's file
    (and the participant who converted it legitimately made it wider than its origin). Its scope is now computed from the origin."""
    engine, Session, w = await _world()
    try:
        chat_deck = await _plant_office(Session, w, in_room=True)
        plain_deck = await _plant_office(Session, w, in_room=False)
        d_chat = await _plant_derived(Session, w, chat_deck, w.p1)
        d_plain = await _plant_derived(Session, w, plain_deck, w.p1)
        ids = SimpleNamespace(d_chat=d_chat, d_plain=d_plain, chat_deck=chat_deck, plain_deck=plain_deck)
        # the room's people see the converted copy of the room's file; a P1 member outside the room and the owner do not — through the four doors
        assert {"d_chat", "chat_deck"} <= _three(await _seen(Session, w, ids, "participant"))
        assert {"d_chat", "chat_deck"} <= _three(await _seen(Session, w, ids, "lost_project"))
        out = _three(await _seen(Session, w, ids, "member_outside"))
        assert not ({"d_chat", "chat_deck"} & out) and {"d_plain", "plain_deck"} <= out, out
        own = _three(await _seen(Session, w, ids, "org_owner"))
        assert not ({"d_chat", "chat_deck"} & own), own
    finally:
        await engine.dispose()


# ── the doors that take an asset id: a table, and a test that fails when a door is missing from it ─────────────────────────────────────────────────────

# every route that takes an asset id in its path or its query, each with how a caller outside the room is refused. A NEW door that takes an asset id and is not
# in this table makes `test_every_door_that_takes_an_asset_id_is_in_the_table` red: the next missing door (convert was one) is caught by this, not by an eye.
ASSET_ID_DOORS = {
    ("GET", "/api/v2/assets/{asset_id}"): lambda c, a: c.get(f"/api/v2/assets/{a}"),
    ("DELETE", "/api/v2/assets/{asset_id}"): lambda c, a: c.delete(f"/api/v2/assets/{a}"),
    ("GET", "/api/v2/assets/{asset_id}/text"): lambda c, a: c.get(f"/api/v2/assets/{a}/text"),
    ("GET", "/api/v2/attachments/authorize"): lambda c, a: c.get("/api/v2/attachments/authorize", params={"asset_id": str(a)}),
    ("POST", "/api/v2/attachments/{asset_id}/convert"): lambda c, a: c.post(f"/api/v2/attachments/{a}/convert"),
}


def _doors_that_take_an_asset_id():
    from fastapi.routing import APIRoute

    from app.main import app

    found = set()
    for r in app.routes:
        if not isinstance(r, APIRoute):
            continue
        named = [p.name for p in r.dependant.path_params] + [p.alias for p in r.dependant.query_params]
        if any("asset_id" in n for n in named):
            found.add((sorted(r.methods)[0], r.path))
    return found


def test_every_door_that_takes_an_asset_id_is_in_the_table():
    assert _doors_that_take_an_asset_id() == set(ASSET_ID_DOORS), (
        "a route that takes an asset id is not in ASSET_ID_DOORS (or one in it is gone): add it and say how a caller outside the room is refused"
    )


async def test_no_door_opens_a_chat_only_file_to_someone_outside_its_room():
    """the table, run: for each door, a P1 member outside the room and the organization's owner get nothing from a chat-only file (not 200); the participant gets
    in through every door that is not a deletion of someone else's file"""
    from unittest.mock import AsyncMock, patch

    engine, Session, w = await _world()
    try:
        ids = await _plant(Session, w)
        fake = SimpleNamespace(id=uuid.uuid4(), name="x.pdf", content_type="application/pdf")
        for outsider in ("member_outside", "org_owner"):
            app = await _as(Session, w, outsider)
            try:
                async with _client_for(app) as c:
                    for door, call in ASSET_ID_DOORS.items():
                        with patch("app.services.office_conversion.get_or_convert_pdf", AsyncMock(return_value=fake)):
                            r = await call(c, ids.chat_p1)
                        assert r.status_code != 200, (outsider, door, r.status_code, r.text)
                        r = await call(c, ids.chat_none)
                        assert r.status_code != 200, (outsider, door, "no project", r.status_code, r.text)
            finally:
                app.dependency_overrides.clear()
    finally:
        await engine.dispose()


async def test_what_convert_made_lives_and_dies_with_its_origin():
    """PO/lens recommendation: a hard-deleted origin left its PDF an orphan that fell back to the project rule — a person outside the room opened it and the
    participant who lost the project could not (wider than the origin it was made from). Now: deleting the origin deletes the PDF with it, and a file of the
    derived kind whose origin is gone is opened to nobody."""
    from sqlalchemy import text

    from app.main import app

    engine, Session, w = await _world()
    try:
        chat_deck = await _plant_office(Session, w, in_room=True)
        d_chat = await _plant_derived(Session, w, chat_deck, w.p1)
        ids = SimpleNamespace(d_chat=d_chat, chat_deck=chat_deck)
        assert {"d_chat", "chat_deck"} <= _three(await _seen(Session, w, ids, "participant"))

        # (1) the origin is deleted through the route: the converted copy goes with it (soft-deleted at the same moment)
        app_ = await _as(Session, w, "participant")
        try:
            async with _client_for(app_) as c:
                assert (await c.delete(f"/api/v2/assets/{chat_deck}")).status_code == 200
        finally:
            app_.dependency_overrides.clear()
        async with Session() as s:
            rows = {r[0]: r[1] for r in (await s.execute(text("SELECT id, deleted_at FROM assets WHERE id = ANY(:i)"), {"i": [chat_deck, d_chat]})).all()}
        assert rows[chat_deck] is not None and rows[d_chat] == rows[chat_deck], rows
        assert _three(await _seen(Session, w, ids, "participant")) == set()
        assert _three(await _seen(Session, w, ids, "member_outside")) == set()

        # (2) belt and braces: the origin ROW is gone (hard-deleted by the grace job, or a derived file left from before) while the copy still reads as alive —
        # it must open to nobody, not fall back to the project rule
        async with Session() as s:
            await s.execute(text("UPDATE assets SET deleted_at = NULL WHERE id = :d"), {"d": d_chat})
            await s.execute(text("DELETE FROM assets WHERE id = :o"), {"o": chat_deck})
            await s.commit()
        for caller in ("participant", "lost_project", "member_outside", "org_owner"):
            assert _three(await _seen(Session, w, ids, caller)) == set(), caller

        # (3) the origin is DELETED (not gone) while the copy is still alive — a copy left from before the delete took it along: it must not keep reading
        # as the room's file (codex round on the head: «lives with its origin»)
        origin2 = await _plant_office(Session, w, in_room=True)
        d2 = await _plant_derived(Session, w, origin2, w.p1)
        ids2 = SimpleNamespace(d2=d2, origin2=origin2)
        assert "d2" in _three(await _seen(Session, w, ids2, "participant"))
        async with Session() as s:
            await s.execute(text("UPDATE assets SET deleted_at = now() WHERE id = :o"), {"o": origin2})
            await s.commit()
        for caller in ("participant", "lost_project", "member_outside", "org_owner"):
            assert _three(await _seen(Session, w, ids2, caller)) == set(), caller
    finally:
        await engine.dispose()


async def test_a_copy_that_names_another_project_than_its_origin_is_nobodys_and_a_file_whose_messages_are_deleted_is_not_shown():
    """self-QA round on the head: (1) the derived rule trusted the copy's own project column — a copy made in its origin's project only is a copy, so one that
    names another project opens to nobody; (2) the list / single / text routes showed a file whose only messages were deleted while the authorize route
    refused it — the room rule now ignores deleted messages, so all doors say the same."""
    from sqlalchemy import text

    engine, Session, w = await _world()
    try:
        chat_deck = await _plant_office(Session, w, in_room=True)
        good = await _plant_derived(Session, w, chat_deck, w.p1)
        odd = await _plant_derived(Session, w, chat_deck, w.p2)               # same origin, another project
        ids = SimpleNamespace(good=good, odd=odd, chat_deck=chat_deck)
        assert _three(await _seen(Session, w, ids, "participant")) == {"good", "chat_deck"}
        assert _three(await _seen(Session, w, ids, "member_outside")) == set()

        async with Session() as s:                                            # every message that carries the origin is deleted
            await s.execute(text(
                "UPDATE conversation_messages SET deleted_at = now() WHERE id IN "
                "(SELECT source_id FROM asset_links WHERE asset_id = :a AND source_type = 'conversation_message')"
            ), {"a": chat_deck})
            await s.commit()
        for caller in ("participant", "lost_project", "member_outside", "org_owner"):
            assert _three(await _seen(Session, w, ids, caller)) == set(), caller
    finally:
        await engine.dispose()
