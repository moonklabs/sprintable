"""story 4847 (AC-명령 실시간) — the result card of a server command reaches the person who typed it on their open screen.

Measured 2026-11-09 (local server, real EventSource frames): in an OPEN room a plain line posted from outside arrives live, but the server's command-result card — in a room with a project (`invalid_args`) and in
one without (`ROOM_HAS_NO_PROJECT`) alike — never did; it appeared only after the room was opened again. Two causes in the send route: `try_execute_server_command` dropped the push list
`_dispatch_conversation_event` returns, and the card is written with sender = the person who typed, who is left out of that function's recipients. Without the card in front of them the command
stays «silent» for the person who typed it.

These tests drive the real send route over a migrated PG and watch `_push_to_agent` (the one door every live event goes through): the card goes to the person who typed — and to nobody else — after the echo of
their own line; it carries the same fields a later read of the room returns; a plain line makes no card push.
"""
from __future__ import annotations

import os
import uuid

import pytest

from tests.test_1994_backlink_api_realdb import (
    _add_message,
    _client_for,
    _make_agent_member,
    _make_conversation,
    _make_human_member,
    _make_org,
    _make_project,
    _session_factory,
    _setup_app_human,
)

_REAL_DB_URL = os.getenv("PARITY_TEST_DATABASE_URL") or os.getenv("ALEMBIC_DATABASE_URL")

pytestmark = [
    pytest.mark.skipif(not _REAL_DB_URL, reason="통합 테스트는 실 PG(PARITY/ALEMBIC_DATABASE_URL) 필요"),
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


async def _room(*, with_project: bool, with_agent: bool = False, with_third: bool = False):
    """(Session factory, org, sender member id, sender user, the other person's member id, room id) — `_room.agent` holds the agent member's id when there is one"""
    engine, Session = await _session_factory()
    async with Session() as session:
        org = await _make_org(session)
        project = await _make_project(session, org.id)
        sender_id, sender_user = await _make_human_member(session, org.id, project.id)
        other_id, _other_user = await _make_human_member(session, org.id, project.id)
        members = [sender_id, other_id]
        _room.agent = None
        _room.third = None
        if with_third:
            _room.third, _third_user = await _make_human_member(session, org.id, project.id)
            members.append(_room.third)
        if with_agent:
            _room.agent = await _make_agent_member(session, org.id, project.id)
            members.append(_room.agent)
        conv_id = await _make_conversation(session, org.id, project.id, members, sender_id)
        if not with_project:
            from sqlalchemy import text

            await session.execute(text("UPDATE conversations SET project_id = NULL WHERE id = :i"), {"i": conv_id})
            await session.commit()
    return engine, Session, org, sender_id, sender_user, other_id, conv_id


async def _send(Session, app, user, org_id, conv_id, content, monkeypatch, thread_id=None):
    pushes: list[tuple[str, dict]] = []
    monkeypatch.setattr("app.routers.conversations._push_to_agent", lambda pid, payload: pushes.append((str(pid), payload)))
    await _setup_app_human(app, Session, user, org_id)
    async with _client_for(app) as client:
        resp = await client.post(f"/api/v2/conversations/{conv_id}/messages", json={"content": content, "client_nonce": "nonce-4847", **({"thread_id": str(thread_id)} if thread_id else {})})
    app.dependency_overrides.clear()
    assert resp.status_code == 201, resp.text
    return pushes


async def _read(Session, app, user, org_id, conv_id):
    await _setup_app_human(app, Session, user, org_id)
    async with _client_for(app) as client:
        resp = await client.get(f"/api/v2/conversations/{conv_id}/messages")
    app.dependency_overrides.clear()
    assert resp.status_code == 200, resp.text
    body = resp.json()
    return body.get("data", body) if isinstance(body, dict) else body


def _cards(pushes):
    return [(pid, p) for pid, p in pushes if (p.get("server_command") or {}).get("command")]


async def test_01_a_command_in_a_room_with_a_project_pushes_its_card_to_the_person_who_typed_it_after_their_own_line(monkeypatch):
    from app.main import app

    engine, Session, org, sender_id, sender_user, other_id, conv_id = await _room(with_project=True)
    try:
        pushes = await _send(Session, app, sender_user, org.id, conv_id, "/assign 99999 nobody", monkeypatch)
        cards = [(pid, c) for pid, c in _cards(pushes) if pid == str(sender_id)]
        assert len(cards) == 1, f"exactly one card push to the person who typed it, got {len(cards)}"
        pid, card = cards[0]
        assert pid == str(sender_id), "the card goes to the person who typed the command"
        assert card["event_type"] == "conversation.message_created" and card["recipient_id"] == str(sender_id)
        assert card["server_command"]["command"] == "assign"
        echo_at = next(i for i, (p, x) in enumerate(pushes) if p == str(sender_id) and x.get("client_nonce") == "nonce-4847")
        assert pushes.index((pid, card)) > echo_at, "after the echo of their own line: the card answers it"
    finally:
        await engine.dispose()


async def test_02_a_command_in_a_room_with_no_project_pushes_the_card_with_its_machine_code(monkeypatch):
    from app.main import app

    engine, Session, org, sender_id, sender_user, other_id, conv_id = await _room(with_project=False)
    try:
        pushes = await _send(Session, app, sender_user, org.id, conv_id, "/assign 1 somebody", monkeypatch)
        (pid, card), = [(p, c) for p, c in _cards(pushes) if p == str(sender_id)]
        assert pid == str(sender_id)
        assert card["server_command"] == {"command": "assign", "outcome": "denied", "code": "ROOM_HAS_NO_PROJECT"}
    finally:
        await engine.dispose()


async def test_03_the_card_goes_to_the_rooms_other_people_too(monkeypatch):
    from app.main import app

    engine, Session, org, sender_id, sender_user, other_id, conv_id = await _room(with_project=True)
    try:
        pushes = await _send(Session, app, sender_user, org.id, conv_id, "/assign 99999 nobody", monkeypatch)
        who = {pid for pid, _ in _cards(pushes)}
        assert who == {str(sender_id), str(other_id)}, "the person who typed it and the room's other person — the recipients of an ordinary message"
        other_card = next(p for pid, p in _cards(pushes) if pid == str(other_id))
        assert other_card["server_command"]["command"] == "assign" and other_card["event_type"] == "conversation.message_created"
        plain = await _send(Session, app, sender_user, org.id, conv_id, "just a line", monkeypatch)
        assert _cards(plain) == [], "a plain line makes no card push"
    finally:
        await engine.dispose()


async def test_04_the_pushed_card_is_the_same_message_a_later_read_returns(monkeypatch):
    from app.main import app

    engine, Session, org, sender_id, sender_user, other_id, conv_id = await _room(with_project=False)
    try:
        pushes = await _send(Session, app, sender_user, org.id, conv_id, "/assign 1 somebody", monkeypatch)
        (_pid, pushed), = [(p, c) for p, c in _cards(pushes) if p == str(sender_id)]
        listed = await _read(Session, app, sender_user, org.id, conv_id)
        items = listed if isinstance(listed, list) else listed.get("items", [])
        read_back = next(m for m in items if m.get("id") == pushed["id"])
        for key in ("id", "conversation_id", "content", "server_command", "created_at", "message_kind"):
            assert pushed.get(key) == read_back.get(key), f"the event and the read must say the same about {key}"
    finally:
        await engine.dispose()


async def test_05_a_command_typed_in_a_thread_gets_its_card_in_that_thread_and_the_counters_follow(monkeypatch):
    from sqlalchemy import select

    from app.main import app
    from app.models.conversation import ConversationMessage
    from datetime import datetime, timezone

    engine, Session, org, sender_id, sender_user, other_id, conv_id = await _room(with_project=True)
    try:
        async with Session() as session:
            root = await _add_message(session, conv_id, other_id, "a root line", datetime.now(timezone.utc))
        pushes = await _send(Session, app, sender_user, org.id, conv_id, "/assign 99999 nobody", monkeypatch, thread_id=root.id)
        async with Session() as session:
            rows = (await session.execute(select(ConversationMessage).where(ConversationMessage.conversation_id == conv_id).order_by(ConversationMessage.created_at))).scalars().all()
            root_after = next(r for r in rows if r.id == root.id)
            replies = [r for r in rows if r.thread_id == root.id]
            assert len(replies) == 2, "the line that asked and the card that answers it are both in the thread"
            card = next(r for r in replies if (r.msg_metadata or {}).get("server_command"))
            assert card.thread_id == root.id
            assert root_after.reply_count == 2, "the thread's counter counts the card like any other reply"
            assert root_after.last_reply_at is not None
        for pid, payload in _cards(pushes):
            assert payload["thread_id"] == str(root.id), "the live card names its thread: the open thread shows it, the room's top does not"
    finally:
        await engine.dispose()


async def test_06_a_command_outside_a_thread_leaves_the_card_top_level(monkeypatch):
    from sqlalchemy import select

    from app.main import app
    from app.models.conversation import ConversationMessage

    engine, Session, org, sender_id, sender_user, other_id, conv_id = await _room(with_project=True)
    try:
        await _send(Session, app, sender_user, org.id, conv_id, "/assign 99999 nobody", monkeypatch)
        async with Session() as session:
            rows = (await session.execute(select(ConversationMessage).where(ConversationMessage.conversation_id == conv_id))).scalars().all()
            assert all(r.thread_id is None for r in rows)
    finally:
        await engine.dispose()


async def test_07_a_person_who_blocked_the_sender_gets_no_card_either(monkeypatch):
    """the card is delivered with the exclusions of the line that asked for it: whoever does not get the line does not get its answer."""
    import uuid as _uuid

    from app.main import app
    from app.models.user_block import UserBlock

    engine, Session, org, sender_id, sender_user, other_id, conv_id = await _room(with_project=True)
    try:
        async with Session() as session:
            session.add(UserBlock(id=_uuid.uuid4(), blocker_member_id=other_id, blocked_member_id=sender_id))
            await session.commit()
        pushes = await _send(Session, app, sender_user, org.id, conv_id, "/assign 99999 nobody", monkeypatch)
        who = {pid for pid, _ in _cards(pushes)}
        assert who == {str(sender_id)}, "the person who blocked the sender is not sent the card; the person who typed it still is"
    finally:
        await engine.dispose()


async def test_08_a_person_the_typed_line_reaches_by_discord_still_gets_the_card_live(monkeypatch):
    """only the typed line is sent to Discord (and to webhooks) — the card is not, so excluding that person from the card would leave them without it anywhere."""
    from app.main import app
    from app.services import channel_router

    engine, Session, org, sender_id, sender_user, other_id, conv_id = await _room(with_project=True)
    try:
        async def _route(message_id, db):
            return [channel_router.DeliveryDecision(member_id=other_id, channel="discord", level="all", reason="test")]

        monkeypatch.setattr(channel_router, "route_message", _route)
        pushes = await _send(Session, app, sender_user, org.id, conv_id, "/assign 99999 nobody", monkeypatch)
        who = {pid for pid, _ in _cards(pushes)}
        assert str(other_id) in who, "the Discord-routed person gets the card live: nothing else delivers it to them"
    finally:
        await engine.dispose()


async def test_09_a_person_whose_preferences_turn_the_room_off_gets_no_card(monkeypatch):
    """the room's own notification decision names the people the typed line reaches; whoever it leaves out (muted) is left out of the card too."""
    from app.main import app
    from app.services import channel_router

    engine, Session, org, sender_id, sender_user, other_id, conv_id = await _room(with_project=True, with_third=True)
    muted = _room.third
    try:
        async def _route(message_id, db):
            return [channel_router.DeliveryDecision(member_id=other_id, channel="sse", level="all", reason="test")]  # the third person is not named: muted

        monkeypatch.setattr(channel_router, "route_message", _route)
        pushes = await _send(Session, app, sender_user, org.id, conv_id, "/assign 99999 nobody", monkeypatch)
        who = {pid for pid, _ in _cards(pushes)}
        assert str(muted) not in who, "the muted person gets no card"
        assert who == {str(sender_id), str(other_id)}, "the person the decision names, and the one who typed it, do"
    finally:
        await engine.dispose()


async def test_10_a_person_who_blocked_the_sender_gets_no_card_even_when_the_room_decision_fails(monkeypatch):
    """the block is its own lookup: a failing notification decision (no preference exclusion at all) must not let the card through to someone who blocked the sender."""
    import uuid as _uuid

    from app.main import app
    from app.models.user_block import UserBlock
    from app.services import channel_router

    engine, Session, org, sender_id, sender_user, other_id, conv_id = await _room(with_project=True, with_third=True)
    third = _room.third
    try:
        async with Session() as session:
            session.add(UserBlock(id=_uuid.uuid4(), blocker_member_id=other_id, blocked_member_id=sender_id))
            await session.commit()

        async def _route_fails(message_id, db):
            raise channel_router.ChannelRouterError("simulated")

        monkeypatch.setattr(channel_router, "route_message", _route_fails)
        pushes = await _send(Session, app, sender_user, org.id, conv_id, "/assign 99999 nobody", monkeypatch)
        who = {pid for pid, _ in _cards(pushes)}
        assert str(other_id) not in who, "whoever blocked the sender is not sent the card, whatever the room decision did"
        assert {str(sender_id), str(third)} <= who, "the others still get it"
    finally:
        await engine.dispose()


async def test_11_the_agents_of_the_room_are_left_out_of_the_card_delivery(monkeypatch):
    """by design the agents never see a command line the server already executed (so none can do it a second time) — nor its result card: they would react to a command they were never shown. Asked of
    the delivery call itself (what it is told to leave out): an agent's records are made by a path this room fixture does not reach, so the argument is the observable."""
    import app.routers.conversations as conv_mod
    from app.main import app

    engine, Session, org, sender_id, sender_user, other_id, conv_id = await _room(with_project=True, with_agent=True)
    agent_id = _room.agent
    try:
        from sqlalchemy import select, text

        from app.models.conversation import Conversation
        from app.models.team import TeamMember

        async with Session() as session:
            # a runtime that DOES take slash commands: the capability gate does not exclude it, so only the server-command rule can
            await session.execute(text("UPDATE members SET runtime_type = 'claude-code' WHERE id = :i"), {"i": agent_id})
            kind = (await session.execute(text("SELECT table_type FROM information_schema.tables WHERE table_name = 'team_members'"))).scalar_one()
            if kind == "BASE TABLE":  # (a create_all DB keeps team_members as a plain table; a migrated DB shows the agent through its view — nothing to enter)
                project_id = (await session.get(Conversation, conv_id)).project_id
                session.add(TeamMember(id=agent_id, org_id=org.id, project_id=project_id, type="agent", name="agent-x", user_id=None, is_active=True, runtime_type="claude-code"))
            await session.commit()
            seen = (await session.execute(select(TeamMember.type, TeamMember.runtime_type).where(TeamMember.id == agent_id))).first()
            assert seen is not None and seen[0] == "agent" and seen[1] == "claude-code", "precondition: the agent is a team member that takes slash commands"
        from app.services import channel_router

        async def _route(message_id, db):  # the room decision names the agent too: its exclusion must come from the server-command rule, not from «not named»
            return [channel_router.DeliveryDecision(member_id=m, channel="sse", level="all", reason="test") for m in (other_id, agent_id)]

        monkeypatch.setattr(channel_router, "route_message", _route)
        calls = []
        real = conv_mod._dispatch_conversation_event

        async def spy(db, conv, msg, org_id, sender, *args, **kwargs):
            calls.append((bool((getattr(msg, "msg_metadata", None) or {}).get("server_command")), set(kwargs.get("exclude_ids") or set())))
            return await real(db, conv, msg, org_id, sender, *args, **kwargs)

        monkeypatch.setattr(conv_mod, "_dispatch_conversation_event", spy)
        await _send(Session, app, sender_user, org.id, conv_id, "/assign 99999 nobody", monkeypatch)
        card_calls = [ex for is_card, ex in calls if is_card]
        assert card_calls, "the card was delivered through the dispatch"
        assert all(agent_id in ex for ex in card_calls), "the agents of the room are left out of the card's delivery"
    finally:
        await engine.dispose()
