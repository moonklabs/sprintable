"""story #4418 — WS chat: an owner-floor person's message is saved *and* broadcast, and the sender's socket stays open.

Before: `_authenticate` answers an owner-floor person (org owner/admin with no project grant, #2216) with `_CallerIdentity`
(.id/.org_id only), and the hub built the broadcast with `caller.name` → AttributeError after the message was saved: nothing
was broadcast and the exception left the handler, closing the sender's socket on every message (reproduced 2026-09-29 on a
real PG + real WS round trip).

Real PG (migrated DB · ALEMBIC_DATABASE_URL) and a real WebSocket through Starlette's TestClient. The router opens its own
sessions through `async_session_factory`; it is patched with a NullPool factory so the TestClient's own event loop can use it.
"""
from __future__ import annotations

import asyncio
import json
import logging
import os
import uuid

import pytest
from sqlalchemy import text
from sqlalchemy.ext.asyncio import async_sessionmaker, create_async_engine
from sqlalchemy.pool import NullPool

_RAW = os.environ.get("ALEMBIC_DATABASE_URL") or os.environ.get("PARITY_TEST_DATABASE_URL") or ""
_ASYNC = _RAW.replace("postgresql+psycopg2://", "postgresql+asyncpg://").replace("postgresql://", "postgresql+asyncpg://")

pytestmark = pytest.mark.skipif(not _RAW, reason="real-DB URL 미설정 — skip")

ORG = uuid.UUID("d4418c00-0000-0000-0000-000000000010")
OWNER_USER = uuid.UUID("d4418c00-0000-0000-0000-000000000011")
TM_USER = uuid.UUID("d4418c00-0000-0000-0000-000000000012")
NAMELESS_USER = uuid.UUID("d4418c00-0000-0000-0000-000000000013")
PROJ = uuid.UUID("d4418c00-0000-0000-0000-000000000014")
AGENT = uuid.UUID("d4418c00-0000-0000-0000-000000000015")
TM = uuid.UUID("d4418c00-0000-0000-0000-000000000016")


def _run(coro):
    loop = asyncio.new_event_loop()
    try:
        return loop.run_until_complete(coro)
    finally:
        loop.close()


async def _exec(*sqls: str, fetch: str | None = None):
    eng = create_async_engine(_ASYNC, poolclass=NullPool)
    try:
        async with async_sessionmaker(eng)() as s:
            for sql in sqls:
                await s.execute(text(sql))
            rows = (await s.execute(text(fetch))).all() if fetch else None
            await s.commit()
            return rows
    finally:
        await eng.dispose()


_CLEAN = [
    f"DELETE FROM conversation_messages WHERE conversation_id IN (SELECT id FROM conversations WHERE org_id='{ORG}')",
    f"DELETE FROM conversation_participants WHERE conversation_id IN (SELECT id FROM conversations WHERE org_id='{ORG}')",
    f"DELETE FROM conversations WHERE org_id='{ORG}'",
    f"DELETE FROM agent_project_profiles WHERE project_id='{PROJ}'",
    f"DELETE FROM project_access WHERE project_id='{PROJ}'",
    f"DELETE FROM members WHERE org_id='{ORG}'",
    f"DELETE FROM projects WHERE org_id='{ORG}'",
    f"DELETE FROM org_members WHERE org_id='{ORG}'",
    f"DELETE FROM users WHERE id IN ('{OWNER_USER}','{TM_USER}','{NAMELESS_USER}')",
    f"DELETE FROM organizations WHERE id='{ORG}'",
]


@pytest.fixture
def world():
    _run(_exec(*_CLEAN))
    _run(_exec(
        f"INSERT INTO organizations (id,name,slug,plan) VALUES ('{ORG}','O','d4418c-org','free')",
        "INSERT INTO users (id,email,hashed_password,display_name,is_active,email_verified,login_fail_count,totp_enabled,"
        "totp_fail_count) VALUES "
        f"('{OWNER_USER}','owner@d4418c.test','x','Owner',true,true,0,false,0),"
        f"('{TM_USER}','tm@d4418c.test','x','TM user',true,true,0,false,0),"
        f"('{NAMELESS_USER}','nameless@d4418c.test','x',NULL,true,true,0,false,0)",
        f"INSERT INTO projects (id,org_id,name,slug,violation_level) VALUES ('{PROJ}','{ORG}','P','d4418c-proj','warn')",
        # owner-floor people: org_members only (no members row, no project grant — #2216)
        f"INSERT INTO org_members (id,org_id,user_id,role) VALUES (gen_random_uuid(),'{ORG}','{OWNER_USER}','owner')",
        f"INSERT INTO org_members (id,org_id,user_id,role) VALUES (gen_random_uuid(),'{ORG}','{NAMELESS_USER}','admin')",
        f"INSERT INTO org_members (id,org_id,user_id,role) VALUES (gen_random_uuid(),'{ORG}','{TM_USER}','member')",
        # a person with a project grant (TeamMember) and the agent whose room it is
        f"INSERT INTO members (id,org_id,user_id,type,name,is_active) VALUES ('{TM}','{ORG}','{TM_USER}','human','TM',true)",
        f"INSERT INTO members (id,org_id,user_id,type,name,is_active) VALUES ('{AGENT}','{ORG}',NULL,'agent','Agent',true)",
        f"INSERT INTO project_access (id,project_id,member_id,permission) VALUES (gen_random_uuid(),'{PROJ}','{TM}','granted')",
        f"INSERT INTO agent_project_profiles (id,member_id,project_id) VALUES (gen_random_uuid(),'{AGENT}','{PROJ}')",
    ))
    yield
    _run(_exec(*_CLEAN))


@pytest.fixture
def client(monkeypatch):
    from starlette.testclient import TestClient

    from app.main import app

    monkeypatch.setattr(
        "app.routers.ws_chat.async_session_factory",
        async_sessionmaker(create_async_engine(_ASYNC, poolclass=NullPool), expire_on_commit=False),
    )
    with TestClient(app) as c:
        yield c


def _token(user_id: uuid.UUID) -> str:
    from app.core.security import create_access_token

    return create_access_token(user_id=str(user_id))


def _saved() -> list[str]:
    rows = _run(_exec(fetch=(
        "SELECT m.content FROM conversation_messages m JOIN conversations c ON c.id = m.conversation_id "
        f"WHERE c.org_id='{ORG}' ORDER BY m.created_at"
    )))
    return [r[0] for r in rows]


def _say(ws, content: str) -> dict:
    ws.send_text(json.dumps({"content": content}))
    return json.loads(ws.receive_text())


def test_an_owner_floor_person_is_saved_broadcast_and_stays_connected(world, client):
    with client.websocket_connect(f"/ws/chat/{AGENT}?token={_token(OWNER_USER)}") as ws:
        first = _say(ws, "first")
        second = _say(ws, "second")  # the socket is still open after the first message
    assert (first["content"], first["sender_name"]) == ("first", "Owner")  # users.display_name
    assert second["content"] == "second"
    assert _saved() == ["first", "second"]


def test_an_owner_floor_person_without_a_display_name_gets_no_invented_name(world, client):
    """#3747 contract: no display name → None (no email, no id string)."""
    with client.websocket_connect(f"/ws/chat/{AGENT}?token={_token(NAMELESS_USER)}") as ws:
        got = _say(ws, "hi")
    assert got["sender_name"] is None
    assert _saved() == ["hi"]


def test_a_team_member_is_unchanged(world, client):
    with client.websocket_connect(f"/ws/chat/{AGENT}?token={_token(TM_USER)}") as ws:
        got = _say(ws, "hello")
    assert (got["content"], got["sender_name"], got["sender_id"]) == ("hello", "TM", str(TM))  # TeamMember.name
    assert _saved() == ["hello"]


def test_a_broadcast_failure_is_logged_and_the_sender_keeps_its_socket(world, client, monkeypatch, caplog):
    """The message is saved; the broadcast raising must not close the sender's socket. It is logged (error, once per
    message) and the sender gets the saved message back as its confirmation."""
    import app.routers.ws_chat as ws_chat

    async def broken_broadcast(room_key, payload):
        raise RuntimeError("injected broadcast failure")

    monkeypatch.setattr(ws_chat, "_broadcast", broken_broadcast)
    caplog.set_level(logging.ERROR, logger="app.routers.ws_chat")
    with client.websocket_connect(f"/ws/chat/{AGENT}?token={_token(OWNER_USER)}") as ws:
        first = _say(ws, "one")
        second = _say(ws, "two")
    assert [first["content"], second["content"]] == ["one", "two"]
    assert _saved() == ["one", "two"]
    failures = [r for r in caplog.records if "broadcast failed after save" in r.getMessage()]
    assert len(failures) == 2 and all(r.levelno == logging.ERROR for r in failures)


def test_one_receiver_failing_does_not_stop_the_others():
    """`_broadcast` keeps going past a receiver whose send fails, drops it from the room, and logs it."""
    import app.routers.ws_chat as ws_chat

    got: list[str] = []

    class Broken:
        async def send_text(self, payload):
            raise RuntimeError("gone")

    class Ok:
        async def send_text(self, payload):
            got.append(payload)

    broken, ok = Broken(), Ok()
    ws_chat._rooms["room-4418"] = {broken, ok}
    try:
        _run(ws_chat._broadcast("room-4418", "p"))
        assert got == ["p"]
        assert ws_chat._rooms.get("room-4418") == {ok}
    finally:
        ws_chat._rooms.pop("room-4418", None)


def test_an_owner_floor_person_delivering_through_the_channel_route_is_saved_and_broadcast(world, client, monkeypatch):
    """Qadir 01a0eb42 — `routers/channel.py` uses the same `_authenticate`, and its `_persist_and_broadcast` read `caller.name`
    after the commit: saved, then a 500 and nothing broadcast. A listener in the agent's room now gets the message."""
    monkeypatch.setattr(
        "app.routers.channel.async_session_factory",
        async_sessionmaker(create_async_engine(_ASYNC, poolclass=NullPool), expire_on_commit=False),
    )
    with client.websocket_connect(f"/ws/chat/{AGENT}?token={_token(TM_USER)}") as listener:
        resp = client.post(
            f"/api/v2/channel/deliver?token={_token(OWNER_USER)}", json={"agent_id": str(AGENT), "content": "via route"},
        )
        got = json.loads(listener.receive_text())
    assert resp.status_code == 204, resp.text
    assert (got["content"], got["sender_name"]) == ("via route", "Owner")
    assert _saved() == ["via route"]


def test_a_failure_before_the_loop_takes_the_socket_out_of_the_room(world, client, monkeypatch):
    """Qadir 01a0eb42 — resolving the name (and the conversation) happens inside the handler's try/finally: if it fails, the
    socket does not stay registered in the room."""
    import app.routers.ws_chat as ws_chat

    async def broken_resolver(*args, **kwargs):
        raise RuntimeError("injected resolver failure")

    monkeypatch.setattr(ws_chat, "resolve_member_display_name", broken_resolver)
    with pytest.raises(Exception):  # noqa: B017 — the server-side error surfaces through the test client
        with client.websocket_connect(f"/ws/chat/{AGENT}?token={_token(OWNER_USER)}") as ws:
            ws.receive_text()
    assert str(AGENT) not in ws_chat._rooms


def test_a_disconnect_while_broadcasting_is_a_disconnect_not_a_broadcast_failure(world, client, monkeypatch, caplog):
    """Qadir 01a0eb42 — the broad `except` around the broadcast let a `WebSocketDisconnect` through as «broadcast failed»; it is
    re-raised to the handler's own disconnect path (no error log, socket out of the room)."""
    import time

    from fastapi import WebSocketDisconnect

    import app.routers.ws_chat as ws_chat

    async def disconnecting_broadcast(room_key, payload):
        raise WebSocketDisconnect(code=1001)

    caplog.set_level(logging.INFO, logger="app.routers.ws_chat")
    with client.websocket_connect(f"/ws/chat/{AGENT}?token={_token(OWNER_USER)}") as ws:
        assert _say(ws, "hi")["content"] == "hi"  # the handler is in its loop
        monkeypatch.setattr(ws_chat, "_broadcast", disconnecting_broadcast)
        ws.send_text(json.dumps({"content": "bye"}))
        for _ in range(200):  # the handler runs on the client's own loop thread; wait for it to leave (bounded)
            if str(AGENT) not in ws_chat._rooms:
                break
            time.sleep(0.05)
    assert _saved() == ["hi", "bye"]
    assert not [r for r in caplog.records if "broadcast failed after save" in r.getMessage()]
    assert [r for r in caplog.records if "ws_chat: disconnected" in r.getMessage()]
    assert str(AGENT) not in ws_chat._rooms


def test_a_broadcast_failure_on_the_channel_route_is_logged_and_the_delivery_still_succeeds(world, client, monkeypatch, caplog):
    """The message is saved: the route answers 204 and logs the broadcast failure instead of a 500."""
    import app.routers.channel as channel

    async def broken_broadcast(room_key, payload):
        raise RuntimeError("injected broadcast failure")

    monkeypatch.setattr(
        "app.routers.channel.async_session_factory",
        async_sessionmaker(create_async_engine(_ASYNC, poolclass=NullPool), expire_on_commit=False),
    )
    monkeypatch.setattr(channel, "_broadcast", broken_broadcast)
    caplog.set_level(logging.ERROR, logger="app.routers.channel")
    resp = client.post(f"/api/v2/channel/deliver?token={_token(OWNER_USER)}", json={"agent_id": str(AGENT), "content": "x"})
    assert resp.status_code == 204, resp.text
    assert _saved() == ["x"]
    assert len([r for r in caplog.records if "broadcast failed after save" in r.getMessage()]) == 1
