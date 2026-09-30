"""story #4424 — desktop setup in one go, over real HTTP on a migrated PG (ALEMBIC_DATABASE_URL · DATABASE_URL).

A person's session is a real access token (+ X-Org-Id); the handed-out keys are used as real Bearer keys. Covers:
AC1 the exchange flow (pending · once · refusals) and who may confirm · AC2 nothing of a half-made confirm/exchange stays
(read again in a new session) · AC3 the keys cannot make agents or keys and carry no admin/destructive tool, and the
plaintext is nowhere in the DB or the logs · AC4 other agents' keys unchanged · AC5 disconnect revokes that setup's keys only
· AC6 the setup row records who · which device · how many.
"""
from __future__ import annotations

import base64
import hashlib
import json
import logging
import os
import secrets
import uuid

import pytest
from sqlalchemy import text
from sqlalchemy.ext.asyncio import async_sessionmaker, create_async_engine
from sqlalchemy.pool import NullPool

_RAW = os.environ.get("ALEMBIC_DATABASE_URL") or os.environ.get("PARITY_TEST_DATABASE_URL") or ""
_ASYNC = _RAW.replace("postgresql+psycopg2://", "postgresql+asyncpg://").replace("postgresql://", "postgresql+asyncpg://")

pytestmark = pytest.mark.skipif(not _RAW, reason="real-DB URL 미설정 — skip")

ORG = uuid.UUID("d4424000-0000-0000-0000-000000000010")
ORG2 = uuid.UUID("d4424000-0000-0000-0000-000000000020")
OWNER = uuid.UUID("d4424000-0000-0000-0000-000000000011")
PLAIN = uuid.UUID("d4424000-0000-0000-0000-000000000012")  # org member, not admin
OUTSIDER = uuid.UUID("d4424000-0000-0000-0000-000000000021")  # admin of another org
PROJ = uuid.UUID("d4424000-0000-0000-0000-000000000014")
OWNER_TM = uuid.UUID("d4424000-0000-0000-0000-000000000015")
EXISTING = uuid.UUID("d4424000-0000-0000-0000-000000000016")  # an agent that already runs somewhere
RECIPE = uuid.UUID("d4424000-0000-0000-0000-000000000017")
RECIPE_KEY = "org.d4424-org.desktop_recipe"

# writer · reviewer = agents; approver = a person (role_actor_kinds); publisher = a channel (left for later)
STAGES = {
    "writer": {"role": "Writer"},
    "reviewer": {"role": "Reviewer"},
    "approver": {"role": "Approver"},
    "publisher": {"role": "Publisher", "capability": {"kind": "publish", "target": "channel_connection"}},
}
KINDS = {"Approver": "human"}  # keyed by role, as events.py reads it
RECIPE_NAME = "Desktop recipe"
RECIPE2 = uuid.UUID("d4424000-0000-0000-0000-000000000018")  # the same stages, a person's stage first
RECIPE2_KEY = "org.d4424-org.person_first"


def _schema(order: list[str]) -> str:
    return json.dumps({"type": "object", "properties": {
        "stage": {"type": "string", "enum": order}, "work_item_type": {"type": "string"}, "work_item_id": {"type": "string"},
    }})


ROUTING = json.dumps({"escalation": {"kind": "server_derived", "target": "none"}, "broadcast": {"kind": "recipe_role_binding"}})


@pytest.fixture
def anyio_backend():
    return "asyncio"


@pytest.fixture(autouse=True)
def _addresses(monkeypatch):
    """The two addresses the exchange hands over (deployments set them; a test sets its own)."""
    monkeypatch.setenv("MCP_PUBLIC_URL", "https://mcp.d4424.test/mcp")
    monkeypatch.setenv("FASTAPI_URL", "https://api.d4424.test")


@pytest.fixture(autouse=True)
async def _dispose_global_engine_after_test():
    yield
    from app.core.database import engine as _global_engine

    await _global_engine.dispose()


async def _sql(*stmts: str, params: dict | None = None, fetch: str | None = None):
    eng = create_async_engine(_ASYNC, poolclass=NullPool)
    try:
        async with async_sessionmaker(eng)() as s:
            for st in stmts:
                await s.execute(text(st), params or {})
            rows = (await s.execute(text(fetch), params or {})).all() if fetch else None
            await s.commit()
            return rows
    finally:
        await eng.dispose()


_CLEAN = [
    f"DELETE FROM agent_run_tool_calls WHERE org_id IN ('{ORG}','{ORG2}')",
    "DELETE FROM onboarding_events WHERE session_id IN (SELECT id FROM desktop_setups WHERE device_name LIKE 'd4424%')",
    f"DELETE FROM agent_api_keys WHERE team_member_id IN (SELECT id FROM members WHERE org_id IN ('{ORG}','{ORG2}'))",
    f"DELETE FROM desktop_setups WHERE org_id IN ('{ORG}','{ORG2}') OR device_name LIKE 'd4424%'",
    f"DELETE FROM recipe_role_bindings WHERE org_id IN ('{ORG}','{ORG2}')",
    f"DELETE FROM conversation_messages WHERE conversation_id IN (SELECT id FROM conversations WHERE org_id IN ('{ORG}','{ORG2}'))",
    f"DELETE FROM conversation_participants WHERE conversation_id IN (SELECT id FROM conversations WHERE org_id IN ('{ORG}','{ORG2}'))",
    f"DELETE FROM conversations WHERE org_id IN ('{ORG}','{ORG2}')",
    f"DELETE FROM stories WHERE project_id='{PROJ}'",
    f"DELETE FROM event_definitions WHERE id IN ('{RECIPE}','{RECIPE2}')",
    f"DELETE FROM notification_preferences WHERE member_id IN (SELECT id FROM members WHERE org_id IN ('{ORG}','{ORG2}'))",
    f"DELETE FROM agent_message_allowlist WHERE agent_member_id IN (SELECT id FROM members WHERE org_id IN ('{ORG}','{ORG2}'))",
    f"DELETE FROM agent_project_profiles WHERE project_id='{PROJ}'",
    f"DELETE FROM project_access WHERE project_id='{PROJ}'",
    f"DELETE FROM members WHERE org_id IN ('{ORG}','{ORG2}')",
    f"DELETE FROM projects WHERE org_id IN ('{ORG}','{ORG2}')",
    f"DELETE FROM org_members WHERE org_id IN ('{ORG}','{ORG2}')",
    f"DELETE FROM users WHERE id IN ('{OWNER}','{PLAIN}','{OUTSIDER}')",
    f"DELETE FROM organizations WHERE id IN ('{ORG}','{ORG2}')",
]


@pytest.fixture
async def world():
    await _sql(*_CLEAN)
    await _sql(
        f"INSERT INTO organizations (id,name,slug,plan) VALUES ('{ORG}','O','d4424-org','free'),('{ORG2}','O2','d4424-org2','free')",
        "INSERT INTO users (id,email,hashed_password,display_name,is_active,email_verified,login_fail_count,totp_enabled,"
        "totp_fail_count) VALUES "
        f"('{OWNER}','owner@d4424.test','x','Owner',true,true,0,false,0),"
        f"('{PLAIN}','plain@d4424.test','x','Plain',true,true,0,false,0),"
        f"('{OUTSIDER}','out@d4424.test','x','Out',true,true,0,false,0)",
        f"INSERT INTO projects (id,org_id,name,slug,violation_level) VALUES ('{PROJ}','{ORG}','P','d4424-proj','warn')",
        # a person's members.id is their org_members.id (0075)
        f"INSERT INTO org_members (id,org_id,user_id,role) VALUES ('{OWNER_TM}','{ORG}','{OWNER}','owner'),"
        f"(gen_random_uuid(),'{ORG}','{PLAIN}','member'),(gen_random_uuid(),'{ORG2}','{OUTSIDER}','admin')",
        f"INSERT INTO members (id,org_id,user_id,type,name,is_active) VALUES ('{OWNER_TM}','{ORG}','{OWNER}','human','Owner',true)",
        f"INSERT INTO project_access (id,project_id,member_id,permission) VALUES (gen_random_uuid(),'{PROJ}','{OWNER_TM}','granted')",
        f"INSERT INTO members (id,org_id,user_id,type,name,is_active) VALUES ('{EXISTING}','{ORG}',NULL,'agent','Existing',true)",
        f"INSERT INTO agent_project_profiles (id,member_id,project_id) VALUES (gen_random_uuid(),'{EXISTING}','{PROJ}')",
        "INSERT INTO agent_api_keys (id,team_member_id,member_id,key_prefix,key_hash,scope) VALUES "
        f"(gen_random_uuid(),'{EXISTING}','{EXISTING}','sk_live_exist','{hashlib.sha256(b'existing').hexdigest()}',ARRAY['core'])",
        "INSERT INTO event_definitions (id,key,org_id,name,description,payload_schema,routing,block_template,stage_metadata,"
        "role_actor_kinds,enabled,version) VALUES "
        f"('{RECIPE}','{RECIPE_KEY}','{ORG}','{RECIPE_NAME}','d4424',CAST(:ps AS jsonb),CAST(:r AS jsonb),CAST(:bt AS jsonb),"
        "CAST(:sm AS jsonb),CAST(:rak AS jsonb),true,1),"
        f"('{RECIPE2}','{RECIPE2_KEY}','{ORG}','Person first','d4424',CAST(:ps2 AS jsonb),CAST(:r AS jsonb),CAST(:bt AS jsonb),"
        "CAST(:sm AS jsonb),CAST(:rak AS jsonb),true,1)",
        params={
            "ps": _schema(["writer", "reviewer", "approver", "publisher"]), "ps2": _schema(["approver", "writer", "reviewer", "publisher"]),
            "r": ROUTING, "bt": "{}", "sm": json.dumps(STAGES), "rak": json.dumps(KINDS),
        },
    )
    yield
    await _sql(*_CLEAN)


def _client():
    from httpx import ASGITransport, AsyncClient

    from app.main import app

    return AsyncClient(transport=ASGITransport(app=app, raise_app_exceptions=False), base_url="http://test")


def _person(user_id: uuid.UUID, org_id: uuid.UUID = ORG) -> dict:
    from app.core.security import create_access_token

    return {"Authorization": f"Bearer {create_access_token(user_id=str(user_id))}", "X-Org-Id": str(org_id)}


def _pkce() -> tuple[str, str]:
    verifier = base64.urlsafe_b64encode(secrets.token_bytes(32)).rstrip(b"=").decode()
    challenge = base64.urlsafe_b64encode(hashlib.sha256(verifier.encode()).digest()).rstrip(b"=").decode()
    return verifier, challenge


async def _code(c, device: str = "d4424 laptop") -> tuple[str, str]:
    verifier, challenge = _pkce()
    r = await c.post("/api/v2/desktop/setup-codes", json={"challenge": challenge, "device_name": device})
    assert r.status_code == 201, r.text
    assert r.headers["cache-control"] == "no-store"
    setup_id = r.json()["setup_id"]  # PO 08:31Z ② — the id the web's pre-confirm steps are keyed by
    assert (await _sql(fetch=f"SELECT device_name FROM desktop_setups WHERE id='{setup_id}'"))[0][0] == device
    EVENT_TOKENS[setup_id] = r.json()["event_token"]  # PO 12:21Z — the app's step events carry it
    return r.json()["code"], verifier


EVENT_TOKENS: dict[str, str] = {}


async def _app_event(c, setup_id: str, event: str, meta: dict | None = None, token: str | None = "own"):
    """A step event as the desktop app sends it: its setup's token in the header (token=None: none · a string: that one)."""
    headers = {}
    if token == "own":
        headers["X-Setup-Event-Token"] = EVENT_TOKENS[str(setup_id)]
    elif token is not None:
        headers["X-Setup-Event-Token"] = token
    return await c.post("/api/v2/onboarding/events", json={"event": event, "session_id": str(setup_id), "meta": meta or {}}, headers=headers)


_ROLES = {"project_id": str(PROJ), "recipe_id": str(RECIPE), "roles": [{"role": "Writer", "runtime": "claude"}, {"role": "Reviewer", "runtime": "codex"}]}


async def _confirm(c, code: str, who: uuid.UUID = OWNER, org: uuid.UUID = ORG, body: dict | None = None):
    return await c.post("/api/v2/desktop/setup-codes/confirm", json={**(body or _ROLES), "code": code}, headers=_person(who, org))


async def _exchange(c, code: str, verifier: str):
    return await c.post("/api/v2/desktop/setup-codes/exchange", json={"code": code, "verifier": verifier})


async def _counts() -> dict:
    rows = await _sql(fetch=(
        "SELECT "
        f"(SELECT count(*) FROM members WHERE org_id='{ORG}' AND type='agent'),"
        f"(SELECT count(*) FROM recipe_role_bindings WHERE org_id='{ORG}'),"
        f"(SELECT count(*) FROM agent_api_keys k JOIN members m ON m.id=k.team_member_id WHERE m.org_id='{ORG}'),"
        f"(SELECT count(*) FROM desktop_setups WHERE org_id='{ORG}')"
    ))
    agents, bindings, keys, setups = rows[0]
    return {"agents": agents, "bindings": bindings, "keys": keys, "confirmed_setups": setups}


# ─── AC1 ───────────────────────────────────────────────────────────────────────


@pytest.mark.anyio
async def test_ac1_pending_then_the_keys_once_then_never_again(world, caplog):
    caplog.set_level(logging.DEBUG)
    async with _client() as c:
        code, verifier = await _code(c)
        r = await _exchange(c, code, verifier)
        assert (r.status_code, r.json()) == (202, {"status": "pending"})  # before the person confirmed

        r = await _confirm(c, code)
        assert r.status_code == 200, r.text
        members = {m["stage"]: m for m in r.json()["members"]}
        assert set(members) == {"writer", "reviewer", "approver"}  # the channel stage is left for later
        assert members["approver"] == {"stage": "approver", "role": "Approver", "member_id": str(OWNER_TM), "kind": "human"}
        assert members["writer"]["kind"] == members["reviewer"]["kind"] == "agent"
        assert "api_key" not in r.text  # the confirmation never carries a key

        r = await _exchange(c, code, verifier)
        assert r.status_code == 200, r.text
        body = r.json()
        assert body["setup_id"] == str((await _sql(fetch=f"SELECT id FROM desktop_setups WHERE org_id='{ORG}'"))[0][0])
        agents = {a["role"]: a for a in body["agents"]}
        assert set(agents) == {"Writer", "Reviewer"}
        assert (agents["Writer"]["runtime"], agents["Reviewer"]["runtime"]) == ("claude", "codex")
        assert (agents["Writer"]["member_id"], agents["Writer"]["stages"]) == (members["writer"]["member_id"], ["writer"])
        assert all(a["api_key"].startswith("sk_live_") for a in agents.values())
        assert "api_url" in body and "mcp_url" in body
        assert body["workdir_hint"] is None  # none was chosen
        assert body["recipe_name"] == RECIPE_NAME  # the app's default folder ~/Sprintable/{recipe}
        assert body["org_name"] == "O"  # the org the desktop joined — shown to the person (Qadir 4825)

        r = await _exchange(c, code, verifier)
        assert r.status_code == 410  # once
    rt = dict(await _sql(fetch=f"SELECT stage, (SELECT runtime_type FROM members WHERE id=agent_member_id) FROM recipe_role_bindings WHERE org_id='{ORG}' AND agent_member_id IS NOT NULL AND agent_member_id <> '{OWNER_TM}'"))
    assert rt == {"writer": "claude-code", "reviewer": "codex"}

    # AC3 (plaintext): not in any table the setup touched, not in the logs
    for key in (a["api_key"] for a in agents.values()):
        dump = await _sql(fetch=(
            f"SELECT (SELECT coalesce(string_agg(to_jsonb(t)::text, ''), '') FROM desktop_setups t WHERE org_id='{ORG}')"
            f" || (SELECT coalesce(string_agg(to_jsonb(k)::text, ''), '') FROM agent_api_keys k)"
            f" || (SELECT coalesce(string_agg(to_jsonb(m)::text, ''), '') FROM members m WHERE org_id='{ORG}')"
            f" || (SELECT coalesce(string_agg(to_jsonb(b)::text, ''), '') FROM recipe_role_bindings b WHERE org_id='{ORG}')"
        ))
        assert key not in dump[0][0]
        assert key[len("sk_live_"):] not in caplog.text


@pytest.mark.anyio
async def test_ac1_refusals(world):
    async with _client() as c:
        code, verifier = await _code(c)
        # a wrong verifier: refused, and the code still works for its owner (not burnt by whoever saw the address)
        other, _ = _pkce()
        r = await _exchange(c, code, other)
        assert (r.status_code, r.json()["error"]["code"], r.headers["cache-control"]) == (403, "verifier_mismatch", "no-store")
        assert (await _exchange(c, "not-a-code" + "x" * 30, verifier)).status_code == 404

        # confirmations: not an admin · an admin of another org · then the owner (once)
        r = await _confirm(c, code, who=PLAIN)
        assert (r.status_code, r.json()["error"]["code"]) == (403, "not_org_admin")
        r = await _confirm(c, code, who=OUTSIDER, org=ORG2)
        assert r.status_code in (403, 404), r.text  # the project/recipe are not in that org either way
        assert (await _counts())["agents"] == 1  # only the existing one
        first_confirm = await _confirm(c, code)
        assert first_confirm.status_code == 200
        again = await _confirm(c, code)  # the same person again: the setup as it is (PO 11:48Z), nothing new
        assert again.status_code == 200 and again.json()["setup_id"] == first_confirm.json()["setup_id"]
        assert (await _exchange(c, code, verifier)).status_code == 200

        # expired: 10 minutes after the code was made
        code2, verifier2 = await _code(c, "d4424 expired")
        await _sql(f"UPDATE desktop_setups SET expires_at = now() - interval '1 second' WHERE device_name='d4424 expired'")
        assert (await _exchange(c, code2, verifier2)).status_code == 410
        assert (await _confirm(c, code2)).status_code == 410

        # confirmed but the app never picked the keys up before the code ran out: listed as not handed over
        code4, verifier4 = await _code(c, "d4424 never picked up")
        assert (await _confirm(c, code4)).status_code == 200
        await _sql("UPDATE desktop_setups SET expires_at = now() - interval '1 second' WHERE device_name='d4424 never picked up'")
        assert (await _exchange(c, code4, verifier4)).status_code == 410
        listed = {x["device_name"]: x["state"] for x in (await c.get("/api/v2/desktop/setups", headers=_person(OWNER))).json()["setups"]}
        assert listed["d4424 never picked up"] == "not_handed_over"

        # a runtime the app does not have, a stage that is a person's or a channel's, a missing agent stage
        code3, _ = await _code(c, "d4424 roles")
        for roles in (
            [{"role": "Writer", "runtime": "claude"}],  # Reviewer missing
            [{"role": "Writer", "runtime": "claude"}, {"role": "Reviewer", "runtime": "codex"}, {"role": "Approver", "runtime": "claude"}],
            [{"role": "Writer", "runtime": "claude"}, {"role": "Reviewer", "runtime": "codex"}, {"role": "Publisher", "runtime": "claude"}],
            [{"role": "writer", "runtime": "claude"}, {"role": "Reviewer", "runtime": "codex"}],  # a stage name is not a role
        ):
            r = await _confirm(c, code3, body={**_ROLES, "roles": roles})
            assert (r.status_code, r.json()["error"]["code"]) == (422, "roles_invalid"), roles


@pytest.mark.anyio
async def test_an_agent_key_cannot_confirm(world):
    async with _client() as c:
        code, verifier = await _code(c)
        assert (await _confirm(c, code)).status_code == 200
        key = (await _exchange(c, code, verifier)).json()["agents"][0]["api_key"]
        code2, _ = await _code(c, "d4424 second")
        r = await c.post("/api/v2/desktop/setup-codes/confirm", json={**_ROLES, "code": code2}, headers={"Authorization": f"Bearer {key}"})
        assert (r.status_code, r.json()["error"]["code"]) == (403, "person_session_required"), r.text
        r = await c.delete(f"/api/v2/desktop/setups/{uuid.uuid4()}", headers={"Authorization": f"Bearer {key}"})
        assert (r.status_code, r.json()["error"]["code"]) == (403, "person_session_required"), r.text


# ─── AC2 ───────────────────────────────────────────────────────────────────────


@pytest.mark.anyio
async def test_ac2_the_plan_limit_on_the_second_agent_leaves_nothing(world, monkeypatch):
    from fastapi import HTTPException

    from app.core.config import settings

    before = await _counts()
    calls = {"n": 0}

    async def limit(_db, _org):
        calls["n"] += 1
        if calls["n"] == 2:
            raise HTTPException(status_code=402, detail={"code": "PLAN_LIMIT_EXCEEDED"})

    monkeypatch.setattr(type(settings), "is_ee_enabled", property(lambda _self: True))
    monkeypatch.setattr("ee.plan_limits.check_agent_add_limit", limit)
    async with _client() as c:
        code, verifier = await _code(c)
        r = await _confirm(c, code)
        assert r.status_code == 402, r.text
        assert calls["n"] == 2  # the first agent had been made before the second one was refused
        # read again in a new session: no agent · binding · key · confirmation stayed
        assert await _counts() == before
        row = await _sql(fetch=f"SELECT confirmed_at, members FROM desktop_setups WHERE device_name='d4424 laptop'")
        assert row[0] == (None, None)
        assert (await _exchange(c, code, verifier)).status_code == 202  # still waiting for a confirmation


@pytest.mark.anyio
async def test_ac2_a_failure_on_the_second_key_hands_out_nothing_and_the_exchange_can_run_again(world, monkeypatch):
    from app.repositories.api_key import ApiKeyRepository

    real = ApiKeyRepository.create
    calls = {"n": 0}

    async def flaky(self, *a, **kw):
        calls["n"] += 1
        if calls["n"] == 2:
            raise RuntimeError("sentinel: second key")
        return await real(self, *a, **kw)

    async with _client() as c:
        code, verifier = await _code(c)
        assert (await _confirm(c, code)).status_code == 200
        keys_before = (await _counts())["keys"]
        monkeypatch.setattr(ApiKeyRepository, "create", flaky)
        r = await _exchange(c, code, verifier)
        assert r.status_code == 500
        assert (await _counts())["keys"] == keys_before  # the first key went too
        assert (await _sql(fetch=f"SELECT exchanged_at FROM desktop_setups WHERE org_id='{ORG}'"))[0][0] is None
        monkeypatch.setattr(ApiKeyRepository, "create", real)
        r = await _exchange(c, code, verifier)
        assert r.status_code == 200 and len(r.json()["agents"]) == 2


# ─── AC3 · AC4 · AC5 · AC6 ─────────────────────────────────────────────────────


@pytest.mark.anyio
async def test_ac3_to_ac6_least_privilege_other_keys_disconnect_and_the_record(world):
    from app.services.mcp_toolset import is_tool_allowed

    existing_before = await _sql(fetch=f"SELECT id, revoked_at FROM agent_api_keys WHERE team_member_id='{EXISTING}'")
    async with _client() as c:
        code, verifier = await _code(c)
        assert (await _confirm(c, code)).status_code == 200
        agents = (await _exchange(c, code, verifier)).json()["agents"]
        other_code, other_verifier = await _code(c, "d4424 other device")
        assert (await _confirm(c, other_code)).status_code == 200
        other_agents = (await _exchange(c, other_code, other_verifier)).json()["agents"]

        key = agents[0]["api_key"]
        bearer = {"Authorization": f"Bearer {key}"}
        # AC3: the key works (it is a real key) …
        assert (await c.get("/api/v2/me", headers=bearer)).status_code == 200
        # … but cannot make agents or keys — not for another agent, not for itself
        r = await c.post("/api/v2/agents", json={"name": "made by an agent", "scope_mode": "org"}, headers=bearer)
        assert r.status_code == 403, r.text
        for target in (agents[1]["member_id"], agents[0]["member_id"], str(EXISTING)):
            r = await c.post(f"/api/v2/agents/{target}/api-keys", json={"expires_at": None}, headers=bearer)
            assert r.status_code in (403, 404), (target, r.text)
        # and its scope carries no admin / destructive tool
        scope = (await _sql(fetch=f"SELECT scope FROM agent_api_keys WHERE key_hash='{hashlib.sha256(key.encode()).hexdigest()}'"))[0][0]
        assert not {"admin", "destructive"} & set(scope)
        for tool in ("sprintable_delete_story", "sprintable_close_sprint", "sprintable_give_reward"):
            assert is_tool_allowed(tool, scope) is False, tool
        assert is_tool_allowed("sprintable_list_stories", scope) is True

        # AC4: the agent that was already running kept its key, untouched
        assert await _sql(fetch=f"SELECT id, revoked_at FROM agent_api_keys WHERE team_member_id='{EXISTING}'") == existing_before

        # AC5: disconnect this device → its keys only
        setup_id = (await _sql(fetch=f"SELECT id FROM desktop_setups WHERE device_name='d4424 laptop'"))[0][0]
        assert (await c.delete(f"/api/v2/desktop/setups/{setup_id}", headers=_person(PLAIN))).status_code == 403
        assert (await c.delete(f"/api/v2/desktop/setups/{setup_id}", headers=_person(OUTSIDER, ORG2))).status_code == 404
        r = await c.delete(f"/api/v2/desktop/setups/{setup_id}", headers=_person(OWNER))
        assert r.json() == {"revoked_keys": 2}
        assert (await c.get("/api/v2/me", headers=bearer)).status_code == 401
        assert (await c.get("/api/v2/me", headers={"Authorization": f"Bearer {other_agents[0]['api_key']}"})).status_code == 200
        assert await _sql(fetch=f"SELECT id, revoked_at FROM agent_api_keys WHERE team_member_id='{EXISTING}'") == existing_before

        # the web list: both devices, the disconnected one with 0 active keys; people who are not admins see nothing
        listed = {x["device_name"]: x for x in (await c.get("/api/v2/desktop/setups", headers=_person(OWNER))).json()["setups"]}
        assert (listed["d4424 laptop"]["state"], listed["d4424 laptop"]["active_keys"]) == ("disconnected", 0)
        assert (listed["d4424 other device"]["state"], listed["d4424 other device"]["active_keys"]) == ("handed_over", 2)
        assert {m["stage"] for m in listed["d4424 laptop"]["members"]} == {"writer", "reviewer", "approver"}
        # the list carries the people's names (the web does not look each one up): who connected · who disconnected
        assert (listed["d4424 laptop"]["confirmed_by_name"], listed["d4424 laptop"]["revoked_by_name"]) == ("Owner", "Owner")
        assert (listed["d4424 other device"]["confirmed_by_name"], listed["d4424 other device"]["revoked_by_name"]) == ("Owner", None)
        assert (await c.get("/api/v2/desktop/setups", headers=_person(PLAIN))).status_code == 403
        assert (await c.get("/api/v2/desktop/setups", headers=_person(OUTSIDER, ORG2))).json()["setups"] == []

    # AC6: who · which device · how many · when handed · when cut
    row = (await _sql(fetch=(
        "SELECT confirmed_by, device_name, jsonb_array_length(members), keys_issued, exchanged_at IS NOT NULL, revoked_by,"
        f" revoked_at IS NOT NULL FROM desktop_setups WHERE id='{setup_id}'"
    )))[0]
    assert row == (OWNER, "d4424 laptop", 3, 2, True, OWNER, True)


# ─── story #4426 ② — the setup's steps and the one-line read ───────────────────


@pytest.mark.anyio
async def test_4426_the_setup_steps_and_the_one_line_read(world):
    async with _client() as c:
        code, verifier = await _code(c)
        assert (await _confirm(c, code)).status_code == 200
        assert (await _exchange(c, code, verifier)).status_code == 200
        setup_id = (await _sql(fetch=f"SELECT id FROM desktop_setups WHERE org_id='{ORG}'"))[0][0]
        steps = await _sql(fetch=f"SELECT event, meta->>'human_hand' FROM onboarding_events WHERE session_id='{setup_id}' ORDER BY server_ts")
        assert steps == [("desktop_setup_code_issued", None), ("desktop_setup_confirmed", "true"), ("desktop_setup_exchanged", None)]

        read = (await c.get(f"/api/v2/desktop/setups/{setup_id}/hands", headers=_person(OWNER))).json()
        assert (read["human_hands"], read["minutes_to_first_result"], read["docs_opened"]) == (1, None, 0)  # no result yet

        # the code was asked for 3 minutes before the person confirmed; the app later reports that the person typed on the first
        # screen before the first done (a hand), a doc, and the first result 7 minutes after the confirmation → 10 minutes from the code
        await _sql(f"UPDATE onboarding_events SET server_ts = server_ts - interval '3 minutes' WHERE session_id='{setup_id}' AND event='desktop_setup_code_issued'")
        assert (await _app_event(c, setup_id, "desktop_first_screen_human_input", {"human_hand": True})).status_code == 202
        # desktop_doc_opened is the web's (4427 adds it to the client list): stored here as a row the server proved
        await _sql(
            "INSERT INTO onboarding_events (id, event, session_id, meta, server_ts, desktop_setup_verified) VALUES "
            f"(gen_random_uuid(), 'desktop_doc_opened', '{setup_id}', '{{}}', now(), true),"
            f"(gen_random_uuid(), 'desktop_first_result_seen', '{setup_id}', '{{}}',"
            f" (SELECT server_ts FROM onboarding_events WHERE session_id='{setup_id}' AND event='desktop_setup_confirmed') + interval '7 minutes', false)"
        )
        read = (await c.get(f"/api/v2/desktop/setups/{setup_id}/hands", headers=_person(OWNER))).json()
        assert (read["human_hands"], read["minutes_to_first_result"], read["docs_opened"]) == (2, 10.0, 1)
        assert (await c.get(f"/api/v2/desktop/setups/{setup_id}/hands", headers=_person(PLAIN))).status_code == 403
        assert (await c.get(f"/api/v2/desktop/setups/{setup_id}/hands", headers=_person(OUTSIDER, ORG2))).status_code == 404


@pytest.mark.anyio
async def test_the_folder_chosen_on_the_web_comes_back_in_the_exchange_as_is(world):
    async with _client() as c:
        code, verifier = await _code(c)
        # control characters are refused, 200 characters is the limit
        assert (await _confirm(c, code, body={**_ROLES, "workdir_hint": "~/work/a\nb"})).status_code == 422
        assert (await _confirm(c, code, body={**_ROLES, "workdir_hint": "x" * 201})).status_code == 422
        hint = "~/work/sprintable ../ 한글 폴더"  # not checked by the server: the app judges the path
        assert (await _confirm(c, code, body={**_ROLES, "workdir_hint": hint})).status_code == 200
        assert (await _exchange(c, code, verifier)).json()["workdir_hint"] == hint


# ─── PO 08:31Z ① — one agent per role, on the real preset (not a hand-made shape) ─


@pytest.mark.anyio
async def test_the_video_recipe_makes_one_agent_for_the_creator_and_gives_the_director_stages_to_the_person(world):
    preset = (await _sql(fetch="SELECT id, stage_metadata, role_actor_kinds FROM event_definitions WHERE key='preset.marketing.video_production' AND org_id IS NULL"))
    assert preset, "the migrated DB carries the preset"
    preset_id, stage_metadata, kinds = preset[0]
    # the shape this test relies on (so a changed preset turns this red here, not silently)
    creator = sorted(s for s, m in stage_metadata.items()
                     if m.get("role") == "Creator" and (m.get("capability") or {}).get("target") in (None, "agent"))
    director = sorted(s for s, m in stage_metadata.items() if m.get("role") == "Director")
    assert kinds["Director"] == "human" and kinds["Creator"] == "agent"
    assert len(creator) == 4 and len(director) == 3, (creator, director)

    before = await _counts()
    async with _client() as c:
        code, verifier = await _code(c)
        body = {"project_id": str(PROJ), "recipe_id": str(preset_id), "roles": [{"role": "Creator", "runtime": "claude"}]}
        r = await _confirm(c, code, body=body)
        assert r.status_code == 200, r.text
        members = {m["stage"]: m for m in r.json()["members"]}
        assert (await _counts())["agents"] == before["agents"] + 1  # exactly one new agent
        agent_ids = {members[s]["member_id"] for s in creator}
        assert len(agent_ids) == 1 and all(members[s]["kind"] == "agent" and members[s]["role"] == "Creator" for s in creator)
        assert {members[s]["member_id"] for s in director} == {str(OWNER_TM)}
        assert all(members[s]["kind"] == "human" for s in director)
        assert "published" not in members and "live_generation" not in members  # channel · compute stages stay unbound
        bound = dict(await _sql(fetch=(
            "SELECT stage, coalesce(agent_member_id::text, channel_connection_id::text, generation_connector_id::text) FROM recipe_role_bindings "
            f"WHERE org_id='{ORG}' AND event_definition_key='preset.marketing.video_production'"
        )))
        assert set(bound) == set(creator) | set(director)
        name = (await _sql(fetch=f"SELECT name FROM members WHERE id='{next(iter(agent_ids))}'"))[0][0]
        assert name == "Creator · d4424 laptop"
        # the exchange: one key for the one agent, carrying its role and all its stages
        ex = (await _exchange(c, code, verifier)).json()
        assert [(a["role"], sorted(a["stages"]), a["runtime"]) for a in ex["agents"]] == [("Creator", creator, "claude")]
        # a role the recipe does not have / a person's role / a stage name → 422
        code2, _ = await _code(c, "d4424 roles2")
        for roles in ([{"role": "Director", "runtime": "claude"}, {"role": "Creator", "runtime": "claude"}], [{"role": "draft", "runtime": "claude"}]):
            assert (await _confirm(c, code2, body={**body, "roles": roles})).status_code == 422, roles


@pytest.mark.anyio
async def test_no_mcp_address_no_keys(world, monkeypatch):
    """PO 08:31Z ③ — without an MCP address an agent would run without its tools: refused before any key is made."""
    async with _client() as c:
        code, verifier = await _code(c)
        assert (await _confirm(c, code)).status_code == 200
        keys_before = (await _counts())["keys"]
        monkeypatch.delenv("MCP_PUBLIC_URL")
        r = await _exchange(c, code, verifier)
        assert (r.status_code, r.json()["error"]["code"]) == (503, "service_unavailable")
        assert (await _counts())["keys"] == keys_before
        monkeypatch.setenv("MCP_PUBLIC_URL", "https://mcp.d4424.test/mcp")
        r = await _exchange(c, code, verifier)
        assert r.status_code == 200 and r.json()["mcp_url"] == "https://mcp.d4424.test/mcp"


@pytest.mark.anyio
async def test_the_setup_code_is_in_no_url_and_no_log(world, caplog):
    """Qadir 4825 (PO 09:45Z) — the code travels in bodies only: no request URL of the whole flow carries it, and nothing
    logged while it runs does (incl. a refused and a failing request, whose paths the error handler logs)."""
    from httpx import ASGITransport, AsyncClient

    from app.main import app

    caplog.set_level(logging.DEBUG)
    urls: list[str] = []

    async def record(request):
        urls.append(str(request.url))

    async with AsyncClient(transport=ASGITransport(app=app, raise_app_exceptions=False), base_url="http://test",
                           event_hooks={"request": [record]}) as c:
        code, verifier = await _code(c)
        other, _ = _pkce()
        assert (await _exchange(c, code, other)).status_code == 403  # refused
        assert (await _exchange(c, code, verifier)).status_code == 202
        assert (await _confirm(c, code)).status_code == 200
        assert (await _exchange(c, code, verifier)).status_code == 200
        assert (await _exchange(c, code, verifier)).status_code == 410
    assert urls and not [u for u in urls if code in u], urls
    assert code not in caplog.text


@pytest.mark.anyio
async def test_no_api_address_no_keys(world, monkeypatch):
    """PO 09:45Z — FASTAPI_URL unset used to fall back to localhost silently; like a missing MCP address, refused before any key."""
    async with _client() as c:
        code, verifier = await _code(c)
        assert (await _confirm(c, code)).status_code == 200
        keys_before = (await _counts())["keys"]
        monkeypatch.delenv("FASTAPI_URL")
        r = await _exchange(c, code, verifier)
        assert (r.status_code, r.json()["error"]["code"]) == (503, "service_unavailable")
        assert (await _counts())["keys"] == keys_before
        monkeypatch.setenv("FASTAPI_URL", "https://api.d4424.test")
        r = await _exchange(c, code, verifier)
        assert r.status_code == 200 and r.json()["api_url"] == "https://api.d4424.test"


def test_no_desktop_route_takes_a_code_in_its_path():
    """The class guard (Qadir 4825): whatever a client does, no /api/v2/desktop route can put a setup code in a URL."""
    import re

    from app.main import app

    desktop = [r.path for r in app.routes if getattr(r, "path", "").startswith("/api/v2/desktop")]
    assert desktop, "the desktop routes are registered"
    assert [p for p in desktop if re.search(r"\{[^}]*code[^}]*\}", p)] == [], desktop


@pytest.mark.anyio
async def test_agent_key_requests_to_the_setup_api_are_not_recorded_as_tool_calls(world):
    """Qadir 4825 (PO 10:08Z) — an agent key's request bodies go to agent_run_tool_calls (an audit table org admins read);
    the setup API's code and verifier must not: its path is not recorded at all."""
    async with _client() as c:
        code, verifier = await _code(c)
        assert (await _confirm(c, code)).status_code == 200
        key = (await _exchange(c, code, verifier)).json()["agents"][0]["api_key"]
        code2, verifier2 = await _code(c, "d4424 recorded?")
        bearer = {"Authorization": f"Bearer {key}"}
        assert (await c.post("/api/v2/desktop/setup-codes/confirm", json={**_ROLES, "code": code2}, headers=bearer)).status_code == 403
        await c.post("/api/v2/desktop/setup-codes/exchange", json={"code": code2, "verifier": verifier2}, headers=bearer)
        # positive control: the same key's ordinary call is recorded (so the table is really being written in this test)
        assert (await c.get("/api/v2/me", headers=bearer)).status_code == 200
    import asyncio

    for _ in range(50):  # the recording is written after the response
        rows = await _sql(fetch=f"SELECT coalesce(string_agg(to_jsonb(t)::text, ''), '') FROM agent_run_tool_calls t WHERE org_id='{ORG}'")
        if "/api/v2/me" in rows[0][0]:
            break
        await asyncio.sleep(0.1)
    dump = rows[0][0]
    assert "/api/v2/me" in dump, "positive control: the ordinary call was recorded"
    for secret in (code2, verifier2, code, verifier):
        assert secret not in dump
    assert "/api/v2/desktop" not in dump
# ─── PO 08:22Z — the first work item in the confirmation's transaction ─────────


async def _stream_events(agent_id: str) -> list:
    """What the agent's stream sends on its very first connection (no cursor, no Last-Event-ID): the stream's own read."""
    from app.routers.agent_gateway import _fetch_events

    eng = create_async_engine(_ASYNC, poolclass=NullPool)
    try:
        async with async_sessionmaker(eng)() as s:
            return await _fetch_events(s, uuid.UUID(agent_id), 0, 100)
    finally:
        await eng.dispose()


@pytest.mark.anyio
async def test_the_confirmation_starts_the_first_work_item_and_the_new_agent_gets_it_on_its_first_subscription(world):
    async with _client() as c:
        code, _ = await _code(c)
        r = await _confirm(c, code)
        assert r.status_code == 200, r.text
        body = r.json()
        story = await _sql(fetch=f"SELECT title, project_id FROM stories WHERE id='{body['work_item_id']}'")
        assert story == [(RECIPE_NAME, PROJ)]
        writer = next(m["member_id"] for m in body["members"] if m["stage"] == "writer")
        events = await _stream_events(writer)
        payloads = [json.dumps(e.payload if hasattr(e, "payload") else e._mapping["payload"], default=str) for e in events]
        assert any(body["work_item_id"] in p for p in payloads), payloads  # the first stage, on that story
        # the first stage was published once, by the person who confirmed
        sent = await _sql(fetch=(
            "SELECT m.sender_id, m.metadata->'event'->'payload'->>'stage' FROM conversation_messages m JOIN conversations c ON c.id=m.conversation_id "
            f"WHERE c.org_id='{ORG}' AND m.metadata->'event'->'payload'->>'work_item_id'='{body['work_item_id']}'"
        ))
        assert sent == [(OWNER_TM, "writer")]


@pytest.mark.anyio
async def test_a_person_first_recipe_sends_the_first_stage_to_the_person(world):
    async with _client() as c:
        code, _ = await _code(c)
        r = await _confirm(c, code, body={**_ROLES, "recipe_id": str(RECIPE2)})
        assert r.status_code == 200, r.text
        wid = r.json()["work_item_id"]
        rows = await _sql(fetch=(
            "SELECT m.metadata->'event'->'payload'->>'stage', p.member_id FROM conversation_messages m "
            "JOIN conversations c ON c.id=m.conversation_id JOIN conversation_participants p ON p.conversation_id=c.id "
            f"WHERE c.org_id='{ORG}' AND m.metadata->'event'->'payload'->>'work_item_id'='{wid}'"
        ))
        assert {stage for stage, _ in rows} == {"approver"}  # the recipe's own order: the person's stage first
        assert OWNER_TM in {member for _, member in rows}
        writer = next(m["member_id"] for m in r.json()["members"] if m["stage"] == "writer")
        assert not any(wid in json.dumps(e._mapping["payload"], default=str) for e in await _stream_events(writer))


@pytest.mark.anyio
async def test_a_failed_first_publish_undoes_the_whole_confirmation(world, monkeypatch):
    from fastapi import HTTPException

    async def refuse(*_a, **_kw):
        raise HTTPException(status_code=409, detail={"code": "sentinel_publish_refused", "message": "sentinel"})

    before = await _counts()
    stories_before = (await _sql(fetch=f"SELECT count(*) FROM stories WHERE project_id='{PROJ}'"))[0][0]
    monkeypatch.setattr("app.routers.events._publish_registry_event_core", refuse)
    async with _client() as c:
        code, verifier = await _code(c)
        r = await _confirm(c, code)
        assert (r.status_code, r.json()["error"]["code"]) == (409, "sentinel_publish_refused")
        # read again in a new session: no agent · binding · story · key, and the code is still waiting for a confirmation
        assert await _counts() == before
        assert (await _sql(fetch=f"SELECT count(*) FROM stories WHERE project_id='{PROJ}'"))[0][0] == stories_before
        assert (await _sql(fetch="SELECT confirmed_at, members, workdir_hint FROM desktop_setups WHERE device_name='d4424 laptop'"))[0] == (None, None, None)
        assert (await _exchange(c, code, verifier)).status_code == 202
        monkeypatch.undo()
        assert (await _confirm(c, code)).status_code == 200  # the same code confirms fine afterwards


# ─── PO 08:31Z · 08:39Z — one setup's status and the MCP connection mark ──────


@pytest.mark.anyio
async def test_the_setup_status_reads_its_signals_and_the_mcp_manifest_marks_tools_connected_once(world):
    async with _client() as c:
        code, verifier = await _code(c)
        confirmed = (await _confirm(c, code)).json()
        agents = (await _exchange(c, code, verifier)).json()["agents"]
        setup_id = confirmed["setup_id"]
        status = (await c.get(f"/api/v2/desktop/setups/{setup_id}", headers=_person(OWNER))).json()
        assert (status["state"], status["recipe_name"], status["work_item_id"]) == ("handed_over", RECIPE_NAME, confirmed["work_item_id"])
        assert status["signals"] == {
            "tools_connected": [], "first_task_handed_at": None, "first_result_at": None, "first_screen_human_input_at": None,
            "workdir_fallback_at": None, "blocked": None,
        }

        # the MCP server fetches the manifest at tools/list with the agent's key: marked once for that member (a second
        # connection, or the same member again, adds nothing); a key that no setup handed out marks nothing
        writer = next(a for a in agents if a["role"] == "Writer")
        for _ in range(2):
            assert (await c.get("/api/v2/mcp/manifest", headers={"Authorization": f"Bearer {writer['api_key']}"})).status_code == 200
        marks = await _sql(fetch=f"SELECT meta->>'member_id' FROM onboarding_events WHERE session_id='{setup_id}' AND event='desktop_tools_connected'")
        assert marks == [(writer["member_id"],)]
        # the daemon's agent stream uses the same key but never this route — nothing else marks it
        status = (await c.get(f"/api/v2/desktop/setups/{setup_id}", headers=_person(OWNER))).json()
        assert [t["member_id"] for t in status["signals"]["tools_connected"]] == [writer["member_id"]]

        # what the desktop app reports, sent as it will send it (its setup's token in the header)
        for event, meta in (("desktop_first_task_handed", {}), ("desktop_workdir_fallback", {}),
                            ("desktop_setup_blocked", {"reason": "managed_mcp", "runtime": "claude", "when": "found"}), ("desktop_first_screen_human_input", {"human_hand": True})):
            assert (await _app_event(c, setup_id, event, meta)).status_code == 202
        await _sql(f"INSERT INTO onboarding_events (id, event, session_id, meta, server_ts) VALUES (gen_random_uuid(), 'desktop_first_result_seen', '{setup_id}', '{{}}', now())")
        signals = (await c.get(f"/api/v2/desktop/setups/{setup_id}", headers=_person(OWNER))).json()["signals"]
        assert all(signals[k] for k in ("first_task_handed_at", "first_result_at", "workdir_fallback_at", "first_screen_human_input_at"))
        assert (signals["blocked"]["reason"], signals["blocked"]["runtime"], signals["blocked"]["when"]) == ("managed_mcp", "claude", "found")
        assert (await c.get(f"/api/v2/desktop/setups/{setup_id}", headers=_person(PLAIN))).status_code == 403
        assert (await c.get(f"/api/v2/desktop/setups/{setup_id}", headers=_person(OUTSIDER, ORG2))).status_code == 404

    # an ordinary agent key (not from a setup) fetching the manifest marks nothing
    before = (await _sql(fetch="SELECT count(*) FROM onboarding_events WHERE event='desktop_tools_connected'"))[0][0]
    from app.services.desktop_setup import mark_tools_connected

    existing_key = (await _sql(fetch=f"SELECT id FROM agent_api_keys WHERE team_member_id='{EXISTING}'"))[0][0]
    await mark_tools_connected(existing_key)
    assert (await _sql(fetch="SELECT count(*) FROM onboarding_events WHERE event='desktop_tools_connected'"))[0][0] == before


@pytest.mark.anyio
async def test_the_first_result_is_the_setup_agents_first_write_on_its_first_work_item(world):
    """PO 08:44Z — `desktop_first_result_seen` is written by the server when one of the setup's agents first writes on the
    setup's work item (here a comment, then a status change: still one row); the person's writes do not count."""
    async with _client() as c:
        code, verifier = await _code(c)
        confirmed = (await _confirm(c, code)).json()
        agents = (await _exchange(c, code, verifier)).json()["agents"]
        setup_id, wid = confirmed["setup_id"], confirmed["work_item_id"]
        rows = lambda: _sql(fetch=f"SELECT meta->>'member_id' FROM onboarding_events WHERE session_id='{setup_id}' AND event='desktop_first_result_seen'")

        # the person comments first: not a result
        assert (await c.post(f"/api/v2/stories/{wid}/comments", json={"content": "go"}, headers=_person(OWNER))).status_code == 201
        assert await rows() == []
        writer = next(a for a in agents if a["role"] == "Writer")
        bearer = {"Authorization": f"Bearer {writer['api_key']}"}
        r = await c.post(f"/api/v2/stories/{wid}/comments", json={"content": "draft ready"}, headers=bearer)
        assert r.status_code == 201, r.text
        assert await rows() == [(writer["member_id"],)]
        r = await c.patch(f"/api/v2/stories/{wid}/status", json={"status": "in-progress"}, headers=bearer)
        assert r.status_code == 200, r.text
        assert await rows() == [(writer["member_id"],)]  # once
        status = (await c.get(f"/api/v2/desktop/setups/{setup_id}", headers=_person(OWNER))).json()
        assert status["signals"]["first_result_at"] is not None
        hands = (await c.get(f"/api/v2/desktop/setups/{setup_id}/hands", headers=_person(OWNER))).json()
        assert hands["minutes_to_first_result"] is not None


@pytest.mark.anyio
async def test_a_stage_publish_by_the_agent_is_also_a_first_result(world):
    async with _client() as c:
        code, verifier = await _code(c)
        confirmed = (await _confirm(c, code)).json()
        agents = (await _exchange(c, code, verifier)).json()["agents"]
        writer = next(a for a in agents if a["role"] == "Writer")
        r = await c.post(
            "/api/v2/events/publish",
            json={"definition_key": RECIPE_KEY, "payload": {"work_item_type": "story", "work_item_id": confirmed["work_item_id"], "stage": "reviewer"}},
            headers={"Authorization": f"Bearer {writer['api_key']}"},
        )
        assert r.status_code == 201, r.text
        rows = await _sql(fetch=f"SELECT meta->>'member_id' FROM onboarding_events WHERE session_id='{confirmed['setup_id']}' AND event='desktop_first_result_seen'")
        assert rows == [(writer["member_id"],)]


@pytest.mark.anyio
async def test_a_status_change_by_the_agent_is_also_a_first_result(world):
    async with _client() as c:
        code, verifier = await _code(c)
        confirmed = (await _confirm(c, code)).json()
        agents = (await _exchange(c, code, verifier)).json()["agents"]
        reviewer = next(a for a in agents if a["role"] == "Reviewer")
        bearer = {"Authorization": f"Bearer {reviewer['api_key']}"}
        marks = lambda: _sql(fetch=f"SELECT meta->>'member_id' FROM onboarding_events WHERE session_id='{confirmed['setup_id']}' AND event='desktop_first_result_seen'")
        # PO 11:04Z — starting work is not a result: in-progress marks nothing
        r = await c.patch(f"/api/v2/stories/{confirmed['work_item_id']}/status", json={"status": "in-progress"}, headers=bearer)
        assert r.status_code == 200, r.text
        assert await marks() == []
        r = await c.patch(f"/api/v2/stories/{confirmed['work_item_id']}/status", json={"status": "in-review"}, headers=bearer)
        assert r.status_code == 200, r.text
        assert await marks() == [(reviewer["member_id"],)]


@pytest.mark.anyio
async def test_the_setup_finds_its_work_item_even_when_the_funnel_event_fails(world, monkeypatch):
    """PO 11:04Z — the setup ↔ first work item link is on the setup row (0423), not in the funnel event (whose write fails
    silently): with the confirmed event failing, the status read still has the work item and the first result is still marked."""
    from app.services import onboarding_funnel

    real = onboarding_funnel.record_onboarding_event

    async def fail_confirmed(db, *, event, **kw):
        if event == "desktop_setup_confirmed":
            raise RuntimeError("sentinel: funnel write failed")
        return await real(db, event=event, **kw)

    async with _client() as c:
        code, verifier = await _code(c)
        monkeypatch.setattr(onboarding_funnel, "record_onboarding_event", fail_confirmed)
        confirmed = (await _confirm(c, code)).json()
        monkeypatch.setattr(onboarding_funnel, "record_onboarding_event", real)  # (not undo(): that would drop the address env too)
        assert confirmed["work_item_id"]
        assert await _sql(fetch=f"SELECT count(*) FROM onboarding_events WHERE session_id='{confirmed['setup_id']}' AND event='desktop_setup_confirmed'") == [(0,)]
        status = (await c.get(f"/api/v2/desktop/setups/{confirmed['setup_id']}", headers=_person(OWNER))).json()
        assert status["work_item_id"] == confirmed["work_item_id"]
        agents = (await _exchange(c, code, verifier)).json()["agents"]
        writer = next(a for a in agents if a["role"] == "Writer")
        r = await c.post(f"/api/v2/stories/{confirmed['work_item_id']}/comments", json={"content": "done"}, headers={"Authorization": f"Bearer {writer['api_key']}"})
        assert r.status_code == 201, r.text
        rows = await _sql(fetch=f"SELECT meta->>'member_id' FROM onboarding_events WHERE session_id='{confirmed['setup_id']}' AND event='desktop_first_result_seen'")
        assert rows == [(writer["member_id"],)]


@pytest.mark.anyio
async def test_the_same_person_confirming_again_gets_the_setup_as_it_is_and_nothing_is_made(world):
    """PO 11:48Z — a confirmation whose commit went through but whose answer was lost: pressing again answers the same setup
    (200, the same setup_id · members · work_item_id), makes nothing and re-applies nothing even with another body; someone
    else is still refused."""
    async with _client() as c:
        code, _ = await _code(c)
        first = await _confirm(c, code)
        assert first.status_code == 200
        counts = await _counts()
        stories = (await _sql(fetch=f"SELECT count(*) FROM stories WHERE project_id='{PROJ}'"))[0][0]
        other_body = {**_ROLES, "roles": [{"role": "Writer", "runtime": "codex"}, {"role": "Reviewer", "runtime": "codex"}], "workdir_hint": "~/elsewhere"}
        again = await _confirm(c, code, body=other_body)
        assert again.status_code == 200, again.text
        assert {k: again.json()[k] for k in ("setup_id", "members", "work_item_id")} == {k: first.json()[k] for k in ("setup_id", "members", "work_item_id")}
        assert await _counts() == counts
        assert (await _sql(fetch=f"SELECT count(*) FROM stories WHERE project_id='{PROJ}'"))[0][0] == stories
        assert (await _sql(fetch="SELECT workdir_hint FROM desktop_setups WHERE device_name='d4424 laptop'"))[0][0] is None
        # another admin of the same org is refused as before
        await _sql(f"INSERT INTO org_members (id,org_id,user_id,role) VALUES (gen_random_uuid(),'{ORG}','{PLAIN}','admin') ON CONFLICT DO NOTHING")
        await _sql(f"UPDATE org_members SET role='admin' WHERE org_id='{ORG}' AND user_id='{PLAIN}'")
        r = await _confirm(c, code, who=PLAIN)
        assert (r.status_code, r.json()["error"]["code"]) == (409, "already_confirmed")


@pytest.mark.anyio
@pytest.mark.parametrize("path", ["report-done", "bulk"])
async def test_every_status_path_marks_the_first_result(world, path):
    """PO 11:48Z — the mark lives in emit_story_status_changed, the one path every status change takes: the workflow
    report-done (the agents' usual way to finish a stage) and the board's bulk update mark it too, not only PATCH /status."""
    async with _client() as c:
        code, verifier = await _code(c)
        confirmed = (await _confirm(c, code)).json()
        agents = (await _exchange(c, code, verifier)).json()["agents"]
        writer = next(a for a in agents if a["role"] == "Writer")
        bearer = {"Authorization": f"Bearer {writer['api_key']}"}
        wid = confirmed["work_item_id"]
        if path == "report-done":
            r = await c.post("/api/v2/workflow/report-done", json={"story_id": wid, "stage": "dev", "agent_id": writer["member_id"]}, headers=bearer)
        else:
            r = await c.patch("/api/v2/stories/bulk", json={"items": [{"id": wid, "status": "in-review"}]}, headers=bearer)
        assert r.status_code == 200, r.text
        assert (await _sql(fetch=f"SELECT status FROM stories WHERE id='{wid}'"))[0][0] == "in-review"
        rows = await _sql(fetch=f"SELECT meta->>'member_id' FROM onboarding_events WHERE session_id='{confirmed['setup_id']}' AND event='desktop_first_result_seen'")
        assert rows == [(writer["member_id"],)]


@pytest.mark.anyio
async def test_an_ordinary_write_opens_no_session_for_the_first_result_check(world, monkeypatch):
    """PO 11:48Z (Qadir 2nd line) — the check runs after every comment / status change / agent publish in the product: with
    the caller's session it is one read and no new session; a new one is opened only for a setup agent's write."""
    import app.core.database as database

    opened = {"n": 0}
    real = database.async_session_factory

    def counting(*a, **kw):
        opened["n"] += 1
        return real(*a, **kw)

    from app.services.desktop_setup import mark_first_result

    eng = create_async_engine(_ASYNC, poolclass=NullPool)
    try:
        async with async_sessionmaker(eng)() as s:
            monkeypatch.setattr(database, "async_session_factory", counting)
            await mark_first_result(uuid.uuid4(), uuid.uuid4(), db=s)  # a story no setup made, anyone
            assert opened["n"] == 0
    finally:
        await eng.dispose()


@pytest.mark.anyio
async def test_a_failing_first_result_read_does_not_abort_the_callers_open_transaction(world, monkeypatch):
    """Qadir 4826 (PO 12:08Z) — a gate resolution emits before its commit, so the read runs in its open transaction: made to
    fail, it must not abort that transaction (the resolution still commits)."""
    from sqlalchemy import text as sql_text

    from app.services import desktop_setup

    async def broken(db, story_uuid):
        await db.execute(sql_text("SELECT * FROM d4424_no_such_table"))  # a failing statement, like a statement timeout
        return []

    monkeypatch.setattr(desktop_setup, "_setups_for_story", broken)
    marker = f"d4424-{uuid.uuid4()}"
    eng = create_async_engine(_ASYNC, poolclass=NullPool)
    try:
        async with async_sessionmaker(eng)() as s:
            # the caller's own write, not committed yet
            await s.execute(sql_text("INSERT INTO onboarding_events (id, event, meta) VALUES (gen_random_uuid(), 'desktop_setup_code_issued', CAST(:m AS jsonb))"), {"m": json.dumps({"flow": marker})})
            await desktop_setup.mark_first_result(uuid.uuid4(), uuid.uuid4(), db=s)  # swallowed, logged
            await s.commit()  # an aborted transaction would fail here
    finally:
        await eng.dispose()
    rows = await _sql(fetch=f"SELECT count(*) FROM onboarding_events WHERE meta->>'flow' = '{marker}'")
    assert rows == [(1,)]
    await _sql(f"DELETE FROM onboarding_events WHERE meta->>'flow' = '{marker}'")


# ─── PO 12:21Z — the setup reads count only what is proven ──────────────────────


@pytest.mark.anyio
async def test_only_proven_step_events_are_counted(world):
    async with _client() as c:
        code, verifier = await _code(c)
        confirmed = (await _confirm(c, code)).json()
        setup_id = confirmed["setup_id"]
        other_code, _ = await _code(c, "d4424 other")  # another setup: its token must not work for this one
        other_setup = (await _sql(fetch="SELECT id FROM desktop_setups WHERE device_name='d4424 other'"))[0][0]
        status = lambda: c.get(f"/api/v2/desktop/setups/{setup_id}", headers=_person(OWNER))
        hands = lambda: c.get(f"/api/v2/desktop/setups/{setup_id}/hands", headers=_person(OWNER))

        # ① the server's own names cannot be sent from outside
        for name in ("desktop_setup_confirmed", "desktop_tools_connected", "desktop_first_result_seen", "verified"):
            r = await c.post("/api/v2/onboarding/events", json={"event": name, "session_id": setup_id, "meta": {"human_hand": True}})
            assert r.status_code == 422, name

        # ②a a desktop app step without its setup's token is kept but not counted — no token, a wrong one, another setup's
        base_hands = (await hands()).json()["human_hands"]
        for token in (None, "not-the-token", EVENT_TOKENS[str(other_setup)]):
            assert (await _app_event(c, setup_id, "desktop_first_screen_human_input", {"human_hand": True}, token=token)).status_code == 202
            assert (await _app_event(c, setup_id, "desktop_first_task_handed", {}, token=token)).status_code == 202
        s1 = (await status()).json()["signals"]
        assert (s1["first_screen_human_input_at"], s1["first_task_handed_at"]) == (None, None)
        assert (await hands()).json()["human_hands"] == base_hands
        stored = (await _sql(fetch=f"SELECT count(*), bool_or(desktop_setup_verified) FROM onboarding_events WHERE session_id='{setup_id}' AND event IN ('desktop_first_screen_human_input','desktop_first_task_handed')"))[0]
        assert stored == (6, False), "kept for analysis, never marked proven"
        # with its own token it counts
        assert (await _app_event(c, setup_id, "desktop_first_screen_human_input", {"human_hand": True})).status_code == 202
        assert (await status()).json()["signals"]["first_screen_human_input_at"] is not None
        assert (await hands()).json()["human_hands"] == base_hands + 1

        # ③ a blocked reason outside the closed list is dropped; meta over the cap is refused
        assert (await _app_event(c, setup_id, "desktop_setup_blocked", {"reason": "please call +1 555 0100"})).status_code == 202
        assert (await status()).json()["signals"]["blocked"] == {"at": (await status()).json()["signals"]["blocked"]["at"], "reason": None, "runtime": None, "when": None}
        # the shell's managed MCP block (4427 ⑥) keeps its runtime and when; values outside their lists are dropped
        assert (await _app_event(c, setup_id, "desktop_setup_blocked", {"reason": "managed_mcp", "runtime": "claude", "when": "after_start"})).status_code == 202
        b = (await status()).json()["signals"]["blocked"]
        assert (b["reason"], b["runtime"], b["when"]) == ("managed_mcp", "claude", "after_start")
        assert (await _app_event(c, setup_id, "desktop_setup_blocked", {"reason": "managed_mcp", "runtime": "vim", "when": "later"})).status_code == 202
        b = (await status()).json()["signals"]["blocked"]
        assert (b["reason"], b["runtime"], b["when"]) == ("managed_mcp", None, None)
        # a reason the shell does not send (a daemon refusal code) is dropped too
        assert (await _app_event(c, setup_id, "desktop_setup_blocked", {"reason": "agent_auth_failed"})).status_code == 202
        assert (await status()).json()["signals"]["blocked"]["reason"] is None
        assert (await _app_event(c, setup_id, "desktop_workdir_fallback", {"x": "a" * 3000})).status_code == 422
        # the token is in no stored row
        assert not (await _sql(fetch=f"SELECT 1 FROM onboarding_events WHERE to_jsonb(onboarding_events)::text LIKE '%{EVENT_TOKENS[setup_id]}%'"))

        # PO 12:51Z — no time limit, but a disconnected setup's token no longer counts
        assert (await c.delete(f"/api/v2/desktop/setups/{setup_id}", headers=_person(OWNER))).status_code in (200, 204)
        before_fallback = (await status()).json()["signals"]["workdir_fallback_at"]
        assert (await _app_event(c, setup_id, "desktop_workdir_fallback", {})).status_code == 202
        assert (await status()).json()["signals"]["workdir_fallback_at"] == before_fallback is None


@pytest.mark.anyio
async def test_a_web_step_counts_only_from_a_signed_in_member_of_the_setups_org(world):
    from app.services.desktop_setup import verify_setup_event

    async with _client() as c:
        code, _ = await _code(c)
        setup_id = uuid.UUID((await _confirm(c, code)).json()["setup_id"])
    eng = create_async_engine(_ASYNC, poolclass=NullPool)
    try:
        async with async_sessionmaker(eng)() as s:
            # a web desktop name (the web's list gets it with 4427): a member of the setup's org → proven; anyone else → not
            async def check(user):
                return await verify_setup_event(s, event="desktop_handoff_selected", setup_id=setup_id, event_token=None, user_id=user)
            assert await check(OWNER) is True
            assert await check(OUTSIDER) is False
            assert await check(None) is False
    finally:
        await eng.dispose()


@pytest.mark.anyio
@pytest.mark.parametrize("limit, expected_available", [(2, 1), (1, 0)])
async def test_the_plan_limit_refusal_says_how_many_are_needed_and_available(world, monkeypatch, limit, expected_available):
    """PO 12:30Z — the 402 carries `needed` (new agents this setup makes: Writer · Reviewer = 2) and `available` (the limit minus
    the agents there were before: 1 existing agent → limit 2 → 1 · limit 1 → 0). Nothing of the setup stays."""
    from sqlalchemy import text as sql_text

    from app.core.config import settings
    from ee import plan_limits

    async def limited(db, org_id):
        current = (await db.execute(sql_text(
            "SELECT COUNT(*) FROM members WHERE org_id = :oid AND type = 'agent' AND is_active = true AND deleted_at IS NULL"
        ), {"oid": str(org_id)})).scalar()
        if current >= limit:
            raise plan_limits._plan_limit_error("agent", limit, current=current, tier="free")

    monkeypatch.setattr(type(settings), "is_ee_enabled", property(lambda _self: True))
    monkeypatch.setattr("ee.plan_limits.check_agent_add_limit", limited)
    before = await _counts()
    async with _client() as c:
        code, _ = await _code(c)
        r = await _confirm(c, code)
        assert r.status_code == 402, r.text
        error = r.json()["error"]
        assert (error["code"], error["needed"], error["available"]) == ("PLAN_LIMIT_EXCEEDED", 2, expected_available)
        assert await _counts() == before  # rolled back as before


# ─── PO 13:04Z — the open setup routes count per user IP ───────────────────────


@pytest.fixture
def per_ip_limits(monkeypatch):
    """Cloud Run (K_SERVICE: the user's IP is the right end of X-Forwarded-For) with the open-setup limiter on, fresh counts."""
    from app.core.rate_limit import open_setup_limiter

    monkeypatch.setenv("K_SERVICE", "sprintable-backend-dev")
    monkeypatch.setattr(open_setup_limiter, "enabled", True)
    open_setup_limiter.reset()
    yield
    open_setup_limiter.reset()


@pytest.mark.anyio
async def test_setup_codes_are_limited_per_user_ip_not_for_everyone_together(world, per_ip_limits):
    async with _client() as c:
        async def ask(ip: str):
            _v, challenge = _pkce()
            # the client may put anything in front; the front end adds the connecting address at the right end
            return await c.post("/api/v2/desktop/setup-codes", json={"challenge": challenge, "device_name": "d4424 ip"},
                                headers={"X-Forwarded-For": f"203.0.113.250, {ip}"})
        for _ in range(10):
            assert (await ask("198.51.100.1")).status_code == 201
        assert (await ask("198.51.100.1")).status_code == 429  # the same person over 10/minute
        assert (await ask("198.51.100.2")).status_code == 201  # someone else is counted apart


@pytest.mark.anyio
async def test_a_made_up_api_key_does_not_buy_a_fresh_count_on_the_open_routes(world, per_ip_limits):
    """Qadir 4828 — these routes take no login, so a `Bearer sk_live_…` is never checked; a different fake one on every request
    must still be counted as the same IP."""
    async with _client() as c:
        async def ask(n: int):
            _v, challenge = _pkce()
            fake = ["sk", "live", f"{n:02d}" + "q" * 28]  # differs inside the first 30 characters the old key used
            return await c.post("/api/v2/desktop/setup-codes", json={"challenge": challenge, "device_name": "d4424 fake"},
                                headers={"X-Forwarded-For": "198.51.100.7", "Authorization": "Bearer " + "_".join(fake)})
        for n in range(10):
            assert (await ask(n % 3)).status_code == 201
        assert (await ask(10)).status_code == 429


@pytest.mark.anyio
async def test_onboarding_events_are_limited_per_user_ip(world, per_ip_limits):
    async with _client() as c:
        async def send(ip: str):
            return await c.post("/api/v2/onboarding/events", json={"event": "config_copied", "meta": {}},
                                headers={"X-Forwarded-For": ip})
        for _ in range(120):
            assert (await send("198.51.100.3")).status_code == 202
        assert (await send("198.51.100.3")).status_code == 429
        assert (await send("198.51.100.4")).status_code == 202


@pytest.mark.anyio
async def test_the_exchange_allows_several_apps_behind_one_address(world, per_ip_limits):
    """240/minute per IP: six apps asking every 1.5 s (40/minute each) behind one NAT still get through."""
    async with _client() as c:
        async def ask(ip: str):
            return await c.post("/api/v2/desktop/setup-codes/exchange", json={"code": "no-such-code-" + "x" * 20, "verifier": "v" * 43},
                                headers={"X-Forwarded-For": ip})
        for _ in range(240):
            assert (await ask("198.51.100.5")).status_code == 404
        assert (await ask("198.51.100.5")).status_code == 429
        assert (await ask("198.51.100.6")).status_code == 404


# ─── PO 16:03Z — one place works out a recipe's setup rows ──────────────────────


@pytest.mark.anyio
async def test_every_recipe_the_list_offers_confirms_with_its_own_rows(world):
    """GET /desktop/recipes hands the rows the confirmation checks with (one function): confirming every offered recipe with
    exactly those rows — a runtime for every non-human row, nothing for a human row — is never roles_invalid."""
    async with _client() as c:
        r = await c.get("/api/v2/desktop/recipes", headers=_person(OWNER))
        assert r.status_code == 200, r.text
        recipes = r.json()["recipes"]
        keys = {x["key"] for x in recipes}
        # the platform presets that make an agent are offered; signals and measurements (no flow) are not
        assert {"preset.workflow.loop_agency", "preset.workflow.two_step", "preset.marketing.blog_article"} <= keys
        assert not keys & {"preset.work.assigned", "preset.goal.measured", "preset.gate.verdict"}
        loop = next(x for x in recipes if x["key"] == "preset.workflow.loop_agency")
        assert {"role": "Human", "kind": "human"} in [{k: row[k] for k in ("role", "kind")} for row in loop["roles"]]
        assert all(row["kind"] != "human" for row in loop["roles"] if row["role"] != "Human")
        blog = next(x for x in recipes if x["key"] == "preset.marketing.blog_article")
        assert "Director" in [row["role"] for row in blog["roles"] if row["kind"] == "human"]

        for recipe in recipes:
            code, _verifier = await _code(c, f"d4424 recipe {recipe['key']}"[:80])
            body = {
                "project_id": str(PROJ), "recipe_id": recipe["id"],
                "roles": [{"role": row["role"], "runtime": "claude"} for row in recipe["roles"] if row["kind"] != "human"],
            }
            res = await _confirm(c, code, body=body)
            assert res.status_code in (200, 201), (recipe["key"], res.text)
            confirmed = res.json()
            # every row became a member, the human rows bound to the person
            assert {m["role"] for m in confirmed["members"]} == {row["role"] for row in recipe["roles"]}, recipe["key"]
            assert all(m["kind"] == "human" for m in confirmed["members"] if m["role"] in {row["role"] for row in recipe["roles"] if row["kind"] == "human"})


@pytest.mark.anyio
async def test_the_recipe_list_is_for_people_of_the_org(world):
    async with _client() as c:
        assert (await c.get("/api/v2/desktop/recipes", headers=_person(PLAIN))).status_code == 200  # any member may look
        assert str(RECIPE) in {x["id"] for x in (await c.get("/api/v2/desktop/recipes", headers=_person(OWNER))).json()["recipes"]}
        # a recipe whose every role is a person makes no agent on this device — not offered (a copy of RECIPE, all human)
        people_only = uuid.uuid4()
        await _sql(
            "INSERT INTO event_definitions (id,key,org_id,name,description,payload_schema,routing,block_template,stage_metadata,"
            "role_actor_kinds,enabled,version) "
            f"SELECT '{people_only}', key || '.people_only', org_id, name || ' (people)', description, payload_schema, routing, "
            "block_template, stage_metadata, (SELECT jsonb_object_agg(v->>'role', 'human') FROM jsonb_each(stage_metadata) AS e(k, v) "
            f"WHERE v ? 'role'), enabled, version FROM event_definitions WHERE id='{RECIPE}'"
        )
        offered = {x["id"] for x in (await c.get("/api/v2/desktop/recipes", headers=_person(OWNER))).json()["recipes"]}
        assert str(RECIPE) in offered and str(people_only) not in offered
        other = (await c.get("/api/v2/desktop/recipes", headers=_person(OUTSIDER, ORG2))).json()["recipes"]
        assert str(RECIPE) not in {x["id"] for x in other}  # another org's own recipe is not offered


# ─── Qadir 4834 · PO 05:21Z ⒜ — an either row takes «me»; the recipe list says whose recipe it is ────────────────


async def _preset(key: str) -> tuple[str, dict]:
    rows = await _sql(fetch=f"SELECT id, role_actor_kinds FROM event_definitions WHERE key='{key}' AND org_id IS NULL")
    assert rows, f"the migrated DB carries {key}"
    return str(rows[0][0]), rows[0][1]


@pytest.mark.anyio
async def test_an_either_row_chosen_as_me_is_the_person_and_the_other_rows_stay_agents(world):
    recipe_id, kinds = await _preset("preset.workflow.two_step")
    assert kinds == {"Maker": "either", "Reviewer": "either"}  # the shape this test relies on
    before = await _counts()
    async with _client() as c:
        code, _verifier = await _code(c, "d4424 either me")
        body = {"project_id": str(PROJ), "recipe_id": recipe_id,
                "roles": [{"role": "Maker", "owner": "me"}, {"role": "Reviewer", "runtime": "codex"}]}
        r = await _confirm(c, code, body=body)
        assert r.status_code == 200, r.text
        by_role: dict[str, set] = {}
        for m in r.json()["members"]:
            by_role.setdefault(m["role"], set()).add((m["kind"], m["member_id"]))
        assert by_role["Maker"] == {("human", str(OWNER_TM))}, "the person holds the Maker row"
        assert len(by_role["Reviewer"]) == 1 and next(iter(by_role["Reviewer"]))[0] == "agent"
    assert (await _counts())["agents"] == before["agents"] + 1  # one agent — for Reviewer only


@pytest.mark.anyio
async def test_the_setup_row_rules_for_me_and_runtime(world):
    two_step, _ = await _preset("preset.workflow.two_step")
    loop, kinds = await _preset("preset.workflow.loop_agency")
    assert kinds["Agent"] == "agent" and kinds["Human"] == "human"
    before = await _counts()
    async with _client() as c:
        code, _verifier = await _code(c, "d4424 row rules")
        # every row the person's → no agent to start: no_agent_role, nothing made
        r = await _confirm(c, code, body={"project_id": str(PROJ), "recipe_id": two_step,
                                          "roles": [{"role": "Maker", "owner": "me"}, {"role": "Reviewer", "owner": "me"}]})
        assert (r.status_code, r.json()["error"]["code"]) == (422, "no_agent_role"), r.text
        # «me» on an agent row · a human row sent as «me» → roles_invalid
        agent_rows = [{"role": role, "runtime": "claude"} for role, k in kinds.items() if k != "human"]
        for roles in (
            [{"role": "Agent", "owner": "me"}] + [x for x in agent_rows if x["role"] != "Agent"],
            agent_rows + [{"role": "Human", "owner": "me"}],
        ):
            r = await _confirm(c, code, body={"project_id": str(PROJ), "recipe_id": loop, "roles": roles})
            assert (r.status_code, r.json()["error"]["code"]) == (422, "roles_invalid"), roles
        # PO 06:04Z — every body defect is a closed code the web can read (never a generic 422 whose `loc` says «roles»):
        # both runtime and «me» · neither · a runtime the app does not have · an owner other than «me» · a repeated role
        reviewer = {"role": "Reviewer", "runtime": "codex"}
        for roles in (
            [{"role": "Maker", "runtime": "claude", "owner": "me"}, reviewer],
            [{"role": "Maker"}, reviewer],
            [{"role": "Maker", "runtime": "vim"}, reviewer],
            [{"role": "Maker", "owner": "you"}, reviewer],
            [{"role": "Maker", "runtime": "claude"}, reviewer, {"role": "Maker", "runtime": "claude"}],
        ):
            r = await _confirm(c, code, body={"project_id": str(PROJ), "recipe_id": two_step, "roles": roles})
            assert (r.status_code, r.json()["error"]["code"]) == (422, "roles_invalid"), roles
        # the product's limits: more than 50 rows · a role name over 200 characters → recipe_too_large
        for roles in (
            [{"role": f"Role{i}", "runtime": "claude"} for i in range(51)],
            [{"role": "M" * 201, "runtime": "claude"}, reviewer],
        ):
            r = await _confirm(c, code, body={"project_id": str(PROJ), "recipe_id": two_step, "roles": roles})
            assert (r.status_code, r.json()["error"]["code"]) == (422, "recipe_too_large"), len(roles)
        # beyond the abuse caps the schema itself refuses (generous — no product rule lives there)
        r = await _confirm(c, code, body={"project_id": str(PROJ), "recipe_id": two_step,
                                          "roles": [{"role": "x", "runtime": "claude"}] * 501})
        assert r.status_code == 422
    assert await _counts() == before, "nothing was made by a refused confirmation"


@pytest.mark.anyio
async def test_the_recipe_list_says_whose_recipe_it_is(world):
    async with _client() as c:
        recipes = (await c.get("/api/v2/desktop/recipes", headers=_person(OWNER))).json()["recipes"]
    by_id = {x["id"]: x for x in recipes}
    assert by_id[str(RECIPE)]["org_id"] == str(ORG), "the org's own recipe"
    presets = [x for x in recipes if x["key"].startswith("preset.")]
    assert presets and all(x["org_id"] is None for x in presets), "a platform preset has no org"
