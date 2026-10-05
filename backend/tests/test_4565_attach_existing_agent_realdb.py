"""story #4565 — an agent the organization already has, attached to a desktop by a setup (real HTTP · migrated PG).

AC1 the confirmation takes `{role, agent_id}`: no new member, the plan's agent count unchanged · AC2 its old keys are revoked in
the exchange (one agent, one place) and connections already open with them end (Qadir ①: /events/stream · /ws/chat) · two
exchanges attaching the same agent leave one live key (Qadir ②) · another live setup lets go of it (Qadir ③) · «disconnect»
never stops an attached agent · AC4 refusals: another org's agent and an unknown id read the same, a runtime the desktop
cannot run, not in the project, the same agent twice, a person who is not an owner/admin. The candidates list for the page.
"""
from __future__ import annotations

import asyncio
import hashlib
import secrets
import uuid

import pytest

from tests.test_4424_desktop_setup_realdb import (  # noqa: F401 — fixtures used by name
    EXISTING,
    ORG,
    ORG2,
    OWNER,
    OWNER_TM,
    PLAIN,
    PROJ,
    RECIPE,
    _StreamRequest,
    _addresses,
    _client,
    _code,
    _confirm,
    _dispose_global_engine_after_test,
    _exchange,
    _frames_until_end,
    _person,
    _quiet_stream_side_effects,
    _sql,
    anyio_backend,
    world,
)

OTHER_ORG_AGENT = uuid.UUID("d4565000-0000-0000-0000-000000000001")
NO_RUNTIME = uuid.UUID("d4565000-0000-0000-0000-000000000002")
NOT_IN_PROJECT = uuid.UUID("d4565000-0000-0000-0000-000000000003")
INACTIVE = uuid.UUID("d4565000-0000-0000-0000-000000000004")


def _attach(agent_id: uuid.UUID = EXISTING, role: str = "Writer") -> dict:
    other = "Reviewer" if role == "Writer" else "Writer"
    return {"project_id": str(PROJ), "recipe_id": str(RECIPE), "roles": [{"role": role, "agent_id": str(agent_id)}, {"role": other, "runtime": "codex"}]}


async def _plain_key(member: uuid.UUID) -> str:
    """A live agent key whose plaintext the test holds (the old launcher's)."""
    from app.core.security import hash_token

    plain = "sk_live_" + secrets.token_urlsafe(24)
    await _sql(
        "INSERT INTO agent_api_keys (id,team_member_id,member_id,key_prefix,key_hash,scope) VALUES "
        f"(gen_random_uuid(),'{member}','{member}','{plain[:12]}','{hash_token(plain)}',ARRAY['core'])"
    )
    return plain


async def _live_keys(member: uuid.UUID) -> int:
    return (await _sql(fetch=f"SELECT count(*) FROM agent_api_keys WHERE team_member_id='{member}' AND revoked_at IS NULL"))[0][0]


@pytest.fixture
async def attachable(world):
    """EXISTING on Claude Code · in the project (its anchor grant) · plus agents that may not be attached."""
    await _sql(
        f"UPDATE members SET runtime_type='claude-code' WHERE id='{EXISTING}'",
        f"INSERT INTO project_access (id,project_id,member_id,permission) VALUES (gen_random_uuid(),'{PROJ}','{EXISTING}','granted')",
        f"INSERT INTO members (id,org_id,user_id,type,name,is_active,runtime_type) VALUES "
        f"('{OTHER_ORG_AGENT}','{ORG2}',NULL,'agent','Elsewhere',true,'claude-code'),"
        f"('{NO_RUNTIME}','{ORG}',NULL,'agent','NoRuntime',true,NULL),"
        f"('{NOT_IN_PROJECT}','{ORG}',NULL,'agent','Outside',true,'codex'),"
        f"('{INACTIVE}','{ORG}',NULL,'agent','Stopped',false,'claude-code')",
        f"INSERT INTO project_access (id,project_id,member_id,permission) VALUES (gen_random_uuid(),'{PROJ}','{NO_RUNTIME}','granted')",
    )
    yield


@pytest.mark.anyio
async def test_attach_makes_no_member_and_moves_the_key(attachable):
    old = await _plain_key(EXISTING)
    agents_before = (await _sql(fetch=f"SELECT count(*) FROM members WHERE org_id='{ORG}' AND type='agent'"))[0][0]
    async with _client() as c:
        assert (await c.get("/api/v2/auth/me", headers={"Authorization": f"Bearer {old}"})).status_code != 401  # the old key works
        code, verifier = await _code(c, "d4424 attach")
        r = await _confirm(c, code, body=_attach())
        assert r.status_code == 200, r.text
        writer = next(m for m in r.json()["members"] if m["stage"] == "writer")
        assert (writer["member_id"], writer["kind"]) == (str(EXISTING), "agent")
        # one new agent (Reviewer) — none for the attached one
        assert (await _sql(fetch=f"SELECT count(*) FROM members WHERE org_id='{ORG}' AND type='agent'"))[0][0] == agents_before + 1
        assert await _live_keys(EXISTING) == 2  # nothing revoked at the confirmation

        r = await _exchange(c, code, verifier)
        assert r.status_code == 200, r.text
        got = {a["member_id"]: a for a in r.json()["agents"]}
        mine = got[str(EXISTING)]
        assert (mine["existing"], mine["name"], mine["runtime"]) == (True, "Existing", "claude")
        assert all("existing" not in a for k, a in got.items() if k != str(EXISTING))  # the new agent's shape as before
        assert "workdir" not in str(mine)  # the server names no folder for it
        # one agent, one place: only the new key lives
        assert await _live_keys(EXISTING) == 1
        assert (await c.get("/api/v2/auth/me", headers={"Authorization": f"Bearer {old}"})).status_code == 401
        assert (await c.get("/api/v2/auth/me", headers={"Authorization": f"Bearer {mine['api_key']}"})).status_code == 200


@pytest.mark.anyio
async def test_refusals_read_the_same_for_another_org_and_nothing(attachable):
    async with _client() as c:
        code, _ = await _code(c, "d4424 refusals")
        for agent_id, want in (
            (OTHER_ORG_AGENT, (404, "agent_not_found")), (uuid.uuid4(), (404, "agent_not_found")),
            (NO_RUNTIME, (404, "agent_not_found")), (OWNER_TM, (404, "agent_not_found")), (INACTIVE, (404, "agent_not_found")), (NOT_IN_PROJECT, (422, "agent_not_in_project")),
        ):
            r = await _confirm(c, code, body=_attach(agent_id))
            assert (r.status_code, r.json()["error"]["code"]) == want, (agent_id, r.text)
        # the same agent for two roles · an agent id that is not one · both an agent and a runtime
        for roles in (
            [{"role": "Writer", "agent_id": str(EXISTING)}, {"role": "Reviewer", "agent_id": str(EXISTING)}],
            [{"role": "Writer", "agent_id": "not-a-uuid"}, {"role": "Reviewer", "runtime": "codex"}],
            [{"role": "Writer", "agent_id": str(EXISTING), "runtime": "claude"}, {"role": "Reviewer", "runtime": "codex"}],
        ):
            r = await _confirm(c, code, body={**_attach(), "roles": roles})
            assert (r.status_code, r.json()["error"]["code"]) == (422, "roles_invalid"), roles
        r = await _confirm(c, code, who=PLAIN, body=_attach())
        assert (r.status_code, r.json()["error"]["code"]) == (403, "not_org_admin")
    # nothing of the refused confirmations stays, and EXISTING's keys are untouched
    assert (await _sql(fetch=f"SELECT confirmed_at FROM desktop_setups WHERE device_name='d4424 refusals'"))[0][0] is None
    assert await _live_keys(EXISTING) == 1


@pytest.mark.anyio
async def test_disconnect_never_stops_an_attached_agent(attachable):
    async with _client() as c:
        code, verifier = await _code(c, "d4424 attach then disconnect")
        setup_id = (await _confirm(c, code, body=_attach())).json()["setup_id"]
        agents = (await _exchange(c, code, verifier)).json()["agents"]
        made = next(a["member_id"] for a in agents if a["member_id"] != str(EXISTING))
        assert (await c.delete(f"/api/v2/desktop/setups/{setup_id}", headers=_person(OWNER))).status_code == 200
    active = dict(await _sql(fetch=f"SELECT id::text, is_active FROM members WHERE id IN ('{EXISTING}','{made}')"))
    assert active == {str(EXISTING): True, made: False}
    assert await _live_keys(EXISTING) == 0  # this setup's key is revoked like the others


@pytest.mark.anyio
async def test_another_live_setup_lets_go_of_a_moved_agent(attachable):
    async with _client() as c:
        code_a, verifier_a = await _code(c, "d4424 first mac")
        setup_a = (await _confirm(c, code_a, body=_attach())).json()["setup_id"]
        assert (await _exchange(c, code_a, verifier_a)).status_code == 200
        code_b, verifier_b = await _code(c, "d4424 second mac")
        assert (await _confirm(c, code_b, body=_attach())).status_code == 200
        assert (await _exchange(c, code_b, verifier_b)).status_code == 200
    members_a = (await _sql(fetch=f"SELECT members FROM desktop_setups WHERE id='{setup_a}'"))[0][0]
    assert all(m["member_id"] != str(EXISTING) for m in members_a)  # the first mac's relay no longer has it
    assert any(m["kind"] == "agent" for m in members_a)  # its own new agent stays
    assert await _live_keys(EXISTING) == 1
    # «disconnect» of the first mac now leaves it alone
    async with _client() as c:
        assert (await c.delete(f"/api/v2/desktop/setups/{setup_a}", headers=_person(OWNER))).status_code == 200
    assert (await _sql(fetch=f"SELECT is_active FROM members WHERE id='{EXISTING}'"))[0][0] is True
    assert await _live_keys(EXISTING) == 1


@pytest.mark.anyio
async def test_two_exchanges_at_once_leave_one_live_key(attachable):
    async with _client() as c:
        pairs = []
        for device in ("d4424 race a", "d4424 race b"):
            code, verifier = await _code(c, device)
            assert (await _confirm(c, code, body=_attach())).status_code == 200
            pairs.append((code, verifier))

    async def one(code, verifier):
        async with _client() as c:  # its own connection — the two transactions really overlap
            return await _exchange(c, code, verifier)

    results = await asyncio.gather(*(one(c, v) for c, v in pairs))
    assert [r.status_code for r in results] == [200, 200]
    assert await _live_keys(EXISTING) == 1


@pytest.mark.anyio
async def test_the_candidates_list(attachable):
    await _plain_key(EXISTING)
    await _sql(f"UPDATE agent_api_keys SET last_used_at = now() - interval '5 minutes' WHERE team_member_id='{EXISTING}'")
    async with _client() as c:
        r = await c.get(f"/api/v2/desktop/setup/agents?project_id={PROJ}", headers=_person(OWNER))
        assert r.status_code == 200, r.text
        rows = {a["id"]: a for a in r.json()["agents"]}
        # not another org's · not one without a desktop runtime · not an inactive one; one outside the project comes, marked
        assert set(rows) == {str(EXISTING), str(NOT_IN_PROJECT)}
        assert (rows[str(NOT_IN_PROJECT)]["in_project"], rows[str(EXISTING)]["in_project"]) == (False, True)
        e = rows[str(EXISTING)]
        assert (e["name"], e["runtime"], e["live_keys"]) == ("Existing", "claude", 2)
        assert e["last_used_at"] is not None
        assert "key" not in str({k: v for k, v in e.items() if k != "live_keys"})
        r = await c.get(f"/api/v2/desktop/setup/agents?project_id={PROJ}", headers=_person(PLAIN))
        assert (r.status_code, r.json()["error"]["code"]) == (403, "not_org_admin")


@pytest.mark.anyio
async def test_an_open_events_stream_of_the_old_key_ends_at_the_move(attachable, monkeypatch):
    """Qadir ① — the old launcher's /events/stream: open, then the agent is moved → access_revoked within a tick or two."""
    import app.routers.events as ev
    from app.core import shutdown as shutdown_module
    from app.dependencies.auth import AuthContext

    _quiet_stream_side_effects(monkeypatch)
    monkeypatch.setattr(ev, "_SSE_HEARTBEAT_TIMEOUT", 0.3)
    old = await _plain_key(EXISTING)
    from app.core.security import hash_token

    key_id = (await _sql(fetch=f"SELECT id FROM agent_api_keys WHERE key_hash='{hash_token(old)}'"))[0][0]
    auth = AuthContext(user_id=str(EXISTING), email=None, claims={"app_metadata": {"api_key_id": str(key_id), "org_id": str(ORG)}})
    resp = await ev.agent_event_stream(_StreamRequest(), member_id=None, auth=auth, org_id=ORG, since_timestamp=None, last_event_id=None)
    agen = resp.body_iterator
    try:
        assert "event: heartbeat" in await agen.__anext__()
        # still allowed before the move (asked directly: a timed-out read would end the generator — test_4424's note)
        from app.services.stream_access import key_access_revoked

        assert await key_access_revoked(key_id, EXISTING, agent_only=False) is None
        async with _client() as c:
            code, verifier = await _code(c, "d4424 move while streaming")
            assert (await _confirm(c, code, body=_attach())).status_code == 200
            assert (await _exchange(c, code, verifier)).status_code == 200
        frames, ended = await _frames_until_end(agen, 3.0)
        assert ended, f"the old key's stream must end within a tick or two: {frames}"
        assert any(f.startswith("event: access_revoked") and "key_revoked" in f for f in frames), frames
    finally:
        await agen.aclose()
        ev._agent_connections.clear()
        shutdown_module.reset_shutdown_event()


class _FakeSocket:
    """Just enough of a WebSocket for ws_chat_hub: what it receives is queued by the test; closes are recorded."""

    def __init__(self) -> None:
        self.inbox: asyncio.Queue[str | None] = asyncio.Queue()
        self.closed: int | None = None
        self.sent: list[str] = []

    async def accept(self) -> None:
        return None

    async def close(self, code: int = 1000, reason: str | None = None) -> None:
        if self.closed is None:
            self.closed = code
            await self.inbox.put(None)

    async def send_text(self, text: str) -> None:
        self.sent.append(text)

    async def receive_text(self) -> str:
        from fastapi import WebSocketDisconnect

        item = await self.inbox.get()
        if item is None:
            raise WebSocketDisconnect(code=self.closed or 1000)
        return item


@pytest.mark.anyio
async def test_an_open_chat_socket_of_the_old_key_closes_and_keeps_nothing_after(attachable, monkeypatch):
    """Qadir ① — /ws/chat checked the key once at connect: now a revoked key closes it (4001) while it only listens, and a
    message it sends after the move is never kept."""
    import app.routers.ws_chat as ws

    monkeypatch.setattr(ws, "_WS_ACCESS_RECHECK_SEC", 0.2)
    old = await _plain_key(EXISTING)
    # the socket talks to another agent of the org (a DM room) — the new one the setup makes below is not needed for that
    peer = uuid.UUID("d4565000-0000-0000-0000-000000000009")
    await _sql(
        f"INSERT INTO members (id,org_id,user_id,type,name,is_active,runtime_type) VALUES ('{peer}','{ORG}',NULL,'agent','Peer',true,'codex')",
        f"INSERT INTO project_access (id,project_id,member_id,permission) VALUES (gen_random_uuid(),'{PROJ}','{peer}','granted')",
    )
    sock = _FakeSocket()
    hub = asyncio.create_task(ws.ws_chat_hub(sock, agent_id=peer, api_key=old, token=None))
    try:
        await sock.inbox.put("before the move")
        for _ in range(50):
            if (await _sql(fetch=f"SELECT count(*) FROM conversation_messages WHERE sender_id='{EXISTING}'"))[0][0] == 1:
                break
            await asyncio.sleep(0.05)
        assert sock.closed is None
        async with _client() as c:
            code, verifier = await _code(c, "d4424 move while chatting")
            assert (await _confirm(c, code, body=_attach())).status_code == 200
            assert (await _exchange(c, code, verifier)).status_code == 200
        await asyncio.wait_for(hub, timeout=3.0)
        assert sock.closed == 4001
    finally:
        if not hub.done():
            hub.cancel()
    # a message that would come after is never kept (the socket is gone); the one before stays
    assert (await _sql(fetch=f"SELECT count(*) FROM conversation_messages WHERE sender_id='{EXISTING}'"))[0][0] == 1


@pytest.mark.anyio
async def test_a_message_sent_right_after_the_move_is_refused_before_the_timer(attachable, monkeypatch):
    """The per-message check: the timer is long here, so only the check before keeping a message can close the socket."""
    import app.routers.ws_chat as ws

    monkeypatch.setattr(ws, "_WS_ACCESS_RECHECK_SEC", 60.0)
    old = await _plain_key(EXISTING)
    peer = uuid.UUID("d4565000-0000-0000-0000-00000000000a")
    await _sql(
        f"INSERT INTO members (id,org_id,user_id,type,name,is_active,runtime_type) VALUES ('{peer}','{ORG}',NULL,'agent','Peer2',true,'codex')",
        f"INSERT INTO project_access (id,project_id,member_id,permission) VALUES (gen_random_uuid(),'{PROJ}','{peer}','granted')",
    )
    sock = _FakeSocket()
    hub = asyncio.create_task(ws.ws_chat_hub(sock, agent_id=peer, api_key=old, token=None))
    try:
        await asyncio.sleep(0.2)
        async with _client() as c:
            code, verifier = await _code(c, "d4424 move then send")
            assert (await _confirm(c, code, body=_attach())).status_code == 200
            assert (await _exchange(c, code, verifier)).status_code == 200
        await sock.inbox.put("after the move")
        await asyncio.wait_for(hub, timeout=3.0)
        assert sock.closed == 4001
    finally:
        if not hub.done():
            hub.cancel()
    assert (await _sql(fetch=f"SELECT count(*) FROM conversation_messages WHERE sender_id='{EXISTING}'"))[0][0] == 0


@pytest.mark.anyio
async def test_the_one_lock_order_agents_then_setups_by_id(attachable):
    """PO 02:51Z — every path that locks an agent and setups takes them in one order: the agent member rows (by id), then
    the setup rows (by id). The exchange of an attached agent and «disconnect» are watched at the SQL they send: flipping the
    order (a setup row before the member row) turns this red."""
    from sqlalchemy import event

    from app.core.database import engine

    seen: list[str] = []

    def watch(conn, cursor, statement, parameters, context, executemany):
        if "FOR UPDATE" in statement:
            table = "members" if "FROM members" in statement else "desktop_setups" if "FROM desktop_setups" in statement else "other"
            seen.append(table + (" ordered" if "ORDER BY" in statement else ""))

    async with _client() as c:
        code_a, verifier_a = await _code(c, "d4424 lock a")
        setup_a = (await _confirm(c, code_a, body=_attach())).json()["setup_id"]
        assert (await _exchange(c, code_a, verifier_a)).status_code == 200
        code_b, verifier_b = await _code(c, "d4424 lock b")
        assert (await _confirm(c, code_b, body=_attach())).status_code == 200
        event.listen(engine.sync_engine, "before_cursor_execute", watch)
        try:
            assert (await _exchange(c, code_b, verifier_b)).status_code == 200
            exchange_locks = list(seen)
            seen.clear()
            assert (await c.delete(f"/api/v2/desktop/setups/{setup_a}", headers=_person(OWNER))).status_code == 200
            disconnect_locks = list(seen)
        finally:
            event.remove(engine.sync_engine, "before_cursor_execute", watch)
    assert exchange_locks == ["members ordered", "desktop_setups ordered"], exchange_locks
    assert disconnect_locks == ["members ordered", "desktop_setups ordered"], disconnect_locks


@pytest.mark.anyio
async def test_the_same_id_from_another_org_is_agent_not_found(attachable):
    """PO 04:37Z — «not in this project» is said only inside the agent's own org: the same id asked from another org reads as
    no agent at all (whether it exists there never shows)."""
    from app.core.database import async_session_factory
    from app.services.desktop_setup import DesktopSetupError, _attachable_runtime

    async with async_session_factory() as db:
        for agent in (EXISTING, NOT_IN_PROJECT):
            with pytest.raises(DesktopSetupError) as e:
                await _attachable_runtime(db, org_id=ORG2, project_id=PROJ, agent_id=agent)
            assert e.value.code == "agent_not_found", agent
        # and inside its own org the outside one says what to do
        with pytest.raises(DesktopSetupError) as e:
            await _attachable_runtime(db, org_id=ORG, project_id=PROJ, agent_id=NOT_IN_PROJECT)
        assert e.value.code == "agent_not_in_project"
