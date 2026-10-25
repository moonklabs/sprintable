"""story #4774 (WebSocket part, on top of story 4775) — an OPEN WebSocket a person holds ends when the person's seat in the organization ends.

Measured before (real socket server, uvicorn + websockets): a person removed from the organization kept their socket open for 40 s+ (no lifetime cap), a message they sent 3 s after
the removal was kept and broadcast. Story 4775's per-line judgement already refuses a removed person's send/receive; this pins WHEN and WITH WHAT CODE the open socket itself ends,
with the same judgement as SSE (5224) and the request authentication (person_seat_revoked):
  01  a removed person's socket is closed 4001 access_revoked the next time a line would be sent to it, a living person in the room keeps hearing everything;
  01b a removed person's message is not kept and the socket closes 4001;
  01c an idle socket is closed by the timer;
  01d a NEW connection of the removed person is refused and nothing of theirs is kept;
  04  the identity of a person who is in two organizations is the one IN THE AGENT'S organization, whichever row comes first (the nondeterminism found while measuring)."""
from __future__ import annotations

import asyncio
import json
import os
import socket
import time
import uuid

import pytest
import uvicorn
import websockets

from tests.test_4752_account_delete_realdb import _close, _world
from tests.test_4769_member_removal_closes_devices_realdb import _remove, _seat
from tests.test_4772_request_auth_org_membership_realdb import _bearer, _project_of, _two_organizations

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


@pytest.fixture(autouse=True)
def _no_rate_limit(monkeypatch):
    from app.core.rate_limit import limiter
    monkeypatch.setattr(limiter, "enabled", False)


def _free_port() -> int:
    s = socket.socket()
    s.bind(("127.0.0.1", 0))
    port = s.getsockname()[1]
    s.close()
    return port


class _Server:
    """A real socket server of the app in this process (so a real client can hold a connection open across a removal)."""

    def __init__(self, app) -> None:
        self.port = _free_port()
        self.server = uvicorn.Server(uvicorn.Config(app, host="127.0.0.1", port=self.port, lifespan="off", log_level="warning"))
        self.task: asyncio.Task | None = None

    async def __aenter__(self):
        self.task = asyncio.create_task(self.server.serve())
        for _ in range(100):
            if self.server.started:
                return self
            await asyncio.sleep(0.1)
        raise RuntimeError("server did not start")

    async def __aexit__(self, *exc):
        self.server.should_exit = True
        await asyncio.sleep(0.3)
        if self.task is not None:
            self.task.cancel()


async def _scalar(w, q: str, **kw):
    from sqlalchemy import text
    async with w.Session() as s:
        return (await s.execute(text(q), kw)).scalar_one()


async def _world_with_agent():
    """Org X (owner O, admin M with a single organization), an agent of X and the tokens."""
    engine, w = await _world()
    owner_email, org_x, org_y, m, m_email, tok_x, tok_y = await _two_organizations(w)
    # one organization for M unless a test is about two (a TeamMember row per organization is the thing under test in 04)
    await w.sql("DELETE FROM project_access WHERE org_member_id IN (SELECT id FROM org_members WHERE org_id = :y AND user_id = :u)", y=org_y, u=m)
    owner = await w.tokens(owner_email)
    project = await _project_of(w, org_x)
    r = await w.client.post("/api/v2/agents", headers=_bearer(owner, org_x), json={"name": "Agent 4774", "scope_mode": "projects", "project_ids": [str(project)]})
    assert r.status_code == 201, r.text
    owner_uid = await _scalar(w, "SELECT id FROM users WHERE email = :e", e=owner_email)
    return engine, w, owner_email, owner, owner_uid, org_x, org_y, m, tok_x, tok_y, r.json()["id"], project


async def _ws_url(port: int, agent_id, tokens: dict) -> str:
    return f"ws://127.0.0.1:{port}/ws/chat/{agent_id}?token={tokens['access_token']}"


async def _recv_content(ws, content: str, tries: int = 6) -> dict:
    """The next line with this content (earlier lines of other DMs the agent is in come first)."""
    for _ in range(tries):
        d = json.loads(await asyncio.wait_for(ws.recv(), 10))
        if d.get("content") == content:
            return d
    raise AssertionError(f"never heard {content!r}")


async def _agent_key(w, agent_id) -> str:
    """An agent key of the agent (the agent's own socket answers a conversation by naming it)."""
    from app.core.security import hash_token

    key = "sk_live_" + uuid.uuid4().hex
    await w.sql(
        "INSERT INTO agent_api_keys (id, team_member_id, member_id, key_prefix, key_hash) VALUES (gen_random_uuid(), :a, :a, 'sk_live_', :h)",
        a=uuid.UUID(str(agent_id)), h=hash_token(key),
    )
    return key


async def test_01_a_websocket_of_a_removed_person_is_closed_at_the_next_line_and_a_living_one_is_not(monkeypatch):
    from app.routers import ws_chat

    monkeypatch.setattr(ws_chat, "_WS_ACCESS_RECHECK_SEC", 600.0)   # not the timer: the broadcast gate under test
    engine, w, owner_email, owner, owner_uid, org_x, org_y, m, tok_x, tok_y, agent_id, project = await _world_with_agent()
    try:
        key = await _agent_key(w, agent_id)
        async with _Server(w.app) as srv:
            async with websockets.connect(await _ws_url(srv.port, agent_id, tok_x)) as wm, \
                    websockets.connect(await _ws_url(srv.port, agent_id, owner)) as wo, \
                    websockets.connect(f"ws://127.0.0.1:{srv.port}/ws/chat/{agent_id}?api_key={key}") as wa:
                await wm.send(json.dumps({"content": "M before the removal"}))
                first = json.loads(await asyncio.wait_for(wm.recv(), 10))
                conv_m = first["conversation_id"]
                await wo.send(json.dumps({"content": "owner before the removal"}))
                owner_conv = json.loads(await asyncio.wait_for(wo.recv(), 10))["conversation_id"]
                # the agent answers each DM: both people hear their own line (the control: the agent's socket is the one that sends)
                await wa.send(json.dumps({"content": "agent to M before", "conversation_id": conv_m}))
                await _recv_content(wm, "agent to M before")
                await _recv_content(wa, "agent to M before")
                assert (await _remove(w, owner_email, org_x, m)).status_code == 200

                # the agent answers M's DM again, then the owner's: M's socket is NOT sent the line and is closed 4001; the living owner's socket hears its own line
                await wa.send(json.dumps({"content": "agent to M AFTER the removal", "conversation_id": conv_m}))
                with pytest.raises(websockets.exceptions.ConnectionClosed) as closed:
                    await asyncio.wait_for(wm.recv(), 10)
                assert closed.value.rcvd is not None and closed.value.rcvd.code == 4001, closed.value
                await wa.send(json.dumps({"content": "agent to owner", "conversation_id": owner_conv}))
                await _recv_content(wo, "agent to owner")   # a living person keeps hearing
    finally:
        await _close(engine, w)


async def test_01b_a_removed_person_cannot_send_on_a_socket_that_stayed_open_quietly(monkeypatch):
    from app.routers import ws_chat

    monkeypatch.setattr(ws_chat, "_WS_ACCESS_RECHECK_SEC", 600.0)   # not the timer: the check before a message is kept under test
    """The socket nobody has spoken to since the removal: M sends first. The message must not be kept (the seat is asked before a message is kept) and the socket closes 4001."""
    engine, w, owner_email, owner, owner_uid, org_x, org_y, m, tok_x, tok_y, agent_id, project = await _world_with_agent()
    try:
        async with _Server(w.app) as srv:
            async with websockets.connect(await _ws_url(srv.port, agent_id, tok_x)) as wm:
                await wm.send(json.dumps({"content": "M before the removal"}))
                await asyncio.wait_for(wm.recv(), 10)
                assert (await _remove(w, owner_email, org_x, m)).status_code == 200
                await wm.send(json.dumps({"content": "M AFTER the removal"}))
                with pytest.raises(websockets.exceptions.ConnectionClosed) as closed:
                    await asyncio.wait_for(wm.recv(), 10)
                assert closed.value.rcvd is not None and closed.value.rcvd.code == 4001
            assert await _scalar(w, "SELECT count(*) FROM conversation_messages WHERE content = 'M AFTER the removal'") == 0
    finally:
        await _close(engine, w)


async def test_01c_an_idle_socket_of_a_removed_person_is_closed_by_the_timer(monkeypatch):
    """Nobody speaks at all: the 5 s timer (shortened here) closes the removed person's idle socket."""
    from app.routers import ws_chat

    monkeypatch.setattr(ws_chat, "_WS_ACCESS_RECHECK_SEC", 0.5)
    engine, w, owner_email, owner, owner_uid, org_x, org_y, m, tok_x, tok_y, agent_id, project = await _world_with_agent()
    try:
        async with _Server(w.app) as srv:
            async with websockets.connect(await _ws_url(srv.port, agent_id, tok_x)) as wm:
                await wm.send(json.dumps({"content": "hello"}))
                await asyncio.wait_for(wm.recv(), 10)
                assert (await _remove(w, owner_email, org_x, m)).status_code == 200
                with pytest.raises(websockets.exceptions.ConnectionClosed) as closed:
                    await asyncio.wait_for(wm.recv(), 10)
                assert closed.value.rcvd is not None and closed.value.rcvd.code == 4001
    finally:
        await _close(engine, w)


async def test_01e_a_removal_done_outside_the_app_process_still_closes_the_socket(monkeypatch):
    """Several backend instances: the socket sits in one process, the removal reaches another (or none of this app at all). Nothing in this process's memory (room, event) is told:
    the seat is ended by a plain UPDATE, and the idle socket still closes 4001 — because every socket asks the database itself."""
    from app.routers import ws_chat

    monkeypatch.setattr(ws_chat, "_WS_ACCESS_RECHECK_SEC", 0.5)
    engine, w, owner_email, owner, owner_uid, org_x, org_y, m, tok_x, tok_y, agent_id, project = await _world_with_agent()
    try:
        async with _Server(w.app) as srv:
            async with websockets.connect(await _ws_url(srv.port, agent_id, tok_x)) as wm:
                await wm.send(json.dumps({"content": "hello"}))
                await asyncio.wait_for(wm.recv(), 10)
                await w.sql("UPDATE org_members SET deleted_at = now() WHERE org_id = :o AND user_id = :u", o=org_x, u=m)   # not through the API
                with pytest.raises(websockets.exceptions.ConnectionClosed) as closed:
                    await asyncio.wait_for(wm.recv(), 10)
                assert closed.value.rcvd is not None and closed.value.rcvd.code == 4001
    finally:
        await _close(engine, w)


async def test_01d_a_new_connection_of_a_removed_person_is_refused_and_keeps_nothing():
    engine, w, owner_email, owner, owner_uid, org_x, org_y, m, tok_x, tok_y, agent_id, project = await _world_with_agent()
    try:
        assert (await _remove(w, owner_email, org_x, m)).status_code == 200
        async with _Server(w.app) as srv:
            async with websockets.connect(await _ws_url(srv.port, agent_id, tok_x)) as wm:
                try:
                    await wm.send(json.dumps({"content": "M NEW connection after the removal"}))
                except websockets.exceptions.ConnectionClosed:
                    pass
                # the refusal: an error frame, then the socket closes 4003 (not a member of the agent's organization / project) — or 4001 when no identity is found at all
                frames, code = [], None
                try:
                    while True:
                        frames.append(await asyncio.wait_for(wm.recv(), 10))
                except websockets.exceptions.ConnectionClosed as e:
                    code = e.rcvd.code if e.rcvd is not None else None
                assert code in (4001, 4003), (code, frames)
                assert all("error" in json.loads(f) for f in frames), frames
        assert await _scalar(w, "SELECT count(*) FROM conversation_messages WHERE content = 'M NEW connection after the removal'") == 0
    finally:
        await _close(engine, w)


async def test_04_a_person_in_two_organizations_gets_the_identity_of_the_agents_organization():
    from app.routers.ws_chat import _authenticate

    engine, w = await _world()
    try:
        owner_email, org_x, org_y, m, m_email, tok_x, tok_y = await _two_organizations(w)   # M is placed in a project of BOTH organizations
        for _ in range(8):   # whichever row the database hands back first, the answer is the same
            in_x = await _authenticate(None, tok_x["access_token"], org_id=org_x)
            in_y = await _authenticate(None, tok_x["access_token"], org_id=org_y)
            assert in_x is not None and str(in_x.org_id) == str(org_x)
            assert in_y is not None and str(in_y.org_id) == str(org_y)
        # without an organization the pick is ordered (stable): the same answer every time
        picks = {str((await _authenticate(None, tok_x["access_token"])).org_id) for _ in range(8)}
        assert len(picks) == 1, picks
        # an organization the person is not in: no identity there
        assert await _authenticate(None, tok_x["access_token"], org_id=uuid.uuid4()) is None
    finally:
        await _close(engine, w)




async def test_05_a_person_whose_first_pick_is_another_organization_still_connects_to_the_agent_in_its_own():
    """The identity found without an organization can be the wrong one (a person in two organizations has a row per organization): the handler asks again IN THE AGENT'S organization.
    The wrong pick is forced here (the first, organization-less call answers the other organization's identity) so the cell does not depend on which uuid sorts first."""
    from app.routers import ws_chat

    engine, w, owner_email, owner, owner_uid, org_x, org_y, m, tok_x, tok_y, agent_id, project = await _world_with_agent()
    try:
        # M is placed in a project of org Y too (the world removed that for the cells above)
        await w.sql(
            "INSERT INTO project_access (id, project_id, org_member_id, member_id, permission) "
            "SELECT gen_random_uuid(), (SELECT id FROM projects WHERE org_id = :o LIMIT 1), om.id, om.id, 'granted' FROM org_members om WHERE om.org_id = :o AND om.user_id = :u",
            o=org_y, u=m,
        )
        real = ws_chat._authenticate

        async def wrong_first(api_key, token, org_id=None):
            return await real(api_key, token, org_id=org_y if org_id is None else org_id)

        ws_chat._authenticate = wrong_first
        try:
            async with _Server(w.app) as srv:
                async with websockets.connect(await _ws_url(srv.port, agent_id, tok_x)) as wm:
                    await wm.send(json.dumps({"content": "M from the right organization"}))
                    d = json.loads(await asyncio.wait_for(wm.recv(), 10))
                    assert d.get("content") == "M from the right organization", d
        finally:
            ws_chat._authenticate = real
    finally:
        await _close(engine, w)


async def test_06_an_agent_key_socket_is_never_asked_the_persons_seat_question():
    """The person's seat check is for a person's (JWT) socket only: an agent key's socket keeps its key recheck — even in the edge where the key's id cannot be read back, it is not
    asked about a seat it never had (an agent has no org_members row)."""
    from datetime import datetime, timezone
    from unittest import mock

    from fastapi import WebSocketDisconnect

    from app.routers import ws_chat

    agent_id = uuid.uuid4()
    caller = mock.Mock(id=agent_id, org_id=uuid.uuid4(), user_id=None)
    agent = mock.Mock(org_id=caller.org_id, project_id=uuid.uuid4())
    saved: list[str] = []

    class _Session:
        async def __aenter__(self):
            return self

        async def __aexit__(self, *a):
            return False

        async def execute(self, *_a, **_k):
            return mock.Mock(scalar_one_or_none=lambda: agent)

        def add(self, msg):
            saved.append(msg.content)

        async def commit(self):
            pass

        async def refresh(self, msg):
            msg.id, msg.created_at = uuid.uuid4(), datetime.now(timezone.utc)

    class _Socket:
        def __init__(self, incoming):
            self.incoming, self.sent, self.closed = list(incoming), [], None

        async def accept(self):
            pass

        async def receive_text(self):
            if not self.incoming:
                raise WebSocketDisconnect()
            return self.incoming.pop(0)

        async def send_text(self, t):
            self.sent.append(t)

        async def close(self, code=1000, reason=None):
            self.closed = code

    asked = mock.AsyncMock(return_value="seat_ended")
    ws = _Socket([json.dumps({"content": "answer", "conversation_id": str(uuid.uuid4())})])
    with mock.patch.object(ws_chat, "_authenticate", mock.AsyncMock(return_value=caller)), \
            mock.patch.object(ws_chat, "async_session_factory", lambda: _Session()), \
            mock.patch.object(ws_chat, "_agent_answer_target", mock.AsyncMock(return_value=(uuid.uuid4(), None))), \
            mock.patch.object(ws_chat, "socket_can_read_conversation", mock.AsyncMock(return_value=True)), \
            mock.patch.object(ws_chat, "resolve_member_display_name", mock.AsyncMock(return_value="A")), \
            mock.patch.object(ws_chat, "_api_key_id", mock.AsyncMock(return_value=None)), \
            mock.patch("app.services.stream_access.person_seat_revoked_db", asked), \
            mock.patch.object(ws_chat, "_broadcast", mock.AsyncMock()):
        await ws_chat.ws_chat_hub(ws, agent_id, api_key="sk_live_" + "a" * 8, token=None)
    asked.assert_not_called()
    assert ws.closed is None and saved == ["answer"], (ws.closed, saved)
