"""story 5030 (C0) — in a group room an agent hears only the words that call it. Real PG, the real `route_message`.

Why this file exists: the 8-13 hotfix (3008) switched this default off, and nobody could say why switching it ON had «blocked part of the team». The reason, found by 5030 on dev numbers
(4,101 of 4,103 agent global rows were the seed, untouched, made within seconds of the agent): agent creation wrote `global / sse / all` for every agent, the router puts an explicit row ahead
of the product default, so an agent WITH the seed row kept hearing every word and only an agent WITHOUT it met the default — a team that is blocked unevenly. These tests hold the whole rule
(none of them patches the flag: they read the code default):

  1. group room, a word that calls nobody  → no agent hears it (people still do)
  2. a word that calls A                   → A only
  3. agents made the way the product makes them (the creation helper) and agents made without a row behave the SAME — reproduced with the flag ON, the August state
  4. «hear everything in this channel»: a conversation-scope or project-scope `all` row (the rows the C2 switch writes through PUT /notification-preferences) puts that agent — and only it — ahead of the default
  5. a reply in a thread the agent already spoke in reaches it; a thread it never spoke in does not; an explicit `mentions` choice is respected
  6. a one-to-one room is untouched (`all`) · a `free_response` room still lets everything through · `mute` still mutes
  7. the migration removes the seed that is PROVEN to be the seed and nothing a person chose
"""
from __future__ import annotations

import importlib.util
import os
import uuid
from datetime import timedelta
from pathlib import Path
from unittest.mock import patch

import pytest

_REAL_DB_URL = os.getenv("PARITY_TEST_DATABASE_URL") or os.getenv("ALEMBIC_DATABASE_URL")

pytestmark = [
    pytest.mark.skipif(not _REAL_DB_URL, reason="통합 테스트는 실 PG(PARITY/ALEMBIC_DATABASE_URL) 필요"),
]


@pytest.fixture
def anyio_backend():
    return "asyncio"


@pytest.fixture(autouse=True)
async def _dispose_global_engine_after_test():
    yield
    from app.core.database import engine as _global_engine
    await _global_engine.dispose()


def _async_url() -> str:
    url = _REAL_DB_URL
    for prefix in ("postgresql+psycopg2://", "postgresql+asyncpg://", "postgresql://"):
        if url.startswith(prefix):
            return "postgresql+asyncpg://" + url[len(prefix):]
    return url


async def _session_factory():
    from sqlalchemy.ext.asyncio import async_sessionmaker, create_async_engine
    engine = create_async_engine(_async_url())
    return engine, async_sessionmaker(engine, expire_on_commit=False)


async def _world(s, *, agents=("A", "B", "C"), free_response: bool = False):
    """An org with one person (H), the named agents, a group room of all of them, and a one-to-one room H↔A."""
    from app.models.conversation import Conversation, ConversationParticipant
    from app.models.member import Member
    from app.models.organization import Organization
    from app.models.project import Project
    from app.models.project_access import ProjectAccess
    from app.models.user import User

    org = Organization(id=uuid.uuid4(), name="Org", slug=f"org-{uuid.uuid4().hex[:8]}")
    s.add(org)
    await s.commit()
    project = Project(id=uuid.uuid4(), org_id=org.id, name="P")
    s.add(project)
    await s.commit()

    uid = uuid.uuid4()
    s.add(User(id=uid, email=f"h-{uid.hex[:8]}@test.com", hashed_password="x"))
    await s.commit()
    human = Member(id=uuid.uuid4(), org_id=org.id, type="human", user_id=uid, name="H")
    s.add(human)
    await s.commit()
    members = {"H": human}
    for name in agents:
        m = Member(id=uuid.uuid4(), org_id=org.id, type="agent", name=name, is_active=True)
        s.add(m)
        members[name] = m
    await s.commit()
    for m in members.values():
        s.add(ProjectAccess(id=uuid.uuid4(), project_id=project.id, member_id=m.id, permission="granted", role="member"))
    await s.commit()

    room = Conversation(
        id=uuid.uuid4(), project_id=project.id, org_id=org.id, type="group", title="room",
        created_by=human.id, free_response=free_response,
    )
    s.add(room)
    await s.flush()
    for m in members.values():
        s.add(ConversationParticipant(conversation_id=room.id, member_id=m.id))
    dm = None
    if "A" in members:
        dm = Conversation(
            id=uuid.uuid4(), project_id=project.id, org_id=org.id, type="dm", title="dm", created_by=human.id,
            dm_pair_key=f"{min(human.id, members['A'].id)}:{max(human.id, members['A'].id)}",
        )
        s.add(dm)
        await s.flush()
        for m in (human, members["A"]):
            s.add(ConversationParticipant(conversation_id=dm.id, member_id=m.id))
    await s.commit()
    return {"org": org, "project": project, "m": members, "room": room, "dm": dm}


async def _say(s, conv, sender, content="word", *, mentioned=(), thread=None, metadata=None):
    from app.models.conversation import ConversationMessage

    msg = ConversationMessage(
        id=uuid.uuid4(), conversation_id=conv.id, sender_id=sender.id, content=content,
        mentioned_ids=[m.id for m in mentioned], thread_id=thread.id if thread is not None else None,
        msg_metadata=metadata,
    )
    s.add(msg)
    await s.commit()
    return msg


async def _heard(s, msg) -> dict[uuid.UUID, str]:
    """member id → the reason of the decision, for everyone the router decided to deliver `msg` to."""
    from app.services.channel_router import route_message

    return {d.member_id: d.reason for d in await route_message(msg.id, s)}


async def _pref(s, member, *, scope_type, scope_id=None, level="all", channel="sse"):
    from app.models.notification_preference import NotificationPreference

    s.add(NotificationPreference(
        id=uuid.uuid4(), member_id=member.id, scope_type=scope_type, scope_id=scope_id, channel=channel, level=level,
    ))
    await s.commit()


# ── 1 · 2 ─ the default itself ───────────────────────────────────────────────────────────────────────────────────────────────────
@pytest.mark.anyio
async def test_a_word_that_calls_nobody_reaches_no_agent_but_people_still_get_it():
    engine, Session = await _session_factory()
    try:
        async with Session() as s:
            w = await _world(s)
            heard = await _heard(s, await _say(s, w["room"], w["m"]["H"]))
            assert not {w["m"][n].id for n in "ABC"} & set(heard), heard

            # a word from an agent that calls nobody: the people of the room keep hearing it (a person's default is `all`)
            heard = await _heard(s, await _say(s, w["room"], w["m"]["A"]))
            assert w["m"]["H"].id in heard
            assert not {w["m"][n].id for n in "BC"} & set(heard), heard
    finally:
        await engine.dispose()


@pytest.mark.anyio
async def test_a_word_that_calls_one_agent_reaches_that_agent_only():
    engine, Session = await _session_factory()
    try:
        async with Session() as s:
            w = await _world(s)
            heard = await _heard(s, await _say(s, w["room"], w["m"]["H"], mentioned=[w["m"]["B"]]))
            assert {n for n in "ABC" if w["m"][n].id in heard} == {"B"}, heard
            assert heard[w["m"]["B"].id] == "agent group default: mentions"
    finally:
        await engine.dispose()


# ── 3 ─ the August reproduction: the row the product itself wrote ────────────────────────────────────────────────────────────────
@pytest.mark.anyio
async def test_agents_the_product_creates_behave_like_agents_without_a_row_when_the_default_is_on():
    """The August state (flag ON) reproduced: an agent made by the creation helper and an agent made without any row must hear the SAME words.
    Before 5030 the helper wrote `global / sse / all` and that row beat the default — A heard everything, B was blocked: «part of the team blocked».
    Reverting `_AGENT_DEFAULTS` to the old seed turns this red."""
    from app.services.notification_preference_defaults import insert_default_preferences

    engine, Session = await _session_factory()
    try:
        async with Session() as s:
            w = await _world(s, agents=("A", "B"))
            await insert_default_preferences(s, w["m"]["A"].id, "agent")  # exactly what team_members / org_agent run on a new agent
            await s.commit()
            with patch("app.services.channel_router.settings.agent_group_default_mentions", True):
                heard = await _heard(s, await _say(s, w["room"], w["m"]["H"]))
            assert not {w["m"]["A"].id, w["m"]["B"].id} & set(heard), (
                "creation seeds a row that beats the group default → the team is blocked unevenly", heard,
            )
    finally:
        await engine.dispose()


@pytest.mark.anyio
async def test_creating_an_agent_writes_no_preference_row_but_a_person_still_gets_theirs():
    from sqlalchemy import select

    from app.models.notification_preference import NotificationPreference
    from app.services.notification_preference_defaults import insert_default_preferences

    engine, Session = await _session_factory()
    try:
        async with Session() as s:
            w = await _world(s, agents=("A",))
            await insert_default_preferences(s, w["m"]["A"].id, "agent")
            await insert_default_preferences(s, w["m"]["H"].id, "human")
            await s.commit()
            rows = (await s.execute(select(NotificationPreference).where(
                NotificationPreference.member_id.in_([w["m"]["A"].id, w["m"]["H"].id])
            ))).scalars().all()
            assert [(r.member_id, r.scope_type, r.channel, r.level) for r in rows] == [
                (w["m"]["H"].id, "global", "in_app", "all"),
            ]
    finally:
        await engine.dispose()


# ── 4 ─ «hear everything in this channel» ──────────────────────────────────────────────────────────────────────────────────────────
@pytest.mark.anyio
async def test_conversation_scope_all_puts_that_agent_and_only_it_ahead_of_the_default():
    engine, Session = await _session_factory()
    try:
        async with Session() as s:
            w = await _world(s)
            await _pref(s, w["m"]["A"], scope_type="conversation", scope_id=w["room"].id, level="all")
            heard = await _heard(s, await _say(s, w["room"], w["m"]["H"]))
            assert {n for n in "ABC" if w["m"][n].id in heard} == {"A"}, heard
            assert heard[w["m"]["A"].id] == "preference scope=conversation"
    finally:
        await engine.dispose()


@pytest.mark.anyio
async def test_project_scope_all_is_the_channel_switch_and_reaches_the_rooms_of_that_project_only():
    from app.models.conversation import Conversation, ConversationParticipant
    from app.models.project import Project

    engine, Session = await _session_factory()
    try:
        async with Session() as s:
            w = await _world(s)
            await _pref(s, w["m"]["C"], scope_type="project", scope_id=w["project"].id, level="all")
            heard = await _heard(s, await _say(s, w["room"], w["m"]["H"]))
            assert {n for n in "ABC" if w["m"][n].id in heard} == {"C"}, heard

            other_project = Project(id=uuid.uuid4(), org_id=w["org"].id, name="P2")
            s.add(other_project)
            await s.commit()
            other_room = Conversation(
                id=uuid.uuid4(), project_id=other_project.id, org_id=w["org"].id, type="group", title="other",
                created_by=w["m"]["H"].id,
            )
            s.add(other_room)
            await s.flush()
            for n in ("H", "A", "C"):
                s.add(ConversationParticipant(conversation_id=other_room.id, member_id=w["m"][n].id))
            await s.commit()
            heard = await _heard(s, await _say(s, other_room, w["m"]["H"]))
            assert not {w["m"]["A"].id, w["m"]["C"].id} & set(heard), heard
    finally:
        await engine.dispose()


@pytest.mark.anyio
async def test_the_channel_switch_api_writes_a_row_the_router_then_honours():
    """AC4 end to end: an admin turns «hear everything in this channel» on for ONE agent through PUT /notification-preferences (what the C2 switch calls)."""
    from app.dependencies.auth import AuthContext, get_current_user
    from app.main import app
    from httpx import ASGITransport, AsyncClient
    from tests.conftest import override_db_and_read

    engine, Session = await _session_factory()
    try:
        async with Session() as s:
            w = await _world(s)
            h = w["m"]["H"]
            from app.models.project import OrgMember  # the caller is a JWT person: the API resolves them through the org member

            s.add(OrgMember(id=uuid.uuid4(), org_id=w["org"].id, user_id=h.user_id, role="admin"))
            await s.commit()

        async def _db():
            async with Session() as sess:
                try:
                    yield sess
                    await sess.commit()
                except Exception:
                    await sess.rollback()
                    raise

        async def _auth():
            return AuthContext(
                user_id=str(h.user_id), email="h@test",
                claims={"app_metadata": {"org_id": str(w["org"].id), "role": "admin"}},
            )

        override_db_and_read(app, _db)
        app.dependency_overrides[get_current_user] = _auth
        try:
            async with AsyncClient(transport=ASGITransport(app=app), base_url="http://test") as client:
                r = await client.put("/api/v2/notification-preferences", json={
                    "member_id": str(w["m"]["B"].id),
                    "preferences": [{
                        "scope_type": "conversation", "scope_id": str(w["room"].id), "channel": "sse", "level": "all",
                    }],
                })
        finally:
            app.dependency_overrides.clear()
        assert r.status_code == 200, r.text

        async with Session() as s:
            heard = await _heard(s, await _say(s, w["room"], h))
            assert {n for n in "ABC" if w["m"][n].id in heard} == {"B"}, heard
    finally:
        await engine.dispose()


# ── 4b ─ the websocket room follows the router ─────────────────────────────────────────────────────────────────────────────────────
@pytest.mark.anyio
async def test_an_agent_holding_a_websocket_room_hears_only_what_the_router_delivered():
    """The post-commit websocket broadcast used to send the raw words to EVERY agent participant: the SSE event was withheld but an agent holding a websocket room still got every word,
    and an explicit mute did not hold either (codex review of 5030). Real HTTP send, a fake websocket room per agent."""
    from unittest.mock import AsyncMock

    from app.dependencies.auth import AuthContext, get_current_user
    from app.main import app
    from app.models.project import OrgMember
    from httpx import ASGITransport, AsyncClient
    from tests.conftest import override_db_and_read

    engine, Session = await _session_factory()
    try:
        async with Session() as s:
            w = await _world(s)
            h = w["m"]["H"]
            s.add(OrgMember(id=uuid.uuid4(), org_id=w["org"].id, user_id=h.user_id, role="member"))
            await s.commit()
            await _pref(s, w["m"]["C"], scope_type="project", scope_id=w["project"].id, level="mute")

        async def _db():
            async with Session() as sess:
                try:
                    yield sess
                    await sess.commit()
                except Exception:
                    await sess.rollback()
                    raise

        async def _auth():
            return AuthContext(user_id=str(h.user_id), email="h@test", claims={"app_metadata": {"org_id": str(w["org"].id)}})

        sent: list[str] = []

        async def _fake_broadcast(aid, payload, conversation_id=None):
            sent.append(aid)

        rooms = {str(w["m"][n].id): object() for n in "ABC"}
        override_db_and_read(app, _db)
        app.dependency_overrides[get_current_user] = _auth
        try:
            with patch("app.routers.ws_chat._rooms", rooms), patch("app.routers.ws_chat._broadcast", AsyncMock(side_effect=_fake_broadcast)):
                async with AsyncClient(transport=ASGITransport(app=app), base_url="http://test") as client:
                    url = f"/api/v2/conversations/{w['room'].id}/messages"
                    r = await client.post(url, json={"content": "calls nobody", "mentioned_ids": []})
                    assert r.status_code == 201, r.text
                    assert sent == [], f"an uncalled word reached a websocket room: {sent}"

                    r = await client.post(url, json={"content": "calls B", "mentioned_ids": [str(w["m"]["B"].id)]})
                    assert r.status_code == 201, r.text
                    assert sent == [str(w["m"]["B"].id)], sent

                    sent.clear()
                    r = await client.post(url, json={"content": "calls C who muted the project", "mentioned_ids": [str(w["m"]["C"].id)]})
                    assert r.status_code == 201, r.text
                    assert str(w["m"]["C"].id) not in sent, "an explicit mute must hold on the websocket road too"
        finally:
            app.dependency_overrides.clear()
    finally:
        await engine.dispose()


# ── 5 ─ threads ────────────────────────────────────────────────────────────────────────────────────────────────────────────────────
@pytest.mark.anyio
async def test_a_reply_in_a_thread_the_agent_already_spoke_in_reaches_it_and_nobody_else():
    engine, Session = await _session_factory()
    try:
        async with Session() as s:
            w = await _world(s)
            root = await _say(s, w["room"], w["m"]["A"], "started by A", mentioned=[w["m"]["H"]])
            reply = await _say(s, w["room"], w["m"]["H"], "answer without calling anyone", thread=root)
            heard = await _heard(s, reply)
            assert {n for n in "ABC" if w["m"][n].id in heard} == {"A"}, heard
            assert heard[w["m"]["A"].id] == "agent group default: mentions + thread member"

            # B spoke only as a reply of the same thread → it is a member of the thread from then on
            await _say(s, w["room"], w["m"]["B"], "B joins", mentioned=[w["m"]["H"]], thread=root)
            heard = await _heard(s, await _say(s, w["room"], w["m"]["H"], "second answer", thread=root))
            assert {n for n in "ABC" if w["m"][n].id in heard} == {"A", "B"}, heard
    finally:
        await engine.dispose()


@pytest.mark.anyio
async def test_a_thread_the_agent_never_spoke_in_does_not_reach_it():
    engine, Session = await _session_factory()
    try:
        async with Session() as s:
            w = await _world(s)
            root = await _say(s, w["room"], w["m"]["H"], "a person's word")
            heard = await _heard(s, await _say(s, w["room"], w["m"]["H"], "its reply", thread=root))
            assert not {w["m"][n].id for n in "ABC"} & set(heard), heard
    finally:
        await engine.dispose()


@pytest.mark.anyio
async def test_an_explicit_mentions_choice_is_not_widened_by_the_thread_rule():
    engine, Session = await _session_factory()
    try:
        async with Session() as s:
            w = await _world(s)
            await _pref(s, w["m"]["A"], scope_type="conversation", scope_id=w["room"].id, level="mentions")
            root = await _say(s, w["room"], w["m"]["A"], "started by A", mentioned=[w["m"]["H"]])
            heard = await _heard(s, await _say(s, w["room"], w["m"]["H"], "answer", thread=root))
            assert w["m"]["A"].id not in heard, heard
    finally:
        await engine.dispose()


# ── 6 ─ what must not move ─────────────────────────────────────────────────────────────────────────────────────────────────────────
@pytest.mark.anyio
async def test_a_one_to_one_room_is_untouched():
    engine, Session = await _session_factory()
    try:
        async with Session() as s:
            w = await _world(s)
            heard = await _heard(s, await _say(s, w["dm"], w["m"]["H"], "no call, just talking"))
            assert heard == {w["m"]["A"].id: "default: all"}, heard
    finally:
        await engine.dispose()


@pytest.mark.anyio
async def test_a_free_response_room_still_lets_every_word_through():
    engine, Session = await _session_factory()
    try:
        async with Session() as s:
            w = await _world(s, free_response=True)
            heard = await _heard(s, await _say(s, w["room"], w["m"]["H"]))
            assert {n for n in "ABC" if w["m"][n].id in heard} == {"A", "B", "C"}, heard
            assert heard[w["m"]["A"].id].endswith("free_response override")
    finally:
        await engine.dispose()


@pytest.mark.anyio
async def test_a_muted_agent_stays_muted_even_when_called():
    engine, Session = await _session_factory()
    try:
        async with Session() as s:
            w = await _world(s)
            await _pref(s, w["m"]["A"], scope_type="project", scope_id=w["project"].id, level="mute")
            heard = await _heard(s, await _say(s, w["room"], w["m"]["H"], mentioned=[w["m"]["A"]]))
            assert w["m"]["A"].id not in heard, heard
    finally:
        await engine.dispose()


# ── 7 ─ the migration ──────────────────────────────────────────────────────────────────────────────────────────────────────────────
def _run_upgrade(sync_conn) -> None:
    from alembic.migration import MigrationContext
    from alembic.operations import Operations

    # the folder `backend/alembic` shares its name with the library — load the revision by its path
    path = Path(__file__).resolve().parent.parent / "alembic" / "versions" / "0501_drop_seeded_agent_global_all.py"
    spec = importlib.util.spec_from_file_location("rev_0501", path)
    mod = importlib.util.module_from_spec(spec)
    spec.loader.exec_module(mod)
    with Operations.context(MigrationContext.configure(sync_conn)):
        mod.upgrade()


@pytest.mark.anyio
async def test_the_migration_removes_only_the_seed_that_is_proven_to_be_the_seed():
    from sqlalchemy import select

    from app.models.member import Member
    from app.models.notification_preference import NotificationPreference

    engine, Session = await _session_factory()
    try:
        async with Session() as s:
            w = await _world(s, agents=("SEED", "TOUCHED", "LATE", "INAPP", "LEVEL", "SCOPED"))
            m = w["m"]
            created = (await s.execute(select(Member.created_at).where(Member.id == m["SEED"].id))).scalar_one()

            def _row(member, *, created_at, updated_at=None, channel="sse", level="all", scope_type="global", scope_id=None):
                return NotificationPreference(
                    id=uuid.uuid4(), member_id=member.id, scope_type=scope_type, scope_id=scope_id, channel=channel,
                    level=level, created_at=created_at, updated_at=updated_at or created_at,
                )

            s.add_all([
                _row(m["SEED"], created_at=created + timedelta(seconds=1)),                                      # the seed, as the creation helper wrote it
                _row(m["TOUCHED"], created_at=created + timedelta(seconds=1), updated_at=created + timedelta(minutes=5)),  # saved again later
                _row(m["LATE"], created_at=created + timedelta(hours=2)),                                        # made long after the agent
                _row(m["INAPP"], created_at=created + timedelta(seconds=1), channel="in_app"),                   # another channel
                _row(m["LEVEL"], created_at=created + timedelta(seconds=1), level="mentions"),                   # another level
                _row(m["SCOPED"], created_at=created + timedelta(seconds=1), scope_type="conversation", scope_id=w["room"].id),  # the channel switch
                _row(m["H"], created_at=created, channel="in_app"),                                                   # a person's own row
            ])
            await s.commit()

        async with engine.begin() as conn:
            await conn.run_sync(_run_upgrade)

        async with Session() as s:
            ids = [m[n].id for n in ("SEED", "TOUCHED", "LATE", "INAPP", "LEVEL", "SCOPED", "H")]
            kept = {
                r.member_id for r in (await s.execute(
                    select(NotificationPreference).where(NotificationPreference.member_id.in_(ids))
                )).scalars().all()
            }
            assert m["SEED"].id not in kept, "the proven seed must go"
            for n in ("TOUCHED", "LATE", "INAPP", "LEVEL", "SCOPED", "H"):
                assert m[n].id in kept, f"{n}: a row a person made or changed must stay"
    finally:
        await engine.dispose()
