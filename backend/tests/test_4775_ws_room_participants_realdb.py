"""story #4775 — the agent's WebSocket room is per agent, so a line of one person's DM with the agent went to every other socket of the room.

Measured by Kadir (develop 99f37db70 · real PG · real WebSocket · throw-away data): two live people A · B of the same organization connect to the same
agent X; A sends «A-PRIVATE» and it arrives on B's socket (REST shows B a 404/403 for A's DM — only the socket leaked). Also: the agent answering
through its own socket was saved into «the agent's OLDEST DM» (anyone's) and broadcast to the whole room; the connect gate was «same organization»
alone (a member with no access to the agent's project connected and sent).

These tests are that measurement as code. Real PG (migrated DB · ALEMBIC_DATABASE_URL) and a real WebSocket through Starlette's TestClient (the router
opens its own sessions through `async_session_factory`; it is patched with a NullPool factory so the TestClient's loop can use it).
"""
from __future__ import annotations

import asyncio
import json
import os
import uuid

import pytest
from sqlalchemy import text
from sqlalchemy.ext.asyncio import async_sessionmaker, create_async_engine
from sqlalchemy.pool import NullPool

_RAW = os.environ.get("ALEMBIC_DATABASE_URL") or os.environ.get("PARITY_TEST_DATABASE_URL") or ""
_ASYNC = _RAW.replace("postgresql+psycopg2://", "postgresql+asyncpg://").replace("postgresql://", "postgresql+asyncpg://")

pytestmark = pytest.mark.skipif(not _RAW, reason="real-DB URL 미설정 — skip")

ORG = uuid.UUID("d4775c00-0000-0000-0000-000000000010")
UA = uuid.UUID("d4775c00-0000-0000-0000-000000000011")   # person A (project grant)
UB = uuid.UUID("d4775c00-0000-0000-0000-000000000012")   # person B (project grant)
UC = uuid.UUID("d4775c00-0000-0000-0000-000000000013")   # a member with NO access to the agent's project
UO = uuid.UUID("d4775c00-0000-0000-0000-000000000014")   # org owner (owner-floor: no grant, admin branch)
PROJ = uuid.UUID("d4775c00-0000-0000-0000-000000000015")
PROJ_LOW = uuid.UUID("d4775c00-0000-0000-0000-000000000005")  # a second project of the agent — the LOWEST id (the old default) — nobody else has a grant in it
MA = uuid.UUID("d4775c00-0000-0000-0000-000000000021")
MB = uuid.UUID("d4775c00-0000-0000-0000-000000000022")
AGENT = uuid.UUID("d4775c00-0000-0000-0000-000000000031")
AGENT_KEY = "sk_live_" + "d4775" + "0" * 40  # throw-away; its hash is the only thing stored


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
    f"DELETE FROM agent_api_keys WHERE team_member_id='{AGENT}'",
    f"DELETE FROM agent_project_profiles WHERE project_id IN ('{PROJ}','{PROJ_LOW}')",
    f"DELETE FROM project_access WHERE project_id IN ('{PROJ}','{PROJ_LOW}')",
    f"DELETE FROM members WHERE org_id='{ORG}'",
    f"DELETE FROM projects WHERE org_id='{ORG}'",
    f"DELETE FROM org_members WHERE org_id='{ORG}'",
    f"DELETE FROM users WHERE id IN ('{UA}','{UB}','{UC}','{UO}')",
    f"DELETE FROM organizations WHERE id='{ORG}'",
]


def _user(uid: uuid.UUID, tag: str) -> str:
    return (f"('{uid}','{tag}@d4775c.test','x','{tag}',true,true,0,false,0)")


@pytest.fixture
def world():
    from app.core.security import hash_token

    _run(_exec(*_CLEAN))
    _run(_exec(
        f"INSERT INTO organizations (id,name,slug,plan) VALUES ('{ORG}','O','d4775c-org','free')",
        "INSERT INTO users (id,email,hashed_password,display_name,is_active,email_verified,login_fail_count,totp_enabled,"
        f"totp_fail_count) VALUES {_user(UA, 'A')},{_user(UB, 'B')},{_user(UC, 'C')},{_user(UO, 'Owner')}",
        f"INSERT INTO projects (id,org_id,name,slug,violation_level) VALUES ('{PROJ}','{ORG}','P','d4775c-proj','warn')",
        f"INSERT INTO org_members (id,org_id,user_id,role) VALUES (gen_random_uuid(),'{ORG}','{UO}','owner')",
        f"INSERT INTO org_members (id,org_id,user_id,role) VALUES (gen_random_uuid(),'{ORG}','{UA}','member')",
        f"INSERT INTO org_members (id,org_id,user_id,role) VALUES (gen_random_uuid(),'{ORG}','{UB}','member')",
        f"INSERT INTO org_members (id,org_id,user_id,role) VALUES (gen_random_uuid(),'{ORG}','{UC}','member')",
        f"INSERT INTO members (id,org_id,user_id,type,name,is_active) VALUES ('{MA}','{ORG}','{UA}','human','A',true)",
        f"INSERT INTO members (id,org_id,user_id,type,name,is_active) VALUES ('{MB}','{ORG}','{UB}','human','B',true)",
        f"INSERT INTO members (id,org_id,user_id,type,name,is_active) VALUES ('{AGENT}','{ORG}',NULL,'agent','X',true)",
        f"INSERT INTO project_access (id,project_id,member_id,permission) VALUES (gen_random_uuid(),'{PROJ}','{MA}','granted'),"
        f"(gen_random_uuid(),'{PROJ}','{MB}','granted'),(gen_random_uuid(),'{PROJ}','{AGENT}','granted')",
        f"INSERT INTO agent_project_profiles (id,member_id,project_id) VALUES (gen_random_uuid(),'{AGENT}','{PROJ}')",
        "INSERT INTO agent_api_keys (id,team_member_id,member_id,key_prefix,key_hash) VALUES "
        f"(gen_random_uuid(),'{AGENT}','{AGENT}','sk_live_','{hash_token(AGENT_KEY)}')",
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


def _url_human(user_id: uuid.UUID) -> str:
    return f"/ws/chat/{AGENT}?token={_token(user_id)}"


def _url_agent() -> str:
    return f"/ws/chat/{AGENT}?api_key={AGENT_KEY}"


def _rt(ws, timeout: float = 8.0) -> str:
    """`_rt(ws)` with a bound: a socket that was supposed to hear something and does not fails the test in seconds
    (a bare receive blocks for minutes when a fix is reverted — a mutant that stopped a delivery used to hang the whole run)"""
    import concurrent.futures

    ex = concurrent.futures.ThreadPoolExecutor(max_workers=1)
    try:
        return ex.submit(ws.receive_text).result(timeout=timeout)
    except concurrent.futures.TimeoutError:
        raise AssertionError(f"nothing arrived on the socket within {timeout} s") from None
    finally:
        ex.shutdown(wait=False)


def _say(ws, content: str, **extra) -> None:
    ws.send_text(json.dumps({"content": content, **extra}))


def _recv_until(ws, content: str) -> list[dict]:
    """everything this socket hears up to and including its own `content` line (it is sent by this socket, so it comes back)"""
    got: list[dict] = []
    while True:
        m = json.loads(_rt(ws))
        got.append(m)
        if m.get("content") == content:
            return got


def _make_dm(client, user_id: uuid.UUID) -> None:
    """the person connects and says one line: their DM with the agent now exists and holds that line"""
    with client.websocket_connect(_url_human(user_id)) as w:
        _say(w, "hello")
        _recv_until(w, "hello")


def _dm_of(member: uuid.UUID) -> uuid.UUID:
    rows = _run(_exec(fetch=(
        "SELECT c.id FROM conversations c JOIN conversation_participants p1 ON p1.conversation_id = c.id AND p1.member_id = "
        f"'{member}' JOIN conversation_participants p2 ON p2.conversation_id = c.id AND p2.member_id = '{AGENT}' "
        f"WHERE c.org_id='{ORG}' AND c.type='dm' ORDER BY c.created_at"
    )))
    return rows[0][0]


def _saved_in(conv_id: uuid.UUID) -> list[str]:
    rows = _run(_exec(fetch=f"SELECT content FROM conversation_messages WHERE conversation_id='{conv_id}' ORDER BY created_at"))
    return [r[0] for r in rows]


# ── AC1 · AC2: a person's line goes to the people of that conversation only ───────────────────────────────────────────────────

def test_a_line_of_one_persons_dm_does_not_reach_another_person_on_the_same_agent(world, client):
    with client.websocket_connect(_url_human(UA)) as wa, client.websocket_connect(_url_human(UB)) as wb:
        _say(wa, "A-PRIVATE")
        mine = _recv_until(wa, "A-PRIVATE")
        assert mine[-1]["sender_id"] == str(MA)  # the sender is told its line was kept
        _say(wb, "B-1")
        b_heard = _recv_until(wb, "B-1")
        _say(wb, "B-2")
        b_heard += _recv_until(wb, "B-2")
        # and B's own lines do not reach A either
        _say(wa, "A-2")
        a_heard = _recv_until(wa, "A-2")
    assert "A-PRIVATE" not in [m["content"] for m in b_heard], "A's DM line reached B's socket"
    assert "B-1" not in [m["content"] for m in a_heard] and "B-2" not in [m["content"] for m in a_heard], "B's DM line reached A's socket"


def test_the_agents_own_socket_hears_the_dm_lines_it_is_a_participant_of(world, client):
    """the agent X is a participant of both DMs: it hears A's line and B's line (and nobody else's)"""
    with client.websocket_connect(_url_human(UA)) as wa, client.websocket_connect(_url_human(UB)) as wb, client.websocket_connect(_url_agent()) as wx:
        _say(wa, "A-to-X")
        _recv_until(wa, "A-to-X")
        _say(wb, "B-to-X")
        _recv_until(wb, "B-to-X")
        # X hears both, in its own order — read until both have shown
        heard: set[str] = set()
        while {"A-to-X", "B-to-X"} - heard:
            heard.add(json.loads(_rt(wx))["content"])
    assert {"A-to-X", "B-to-X"} <= heard


# ── AC3: the agent's answer goes to the conversation it points at, and only there ─────────────────────────────────────────────

def test_the_agents_answer_is_saved_in_the_conversation_it_names_and_heard_by_its_people_only(world, client):
    _make_dm(client, UA)  # A's DM with X now exists (it is the OLDEST DM of the agent)
    _make_dm(client, UB)  # B's DM exists second
    dm_a, dm_b = _dm_of(MA), _dm_of(MB)
    with client.websocket_connect(_url_human(UA)) as wa, client.websocket_connect(_url_human(UB)) as wb, client.websocket_connect(_url_agent()) as wx:
        _say(wx, "X-REPLY-TO-B", conversation_id=str(dm_b))
        b_heard = _recv_until(wb, "X-REPLY-TO-B")
        assert b_heard[-1]["conversation_id"] == str(dm_b)
        _say(wa, "A-1")
        a_heard = _recv_until(wa, "A-1")
    assert _saved_in(dm_b) == ["hello", "X-REPLY-TO-B"]
    assert "X-REPLY-TO-B" not in _saved_in(dm_a), "the agent's answer went to the agent's OLDEST DM"
    assert "X-REPLY-TO-B" not in [m["content"] for m in a_heard], "the agent's answer to B reached A's socket"


def test_an_agent_answer_without_a_conversation_is_refused_out_loud_when_the_agent_has_several_dms(world, client):
    _make_dm(client, UA)
    _make_dm(client, UB)
    dm_a, dm_b = _dm_of(MA), _dm_of(MB)
    with client.websocket_connect(_url_agent()) as wx:
        _say(wx, "WHERE-DOES-THIS-GO")
        err = json.loads(_rt(wx))
        assert err["error"]["code"] == "conversation_id_required"
        _say(wx, "STILL-OPEN", conversation_id=str(dm_a))  # the socket stays open and a named answer works
        ok = json.loads(_rt(wx))
        assert ok["content"] == "STILL-OPEN"
    assert _saved_in(dm_a) == ["hello", "STILL-OPEN"] and _saved_in(dm_b) == ["hello"]


def test_an_agent_answer_without_a_conversation_goes_to_its_only_dm(world, client):
    _make_dm(client, UA)
    dm_a = _dm_of(MA)
    with client.websocket_connect(_url_agent()) as wx:
        _say(wx, "ONLY-ONE")
        got = json.loads(_rt(wx))
    assert got["content"] == "ONLY-ONE" and got["conversation_id"] == str(dm_a)
    assert _saved_in(dm_a) == ["hello", "ONLY-ONE"]


def test_an_agent_cannot_answer_into_a_conversation_it_is_not_in(world, client):
    """a conversation of two other people (or one that does not exist) is «not found» to the agent — nothing is saved there"""
    other = uuid.uuid4()
    _run(_exec(
        f"INSERT INTO conversations (id,org_id,project_id,type,created_by) VALUES ('{other}','{ORG}','{PROJ}','dm','{MA}')",
        f"INSERT INTO conversation_participants (conversation_id,member_id) VALUES ('{other}','{MA}'),('{other}','{MB}')",
    ))
    with client.websocket_connect(_url_agent()) as wx:
        _say(wx, "NOT-MINE", conversation_id=str(other))
        assert json.loads(_rt(wx))["error"]["code"] == "conversation_not_found"
        _say(wx, "NOT-EITHER", conversation_id=str(uuid.uuid4()))
        assert json.loads(_rt(wx))["error"]["code"] == "conversation_not_found"
    assert _saved_in(other) == []


# ── AC4: the connect gate is the agent's project, not «same organization» alone ──────────────────────────────────────────────

def test_a_member_with_no_access_to_the_agents_project_is_refused_at_connect(world, client):
    with client.websocket_connect(_url_human(UC)) as wc:
        err = json.loads(_rt(wc))
        assert err == {"error": "forbidden"}
    rows = _run(_exec(fetch=f"SELECT count(*) FROM conversations WHERE org_id='{ORG}'"))
    assert rows[0][0] == 0  # refused before any DM was made for it
    import app.routers.ws_chat as ws_chat

    assert str(AGENT) not in ws_chat._rooms  # and it never sat in the agent's room (before, a refused socket was in the room until it was closed)
    assert ws_chat._idents == {}


def test_the_org_owner_with_no_grant_still_connects(world, client):
    """#2216 / #4418 stay: an owner-floor person reaches the agent through the admin branch of the same project-access rule"""
    with client.websocket_connect(_url_human(UO)) as wo:
        _say(wo, "owner-hello")
        assert _recv_until(wo, "owner-hello")[-1]["content"] == "owner-hello"


def test_a_new_dm_is_scoped_to_a_project_the_person_can_reach(world, client):
    """a multi-project agent whose LOWEST project A has no grant in: the DM A starts must be in the project A can reach (before, the default was the
    agent's lowest project — a DM in a project REST then refuses A: «403 Not a participant»)"""
    _run(_exec(
        f"INSERT INTO projects (id,org_id,name,slug,violation_level) VALUES ('{PROJ_LOW}','{ORG}','P0','d4775c-proj0','warn')",
        f"INSERT INTO agent_project_profiles (id,member_id,project_id) VALUES (gen_random_uuid(),'{AGENT}','{PROJ_LOW}')",
    ))
    with client.websocket_connect(_url_human(UA)) as wa:
        _say(wa, "hi")
        _recv_until(wa, "hi")
    rows = _run(_exec(fetch=f"SELECT project_id FROM conversations WHERE org_id='{ORG}' AND type='dm'"))
    assert [r[0] for r in rows] == [PROJ]


# ── the REST send path (`conversations.py` fans a saved line out to the agent's room) — same rule ───────────────────────────

def test_a_line_sent_over_rest_reaches_the_people_of_that_conversation_only(world, client):
    from app.dependencies.auth import AuthContext, get_current_user
    from app.main import app
    from tests.conftest import override_db_and_read

    Session = async_sessionmaker(create_async_engine(_ASYNC, poolclass=NullPool), expire_on_commit=False)

    async def _db():
        async with Session() as s:
            try:
                yield s
                await s.commit()
            except Exception:
                await s.rollback()
                raise

    async def _auth_a():
        return AuthContext(user_id=str(UA), email="A@d4775c.test", claims={"app_metadata": {"org_id": str(ORG)}})

    _make_dm(client, UA)
    _make_dm(client, UB)
    dm_a = _dm_of(MA)
    override_db_and_read(app, _db)
    app.dependency_overrides[get_current_user] = _auth_a
    try:
        with client.websocket_connect(_url_human(UA)) as wa, client.websocket_connect(_url_human(UB)) as wb, client.websocket_connect(_url_agent()) as wx:
            resp = client.post(f"/api/v2/conversations/{dm_a}/messages", json={"content": "rest-line"})
            assert resp.status_code == 201, resp.text
            assert _recv_until(wx, "rest-line")[-1]["conversation_id"] == str(dm_a)  # the agent (a participant) hears it
            assert _recv_until(wa, "rest-line")[-1]["content"] == "rest-line"  # and so does A's own socket
            _say(wb, "B-1")
            b_heard = _recv_until(wb, "B-1")
            _say(wb, "B-2")
            b_heard += _recv_until(wb, "B-2")
    finally:
        app.dependency_overrides.clear()
    assert "rest-line" not in [m["content"] for m in b_heard], "a line sent over REST into A's DM reached B's socket"


# ── the socket's judge IS REST's rule: same answer for the same person on the same conversation ───────────────────────────

def test_the_socket_judge_answers_like_rests_can_read_conversation(world, client):
    import app.routers.conversations as conv_router
    from app.dependencies.auth import AuthContext
    from app.services.conversation_auth import socket_can_read_conversation

    _make_dm(client, UA)
    _make_dm(client, UB)
    dm_a = _dm_of(MA)
    key_id = _run(_exec(fetch=f"SELECT id FROM agent_api_keys WHERE team_member_id='{AGENT}'"))[0][0]
    # (who, REST auth, the socket's identity)
    cases = {
        "A (a participant)": (AuthContext(user_id=str(UA), email="a@x", claims={"app_metadata": {"org_id": str(ORG)}}), MA, UA, False),
        "B (same agent, other DM)": (AuthContext(user_id=str(UB), email="b@x", claims={"app_metadata": {"org_id": str(ORG)}}), MB, UB, False),
        "the agent X by its key": (
            AuthContext(user_id=str(AGENT), email="x@x", claims={"app_metadata": {"org_id": str(ORG), "api_key_id": str(key_id)}}), AGENT, AGENT, True),
    }

    async def _both():
        eng = create_async_engine(_ASYNC, poolclass=NullPool)
        out = {}
        try:
            async with async_sessionmaker(eng, expire_on_commit=False)() as db:
                for who, (auth, member_id, access_uid, via_key) in cases.items():
                    rest = await conv_router._can_read_conversation(dm_a, db, auth, ORG)
                    sock = await socket_can_read_conversation(db, dm_a, ORG, member_id=member_id, access_user_id=access_uid, via_agent_key=via_key)
                    out[who] = (rest, sock)
                # grant-loss: A is still a participant of the DM row-wise, but A's project access is gone — REST refuses, so must the socket
                await db.execute(text(f"DELETE FROM project_access WHERE member_id='{MA}'"))
                await db.commit()
                auth, member_id, access_uid, via_key = cases["A (a participant)"]
                rest = await conv_router._can_read_conversation(dm_a, db, auth, ORG)
                sock = await socket_can_read_conversation(db, dm_a, ORG, member_id=member_id, access_user_id=access_uid, via_agent_key=via_key)
                out["A after A's project grant is revoked"] = (rest, sock)
        finally:
            await eng.dispose()
        return out

    got = _run(_both())
    assert got == {
        "A (a participant)": (True, True), "B (same agent, other DM)": (False, False), "the agent X by its key": (True, True),
        "A after A's project grant is revoked": (False, False),
    }, got


def test_the_channel_deliver_route_has_the_same_project_gate(world, client, monkeypatch):
    """`/channel/deliver` made a DM line for anyone in the organization (same-org was its only gate): now a member with no path to the
    agent's project is refused — nothing is saved — and the owner (admin branch) and a person with a grant still deliver."""
    monkeypatch.setattr(
        "app.routers.channel.async_session_factory",
        async_sessionmaker(create_async_engine(_ASYNC, poolclass=NullPool), expire_on_commit=False),
    )
    refused = client.post(f"/api/v2/channel/deliver?token={_token(UC)}", json={"agent_id": str(AGENT), "content": "from-C"})
    assert refused.status_code == 403
    allowed = client.post(f"/api/v2/channel/deliver?token={_token(UA)}", json={"agent_id": str(AGENT), "content": "from-A"})
    assert allowed.status_code == 204
    rows = _run(_exec(fetch=f"SELECT m.content FROM conversation_messages m JOIN conversations c ON c.id=m.conversation_id WHERE c.org_id='{ORG}'"))
    assert [r[0] for r in rows] == ["from-A"]


# ── codex round 1: the checks that must hold LIVE, and the other doors ──────────────────────────────────────────────────────

def test_a_person_whose_project_access_is_removed_after_connecting_is_not_kept(world, client):
    """the connect gate is not the only moment: every line is judged for its sender too — REST would 403 this person now"""
    _make_dm(client, UA)
    dm_a = _dm_of(MA)
    with client.websocket_connect(_url_human(UA)) as wa:
        _say(wa, "before-revoke")
        assert _recv_until(wa, "before-revoke")[-1]["content"] == "before-revoke"
        _run(_exec(f"DELETE FROM project_access WHERE member_id='{MA}'"))
        _say(wa, "AFTER-REVOKE")
        got = json.loads(_rt(wa))
        assert got == {"error": "forbidden"}
    assert "AFTER-REVOKE" not in _saved_in(dm_a)


def test_the_channel_route_scopes_a_new_dm_to_a_project_the_caller_reaches(world, client, monkeypatch):
    """`/channel/deliver` made the DM in the agent's LOWEST project — a project the caller may not reach (REST then refuses the caller its own DM)"""
    monkeypatch.setattr(
        "app.routers.channel.async_session_factory",
        async_sessionmaker(create_async_engine(_ASYNC, poolclass=NullPool), expire_on_commit=False),
    )
    _run(_exec(
        f"INSERT INTO projects (id,org_id,name,slug,violation_level) VALUES ('{PROJ_LOW}','{ORG}','P0','d4775c-proj0','warn')",
        f"INSERT INTO agent_project_profiles (id,member_id,project_id) VALUES (gen_random_uuid(),'{AGENT}','{PROJ_LOW}')",
    ))
    resp = client.post(f"/api/v2/channel/deliver?token={_token(UA)}", json={"agent_id": str(AGENT), "content": "via-route"})
    assert resp.status_code == 204, resp.text
    rows = _run(_exec(fetch=f"SELECT project_id FROM conversations WHERE org_id='{ORG}' AND type='dm'"))
    assert [r[0] for r in rows] == [PROJ]


def test_a_person_with_an_api_key_connects_and_hears_their_own_dm(world, client):
    """a person's key (story 1940) is the person: the project rule takes their user id (not an agent's member id) — they still connect and
    hear the lines of their own DM"""
    from app.core.security import hash_token

    human_key = "sk_live_" + "h4775" + "0" * 40
    _run(_exec(
        "INSERT INTO agent_api_keys (id,team_member_id,member_id,key_prefix,key_hash) VALUES "
        f"(gen_random_uuid(),'{MA}','{MA}','sk_live_','{hash_token(human_key)}')",
    ))
    try:
        with client.websocket_connect(f"/ws/chat/{AGENT}?api_key={human_key}") as w:
            _say(w, "by-key")
            assert _recv_until(w, "by-key")[-1]["content"] == "by-key"
    finally:
        _run(_exec(f"DELETE FROM agent_api_keys WHERE team_member_id='{MA}'"))


def test_a_group_conversation_line_over_rest_reaches_its_participants_only(world, client):
    """the REST fan-out also carries group conversations the agent is in: its participants hear it, the other people of the room do not"""
    from app.dependencies.auth import AuthContext, get_current_user
    from app.main import app
    from tests.conftest import override_db_and_read

    Session = async_sessionmaker(create_async_engine(_ASYNC, poolclass=NullPool), expire_on_commit=False)

    async def _db():
        async with Session() as s:
            try:
                yield s
                await s.commit()
            except Exception:
                await s.rollback()
                raise

    async def _auth_a():
        return AuthContext(user_id=str(UA), email="A@d4775c.test", claims={"app_metadata": {"org_id": str(ORG)}})

    group = uuid.uuid4()
    _run(_exec(
        f"INSERT INTO conversations (id,org_id,project_id,type,title,created_by) VALUES ('{group}','{ORG}','{PROJ}','group','G','{MA}')",
        f"INSERT INTO conversation_participants (conversation_id,member_id) VALUES ('{group}','{MA}'),('{group}','{MB}'),('{group}','{AGENT}')",
    ))
    _make_dm(client, UO)  # the org owner is in the room too, but not in the group
    override_db_and_read(app, _db)
    app.dependency_overrides[get_current_user] = _auth_a
    try:
        with client.websocket_connect(_url_human(UB)) as wb, client.websocket_connect(_url_human(UO)) as wo:
            resp = client.post(f"/api/v2/conversations/{group}/messages", json={"content": "group-line"})
            assert resp.status_code == 201, resp.text
            assert _recv_until(wb, "group-line")[-1]["conversation_id"] == str(group)  # B is in the group
            _say(wo, "owner-1")
            owner_heard = _recv_until(wo, "owner-1")
            _say(wo, "owner-2")
            owner_heard += _recv_until(wo, "owner-2")
    finally:
        app.dependency_overrides.clear()
    assert "group-line" not in [m["content"] for m in owner_heard], "a group line reached a person who is not in the group"


# ── Kadir's lens (PR 5225): «cannot tell» is «no» — the property this story stands on ─────────────────────────────────────────

def test_the_judge_fails_closed_never_open(world, client, monkeypatch):
    """`socket_can_read_conversation` answers False when it cannot tell: no such conversation · the project rule blows up · the database
    itself fails. (A judge that answers True on an exception sends a person's line to everyone in the room.)"""
    from app.services import project_auth
    from app.services.conversation_auth import socket_can_read_conversation

    _make_dm(client, UA)
    dm_a = _dm_of(MA)

    class _BrokenDb:
        async def execute(self, *a, **k):
            raise RuntimeError("database failure")

    async def _ask(db, conversation_id):
        return await socket_can_read_conversation(db, conversation_id, ORG, member_id=MA, access_user_id=UA, via_agent_key=False)

    async def _run_cases():
        eng = create_async_engine(_ASYNC, poolclass=NullPool)
        out = {}
        try:
            async with async_sessionmaker(eng, expire_on_commit=False)() as db:
                out["control: a participant with access"] = await _ask(db, dm_a)
                out["no such conversation"] = await _ask(db, uuid.uuid4())

                async def _boom(*a, **k):
                    raise RuntimeError("project rule failure")

                monkeypatch.setattr(project_auth, "has_project_access", _boom)
                out["the project rule blows up"] = await _ask(db, dm_a)
                monkeypatch.undo()
                out["the database fails"] = await _ask(_BrokenDb(), dm_a)
        finally:
            await eng.dispose()
        return out

    assert _run(_run_cases()) == {
        "control: a participant with access": True, "no such conversation": False,
        "the project rule blows up": False, "the database fails": False,
    }


def test_a_judgment_that_blows_up_keeps_nothing_and_sends_nothing(world, client, monkeypatch):
    """A's line meets a project rule that raises: it is not saved, no other socket hears it, A's socket ends (4003)"""
    from app.services import project_auth

    _make_dm(client, UA)
    dm_a = _dm_of(MA)

    async def _boom(*a, **k):
        raise RuntimeError("project rule failure")

    with client.websocket_connect(_url_human(UA)) as wa, client.websocket_connect(_url_human(UO)) as wo, client.websocket_connect(_url_agent()) as wx:
        monkeypatch.setattr(project_auth, "has_project_access", _boom)
        _say(wa, "FAIL-CLOSED")
        assert json.loads(_rt(wa)) == {"error": "forbidden"}
        monkeypatch.undo()
        _say(wo, "owner-1")
        owner_heard = _recv_until(wo, "owner-1")
        _say(wx, "x-1", conversation_id=str(dm_a))
        agent_heard = _recv_until(wx, "x-1")
    assert "FAIL-CLOSED" not in [m["content"] for m in owner_heard + agent_heard], "a line whose judgment failed was sent to a socket"
    assert "FAIL-CLOSED" not in _saved_in(dm_a), "a line whose judgment failed was saved"


def test_a_socket_nobody_vouched_for_is_sent_nothing():
    """the belt: a socket in a room without a registered owner receives no conversation line (a registered one does)"""
    import app.routers.ws_chat as ws_chat

    got: dict[str, list[str]] = {"vouched": [], "stranger": []}

    class _Sock:
        def __init__(self, name):
            self.name = name

        async def send_text(self, payload):
            got[self.name].append(payload)

    vouched, stranger = _Sock("vouched"), _Sock("stranger")
    ident = ws_chat._SocketIdent(member_id=uuid.uuid4(), access_user_id=uuid.uuid4(), org_id=uuid.uuid4(), via_agent_key=False)

    async def _allow(db, conversation_id, org_id, **kw):
        return True

    class _Db:
        async def __aenter__(self):
            return None

        async def __aexit__(self, *a):
            return False

    ws_chat._rooms["room-4775"] = {vouched, stranger}
    ws_chat._idents[vouched] = ident
    orig_judge, orig_factory = ws_chat.socket_can_read_conversation, ws_chat.async_session_factory
    ws_chat.socket_can_read_conversation, ws_chat.async_session_factory = _allow, (lambda: _Db())
    try:
        _run(ws_chat._broadcast("room-4775", "line", conversation_id=uuid.uuid4()))
    finally:
        ws_chat.socket_can_read_conversation, ws_chat.async_session_factory = orig_judge, orig_factory
        ws_chat._rooms.pop("room-4775", None)
        ws_chat._idents.pop(vouched, None)
    assert got == {"vouched": ["line"], "stranger": []}
