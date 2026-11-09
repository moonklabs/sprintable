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
    _client_for,
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


async def _room(*, with_project: bool):
    """(Session factory, org, sender member id, sender user, the other person's member id, room id)"""
    engine, Session = await _session_factory()
    async with Session() as session:
        org = await _make_org(session)
        project = await _make_project(session, org.id)
        sender_id, sender_user = await _make_human_member(session, org.id, project.id)
        other_id, _other_user = await _make_human_member(session, org.id, project.id)
        conv_id = await _make_conversation(session, org.id, project.id, [sender_id, other_id], sender_id)
        if not with_project:
            from sqlalchemy import text

            await session.execute(text("UPDATE conversations SET project_id = NULL WHERE id = :i"), {"i": conv_id})
            await session.commit()
    return engine, Session, org, sender_id, sender_user, other_id, conv_id


async def _send(Session, app, user, org_id, conv_id, content, monkeypatch):
    pushes: list[tuple[str, dict]] = []
    monkeypatch.setattr("app.routers.conversations._push_to_agent", lambda pid, payload: pushes.append((str(pid), payload)))
    await _setup_app_human(app, Session, user, org_id)
    async with _client_for(app) as client:
        resp = await client.post(f"/api/v2/conversations/{conv_id}/messages", json={"content": content, "client_nonce": "nonce-4847"})
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
        cards = _cards(pushes)
        assert len(cards) == 1, f"exactly one card push, got {len(cards)}"
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
        (pid, card), = _cards(pushes)
        assert pid == str(sender_id)
        assert card["server_command"] == {"command": "assign", "outcome": "denied", "code": "ROOM_HAS_NO_PROJECT"}
    finally:
        await engine.dispose()


async def test_03_the_card_goes_to_nobody_else_and_a_plain_line_makes_no_card_push(monkeypatch):
    from app.main import app

    engine, Session, org, sender_id, sender_user, other_id, conv_id = await _room(with_project=True)
    try:
        pushes = await _send(Session, app, sender_user, org.id, conv_id, "/assign 99999 nobody", monkeypatch)
        assert {pid for pid, _ in _cards(pushes)} == {str(sender_id)}, "only the person who typed it"
        plain = await _send(Session, app, sender_user, org.id, conv_id, "just a line", monkeypatch)
        assert _cards(plain) == [], "a plain line makes no card push"
    finally:
        await engine.dispose()


async def test_04_the_pushed_card_is_the_same_message_a_later_read_returns(monkeypatch):
    from app.main import app

    engine, Session, org, sender_id, sender_user, other_id, conv_id = await _room(with_project=False)
    try:
        pushes = await _send(Session, app, sender_user, org.id, conv_id, "/assign 1 somebody", monkeypatch)
        (_pid, pushed), = _cards(pushes)
        listed = await _read(Session, app, sender_user, org.id, conv_id)
        items = listed if isinstance(listed, list) else listed.get("items", [])
        read_back = next(m for m in items if m.get("id") == pushed["id"])
        for key in ("id", "conversation_id", "content", "server_command", "created_at", "message_kind"):
            assert pushed.get(key) == read_back.get(key), f"the event and the read must say the same about {key}"
    finally:
        await engine.dispose()
