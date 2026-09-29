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
    "writer": {"label": "Writer"},
    "reviewer": {"label": "Reviewer"},
    "approver": {"label": "Approver"},
    "publisher": {"label": "Publisher", "capability": {"kind": "publish", "target": "channel_connection"}},
}
KINDS = {"approver": "human"}


@pytest.fixture
def anyio_backend():
    return "asyncio"


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
    f"DELETE FROM agent_api_keys WHERE team_member_id IN (SELECT id FROM members WHERE org_id IN ('{ORG}','{ORG2}'))",
    f"DELETE FROM desktop_setups WHERE org_id IN ('{ORG}','{ORG2}') OR device_name LIKE 'd4424%'",
    f"DELETE FROM recipe_role_bindings WHERE org_id IN ('{ORG}','{ORG2}')",
    f"DELETE FROM event_definitions WHERE id='{RECIPE}'",
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
        f"('{RECIPE}','{RECIPE_KEY}','{ORG}','Desktop recipe','d4424',CAST(:ps AS jsonb),CAST(:r AS jsonb),CAST(:bt AS jsonb),"
        "CAST(:sm AS jsonb),CAST(:rak AS jsonb),true,1)",
        params={"ps": "{}", "r": "{}", "bt": "{}", "sm": json.dumps(STAGES), "rak": json.dumps(KINDS)},
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
    return r.json()["code"], verifier


_ROLES = {"project_id": str(PROJ), "recipe_id": str(RECIPE), "roles": [{"stage": "writer", "runtime": "claude"}, {"stage": "reviewer", "runtime": "codex"}]}


async def _confirm(c, code: str, who: uuid.UUID = OWNER, org: uuid.UUID = ORG, body: dict | None = None):
    return await c.post(f"/api/v2/desktop/setup-codes/{code}/confirm", json=body or _ROLES, headers=_person(who, org))


async def _exchange(c, code: str, verifier: str):
    return await c.post(f"/api/v2/desktop/setup-codes/{code}/exchange", json={"verifier": verifier})


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
        assert members["approver"] == {"stage": "approver", "member_id": str(OWNER_TM), "kind": "human"}
        assert members["writer"]["kind"] == members["reviewer"]["kind"] == "agent"
        assert "api_key" not in r.text  # the confirmation never carries a key

        r = await _exchange(c, code, verifier)
        assert r.status_code == 200, r.text
        body = r.json()
        assert body["setup_id"] == str((await _sql(fetch=f"SELECT id FROM desktop_setups WHERE org_id='{ORG}'"))[0][0])
        agents = {a["stage"]: a for a in body["agents"]}
        assert set(agents) == {"writer", "reviewer"}
        assert (agents["writer"]["runtime"], agents["reviewer"]["runtime"]) == ("claude", "codex")
        assert agents["writer"]["member_id"] == members["writer"]["member_id"]
        assert all(a["api_key"].startswith("sk_live_") for a in agents.values())
        assert "api_url" in body and "mcp_url" in body

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
        assert (await _confirm(c, code)).status_code == 200
        assert (await _confirm(c, code)).status_code == 409  # a second confirmation makes nothing
        assert (await _exchange(c, code, verifier)).status_code == 200

        # expired: 10 minutes after the code was made
        code2, verifier2 = await _code(c, "d4424 expired")
        await _sql(f"UPDATE desktop_setups SET expires_at = now() - interval '1 second' WHERE device_name='d4424 expired'")
        assert (await _exchange(c, code2, verifier2)).status_code == 410
        assert (await _confirm(c, code2)).status_code == 410

        # a runtime the app does not have, a stage that is a person's or a channel's, a missing agent stage
        code3, _ = await _code(c, "d4424 roles")
        for roles in (
            [{"stage": "writer", "runtime": "claude"}],  # reviewer missing
            [{"stage": "writer", "runtime": "claude"}, {"stage": "reviewer", "runtime": "codex"}, {"stage": "approver", "runtime": "claude"}],
            [{"stage": "writer", "runtime": "claude"}, {"stage": "reviewer", "runtime": "codex"}, {"stage": "publisher", "runtime": "claude"}],
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
        r = await c.post(f"/api/v2/desktop/setup-codes/{code2}/confirm", json=_ROLES, headers={"Authorization": f"Bearer {key}"})
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

    # AC6: who · which device · how many · when handed · when cut
    row = (await _sql(fetch=(
        "SELECT confirmed_by, device_name, jsonb_array_length(members), keys_issued, exchanged_at IS NOT NULL, revoked_by,"
        f" revoked_at IS NOT NULL FROM desktop_setups WHERE id='{setup_id}'"
    )))[0]
    assert row == (OWNER, "d4424 laptop", 3, 2, True, OWNER, True)
