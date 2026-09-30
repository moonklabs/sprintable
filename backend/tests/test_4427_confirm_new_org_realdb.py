"""story 4427 (나) · design doc 9a4cb445 (Qadir lens + PO 02:57Z) — «시작» on the desktop setup page for a person with no
organization: `POST /desktop/setup-codes/confirm-new-org` makes the organization, its first project and the setup in one
transaction, and `GET /desktop/recipes/for-new-org` lists what such a person can start. Real HTTP on a migrated PG.

Pinned:
- the whole way: presets only · a new organization named as sent · the person its owner · the setup confirmed into it ·
  the exchange's `org_name` is the new organization's name · no organization-only field in either answer;
- a replay by the same person returns what that code made (the confirmation row's org_id · project_id), nothing made twice;
- refusals, with nothing made: an organization already (409) · a membership they left does not count · a pending invite to
  the verified e-mail (409) · an unverified e-mail (403, before the lock and the checks) · an agent key (403) · an org field
  in the body (422, extra=forbid) · the per-person limits (429);
- no half: a failure after the organization, after the project, on the second agent, on the recipe, on the first publish
  leaves nothing (read back on a new connection), and the same code confirms fine afterwards;
- the three first-organization paths (this one · accepting an invite · POST /organizations) wait on the same per-person lock,
  and an invite accepted in another tab leaves the person with one organization.
"""
from __future__ import annotations

import asyncio
import base64
import hashlib
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

DEVICE = "d4427na laptop"


@pytest.fixture
def anyio_backend():
    return "asyncio"


@pytest.fixture(autouse=True)
def _addresses(monkeypatch):
    monkeypatch.setenv("MCP_PUBLIC_URL", "https://mcp.d4427na.test/mcp")
    monkeypatch.setenv("FASTAPI_URL", "https://api.d4427na.test")


@pytest.fixture(autouse=True)
def _fresh_person_limits():
    from app.core.rate_limit import reset_person_limits

    reset_person_limits()
    yield
    reset_person_limits()


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


class World:
    """Fresh people per test; cleanup removes every organization they ended up in (and the ones the test made)."""

    def __init__(self):
        self.users: list[uuid.UUID] = []
        self.orgs: list[uuid.UUID] = []

    async def person(self, *, verified: bool = True, name: str | None = "김지우") -> uuid.UUID:
        uid = uuid.uuid4()
        self.users.append(uid)
        await _sql(
            "INSERT INTO users (id,email,hashed_password,display_name,is_active,email_verified,login_fail_count,totp_enabled,"
            "totp_fail_count) VALUES (:id,:email,'x',:name,true,:v,0,false,0)",
            params={"id": str(uid), "email": f"na-{uid.hex[:10]}@d4427na.test", "name": name, "v": verified},
        )
        return uid

    async def org_with(self, member: uuid.UUID | None = None, *, left: bool = False) -> uuid.UUID:
        oid = uuid.uuid4()
        self.orgs.append(oid)
        await _sql(f"INSERT INTO organizations (id,name,slug,plan) VALUES ('{oid}','Other {oid.hex[:6]}','na-{oid.hex[:12]}','free')")
        if member is not None:
            await _sql(
                "INSERT INTO org_members (id,org_id,user_id,role,deleted_at) VALUES (gen_random_uuid(),:o,:u,'owner',"
                + ("now()" if left else "NULL") + ")",
                params={"o": str(oid), "u": str(member)},
            )
        return oid

    async def cleanup(self):
        if not self.users and not self.orgs:
            return
        users = ",".join(f"'{u}'" for u in self.users) or "NULL"
        rows = await _sql(fetch=f"SELECT DISTINCT org_id FROM org_members WHERE user_id IN ({users})")
        orgs = {str(r[0]) for r in rows} | {str(o) for o in self.orgs}
        o = ",".join(f"'{x}'" for x in orgs) or "NULL"
        await _sql(
            f"DELETE FROM agent_run_tool_calls WHERE org_id IN ({o})",
            f"DELETE FROM onboarding_events WHERE session_id IN (SELECT id FROM desktop_setups WHERE device_name='{DEVICE}')",
            f"DELETE FROM agent_api_keys WHERE team_member_id IN (SELECT id FROM members WHERE org_id IN ({o}))",
            f"DELETE FROM desktop_setups WHERE device_name='{DEVICE}' OR org_id IN ({o})",
            f"DELETE FROM recipe_role_bindings WHERE org_id IN ({o})",
            f"DELETE FROM conversation_messages WHERE conversation_id IN (SELECT id FROM conversations WHERE org_id IN ({o}))",
            f"DELETE FROM conversation_participants WHERE conversation_id IN (SELECT id FROM conversations WHERE org_id IN ({o}))",
            f"DELETE FROM conversations WHERE org_id IN ({o})",
            f"DELETE FROM stories WHERE project_id IN (SELECT id FROM projects WHERE org_id IN ({o}))",
            f"DELETE FROM event_definitions WHERE org_id IN ({o})",
            f"DELETE FROM notification_preferences WHERE member_id IN (SELECT id FROM members WHERE org_id IN ({o}))",
            f"DELETE FROM agent_message_allowlist WHERE agent_member_id IN (SELECT id FROM members WHERE org_id IN ({o}))",
            f"DELETE FROM agent_project_profiles WHERE project_id IN (SELECT id FROM projects WHERE org_id IN ({o}))",
            f"DELETE FROM project_access WHERE project_id IN (SELECT id FROM projects WHERE org_id IN ({o}))",
            f"DELETE FROM org_invites WHERE organization_id IN ({o})",
            f"DELETE FROM members WHERE org_id IN ({o})",
            f"DELETE FROM projects WHERE org_id IN ({o})",
            f"DELETE FROM org_members WHERE org_id IN ({o}) OR user_id IN ({users})",
            f"DELETE FROM participation_role WHERE org_id IN ({o})",
            f"DELETE FROM organizations WHERE id IN ({o})",
            f"DELETE FROM users WHERE id IN ({users})",
        )


@pytest.fixture
async def world():
    w = World()
    await _sql(f"DELETE FROM desktop_setups WHERE device_name='{DEVICE}'")
    yield w
    await w.cleanup()


def _client():
    from httpx import ASGITransport, AsyncClient

    from app.main import app

    return AsyncClient(transport=ASGITransport(app=app, raise_app_exceptions=False), base_url="http://test")


def _person(user_id: uuid.UUID, org_id: uuid.UUID | None = None) -> dict:
    """A person's session. No X-Org-Id for someone without an organization (their token carries none either)."""
    from app.core.security import create_access_token

    h = {"Authorization": f"Bearer {create_access_token(user_id=str(user_id))}"}
    if org_id is not None:
        h["X-Org-Id"] = str(org_id)
    return h


def _pkce() -> tuple[str, str]:
    verifier = base64.urlsafe_b64encode(secrets.token_bytes(32)).rstrip(b"=").decode()
    challenge = base64.urlsafe_b64encode(hashlib.sha256(verifier.encode()).digest()).rstrip(b"=").decode()
    return verifier, challenge


async def _code(c) -> tuple[str, str]:
    verifier, challenge = _pkce()
    r = await c.post("/api/v2/desktop/setup-codes", json={"challenge": challenge, "device_name": DEVICE})
    assert r.status_code == 201, r.text
    return r.json()["code"], verifier


async def _preset_body(c, who: uuid.UUID) -> dict:
    """The first preset the new-org list offers, with a runtime for each row that needs one (as the setup page sends it)."""
    r = await c.get("/api/v2/desktop/recipes/for-new-org", headers=_person(who))
    assert r.status_code == 200, r.text
    recipe = r.json()["recipes"][0]
    roles = [{"role": row["role"], "runtime": "claude"} for row in recipe["roles"] if row["kind"] != "human"]
    return {"recipe_id": recipe["id"], "roles": roles}


ORG_NAME = f"지우 팀 {uuid.uuid4().hex[:8]}"  # unique per run: the «nothing made» checks count organizations by this name


async def _confirm_new(c, code: str, who: uuid.UUID, body: dict, *, org_name=ORG_NAME, project_name="첫 프로젝트", extra=None):
    return await c.post(
        "/api/v2/desktop/setup-codes/confirm-new-org",
        json={**body, "code": code, "org_name": org_name, "project_name": project_name, **(extra or {})},
        headers=_person(who),
    )


async def _nothing_made(who: uuid.UUID, org_name: str) -> dict:
    """Read back on a new connection."""
    rows = await _sql(fetch=(
        "SELECT "
        "(SELECT count(*) FROM org_members WHERE user_id=:u AND deleted_at IS NULL),"
        "(SELECT count(*) FROM organizations WHERE name=:n),"
        "(SELECT count(*) FROM desktop_setups WHERE device_name=:d AND confirmed_at IS NOT NULL)"
    ), params={"u": str(who), "n": org_name, "d": DEVICE})
    memberships, orgs, confirmed = rows[0]
    return {"memberships": memberships, "orgs_named": orgs, "confirmed_setups": confirmed}


NOTHING = {"memberships": 0, "orgs_named": 0, "confirmed_setups": 0}


# ─── the whole way ────────────────────────────────────────────────────────────


@pytest.mark.anyio
async def test_a_person_without_an_organization_starts_a_setup_and_owns_the_new_organization(world):
    from app.routers.desktop_setup import ConfirmNewOrgResponse, SetupRecipe

    who = await world.person()
    async with _client() as c:
        listed = await c.get("/api/v2/desktop/recipes/for-new-org", headers=_person(who))
        assert listed.status_code == 200, listed.text
        assert set(listed.json()) == {"recipes"} and listed.json()["recipes"], "the migrated presets are offered"
        for recipe in listed.json()["recipes"]:
            assert set(recipe) == set(SetupRecipe.model_fields), "no organization-only field (bindings · channel connections)"
        code, verifier = await _code(c)
        body = await _preset_body(c, who)
        r = await _confirm_new(c, code, who, body)
        assert r.status_code == 200, r.text
        got = r.json()
        assert set(got) == set(ConfirmNewOrgResponse.model_fields)
        org_id, project_id = got["org_id"], got["project_id"]

        row = (await _sql(fetch="SELECT o.name, o.slug, m.role FROM organizations o JOIN org_members m ON m.org_id=o.id "
                                "WHERE o.id=:o AND m.user_id=:u AND m.deleted_at IS NULL", params={"o": org_id, "u": str(who)}))[0]
        assert row[0] == ORG_NAME and row[2] == "owner"
        import re
        assert re.fullmatch(r"[a-z0-9]+(-[a-z0-9]+)*", row[1]), f"the server made a valid slug: {row[1]}"
        assert (await _sql(fetch="SELECT name, org_id FROM projects WHERE id=:p", params={"p": project_id}))[0] == ("첫 프로젝트", uuid.UUID(org_id))
        setup = (await _sql(fetch="SELECT org_id, project_id, confirmed_by FROM desktop_setups WHERE id=:s", params={"s": got["setup_id"]}))[0]
        assert setup == (uuid.UUID(org_id), uuid.UUID(project_id), who)

        exchanged = await c.post("/api/v2/desktop/setup-codes/exchange", json={"code": code, "verifier": verifier})
        assert exchanged.status_code == 200, exchanged.text
        assert exchanged.json()["org_name"] == ORG_NAME


@pytest.mark.anyio
async def test_the_same_person_confirming_the_same_code_again_gets_what_it_made_and_nothing_twice(world):
    who = await world.person()
    async with _client() as c:
        code, _ = await _code(c)
        body = await _preset_body(c, who)
        first = await _confirm_new(c, code, who, body)
        assert first.status_code == 200, first.text
        again = await _confirm_new(c, code, who, body, org_name="다른 이름")
        assert again.status_code == 200, again.text
        for k in ("setup_id", "org_id", "project_id", "work_item_id"):
            assert again.json()[k] == first.json()[k]
    assert (await _nothing_made(who, "다른 이름"))["orgs_named"] == 0
    assert (await _sql(fetch="SELECT count(*) FROM org_members WHERE user_id=:u", params={"u": str(who)}))[0][0] == 1


# ─── refusals ─────────────────────────────────────────────────────────────────


@pytest.mark.anyio
async def test_a_person_with_an_organization_is_refused_on_both_routes_and_nothing_is_made(world):
    who = await world.person()
    other = await world.org_with(who)
    async with _client() as c:
        r = await c.get("/api/v2/desktop/recipes/for-new-org", headers=_person(who, other))
        assert (r.status_code, r.json()["error"]["code"]) == (409, "has_organization")
        code, _ = await _code(c)
        body = await _preset_body(c, await world.person())  # a preset id and rows, read by someone without an org
        r = await _confirm_new(c, code, who, body)
        assert (r.status_code, r.json()["error"]["code"]) == (409, "has_organization")
    assert (await _nothing_made(who, ORG_NAME))["orgs_named"] == 0


@pytest.mark.anyio
async def test_a_membership_the_person_left_does_not_count_as_an_organization(world):
    who = await world.person()
    await world.org_with(who, left=True)  # PO 02:57Z §6-1: only deleted_at rows → no organization → may make a new one
    async with _client() as c:
        code, _ = await _code(c)
        r = await _confirm_new(c, code, who, await _preset_body(c, who))
        assert r.status_code == 200, r.text


@pytest.mark.anyio
async def test_a_pending_invite_to_the_verified_email_refuses_and_nothing_is_made(world):
    who = await world.person()
    inviter = await world.org_with()
    email = (await _sql(fetch="SELECT email FROM users WHERE id=:u", params={"u": str(who)}))[0][0]
    await _sql(
        "INSERT INTO org_invites (id,organization_id,email,role,token,status,expires_at,created_at) VALUES "
        "(gen_random_uuid(),:o,:e,'member',:t,'pending',now() + interval '3 days',now())",
        params={"o": str(inviter), "e": email, "t": secrets.token_urlsafe(24)},
    )
    async with _client() as c:
        code, _ = await _code(c)
        r = await _confirm_new(c, code, who, await _preset_body(c, who))
        assert (r.status_code, r.json()["error"]["code"]) == (409, "pending_invites")
    assert await _nothing_made(who, ORG_NAME) == NOTHING


@pytest.mark.anyio
async def test_an_unverified_email_is_refused_before_the_lock_and_the_checks(world, monkeypatch):
    from app.core.config import settings

    who = await world.person(verified=False)
    await world.org_with(who)  # would be 409 has_organization if the checks ran first
    taken = {"lock": 0}

    async def lock(*_a, **_kw):
        taken["lock"] += 1

    monkeypatch.setattr(settings, "require_verified_email_for_org_create", True)
    monkeypatch.setattr("app.services.org_project_create.lock_first_org_path", lock)
    async with _client() as c:
        code, _ = await _code(c)
        body = await _preset_body(c, await world.person())
        r = await _confirm_new(c, code, who, body)
        assert (r.status_code, r.json()["error"]["code"]) == (403, "EMAIL_VERIFICATION_REQUIRED")
    assert taken["lock"] == 0


@pytest.mark.anyio
async def test_the_body_cannot_name_an_organization_or_a_project(world):
    who = await world.person()
    other = await world.org_with()
    async with _client() as c:
        code, _ = await _code(c)
        body = await _preset_body(c, who)
        for extra in ({"org_id": str(other)}, {"project_id": str(uuid.uuid4())}):
            r = await _confirm_new(c, code, who, body, extra=extra)
            assert r.status_code == 422, r.text
        for blank in (" ", "\t"):
            assert (await _confirm_new(c, code, who, body, org_name=blank)).status_code == 422
    assert await _nothing_made(who, ORG_NAME) == NOTHING


@pytest.mark.anyio
async def test_an_agent_key_is_refused_on_both_new_routes():
    from fastapi import HTTPException

    from app.dependencies.auth import AuthContext
    from app.routers.desktop_setup import get_setup_recipes_for_new_org, post_confirm_new_org

    agent = AuthContext(user_id=str(uuid.uuid4()), email=None, claims={"app_metadata": {"api_key_id": "k", "org_id": str(uuid.uuid4())}})
    with pytest.raises(HTTPException) as e:
        await get_setup_recipes_for_new_org(db=None, auth=agent)
    assert (e.value.status_code, e.value.detail["code"]) == (403, "person_session_required")
    with pytest.raises(HTTPException) as e:
        await post_confirm_new_org(body=None, background_tasks=None, db=None, auth=agent)
    assert (e.value.status_code, e.value.detail["code"]) == (403, "person_session_required")


@pytest.mark.anyio
async def test_the_per_person_limits(world):
    who = await world.person()
    someone_else = await world.person()
    async with _client() as c:
        body = await _preset_body(c, who)
        # 3/hour on the way an organization is made: the fourth call is refused whatever it carries
        for _ in range(3):
            await _confirm_new(c, "x" * 40, who, body)  # a made-up code: 404, but counted
        r = await _confirm_new(c, "x" * 40, who, body)
        assert (r.status_code, r.json()["error"]["code"]) == (429, "RATE_LIMITED")
        assert int(r.headers["retry-after"]) > 0
        assert (await _confirm_new(c, "x" * 40, someone_else, body)).status_code == 404, "another person has their own count"
        # 60/minute on the read
        for _ in range(59):  # _preset_body already read once
            assert (await c.get("/api/v2/desktop/recipes/for-new-org", headers=_person(who))).status_code == 200
        r = await c.get("/api/v2/desktop/recipes/for-new-org", headers=_person(who))
        assert (r.status_code, r.json()["error"]["code"]) == (429, "RATE_LIMITED")


# ─── presets only ─────────────────────────────────────────────────────────────


@pytest.mark.anyio
async def test_the_new_org_list_never_shows_an_organizations_own_recipe(world):
    import json

    owner = await world.person()
    org = await world.org_with(owner)
    await _sql(f"INSERT INTO members (id,org_id,user_id,type,name,is_active) SELECT id,org_id,user_id,'human','O',true FROM org_members WHERE org_id='{org}'")
    own = uuid.uuid4()
    schema = json.dumps({"type": "object", "properties": {"stage": {"type": "string", "enum": ["writer"]}}})
    await _sql(
        "INSERT INTO event_definitions (id,key,org_id,name,description,payload_schema,routing,block_template,stage_metadata,"
        "role_actor_kinds,enabled,version) VALUES (:id,:key,:org,'Org own recipe','d4427na',CAST(:ps AS jsonb),"
        "CAST(:r AS jsonb),CAST('{}' AS jsonb),CAST(:sm AS jsonb),CAST('{}' AS jsonb),true,1)",
        params={"id": str(own), "key": f"org.na-{own.hex[:8]}.own", "org": str(org), "ps": schema,
                "r": json.dumps({"escalation": {"kind": "server_derived", "target": "none"}, "broadcast": {"kind": "recipe_role_binding"}}),
                "sm": json.dumps({"writer": {"role": "Writer"}})},
    )
    newcomer = await world.person()
    async with _client() as c:
        # positive control: the organization's own person sees it on the usual list
        mine = await c.get("/api/v2/desktop/recipes", headers=_person(owner, org))
        assert mine.status_code == 200, mine.text
        assert str(own) in {r["id"] for r in mine.json()["recipes"]}
        fresh = await c.get("/api/v2/desktop/recipes/for-new-org", headers=_person(newcomer))
        assert fresh.status_code == 200
        ids = {r["id"] for r in fresh.json()["recipes"]}
        assert str(own) not in ids
        presets = {str(r[0]) for r in await _sql(fetch="SELECT id FROM event_definitions WHERE org_id IS NULL")}
        assert ids <= presets
        # the rows are the same function's as the usual list's (the preset entries of both lists are identical)
        usual = {r["id"]: r for r in mine.json()["recipes"] if r["id"] in ids}
        assert usual == {r["id"]: r for r in fresh.json()["recipes"]}


# ─── no half ──────────────────────────────────────────────────────────────────


def _raise_setup_error(*_a, **_kw):
    from app.services.desktop_setup import DesktopSetupError

    raise DesktopSetupError("request_invalid", "sentinel")


@pytest.mark.anyio
@pytest.mark.parametrize("where", ["after_org", "after_project", "second_agent", "recipe", "first_publish"])
async def test_a_failure_anywhere_leaves_nothing_and_the_code_confirms_afterwards(world, monkeypatch, where):
    from fastapi import HTTPException

    from app.core.config import settings

    who = await world.person()
    async with _client() as c:
        code, verifier = await _code(c)
        body = await _preset_body(c, who)
        if where == "after_org":
            async def fail(*_a, **_kw):
                _raise_setup_error()
            monkeypatch.setattr("app.services.org_project_create.create_project_with_member", fail)
        elif where == "after_project":
            async def fail(*_a, **_kw):
                _raise_setup_error()
            monkeypatch.setattr("app.services.desktop_setup.confirm_setup", fail)
        elif where == "second_agent":
            if len(body["roles"]) < 2:
                pytest.skip("the first preset has fewer than two agent rows")
            calls = {"n": 0}

            async def limit(_db, _org):
                calls["n"] += 1
                if calls["n"] == 2:
                    raise HTTPException(status_code=402, detail={"code": "PLAN_LIMIT_EXCEEDED"})

            monkeypatch.setattr(type(settings), "is_ee_enabled", property(lambda _self: True))
            monkeypatch.setattr("ee.plan_limits.check_agent_add_limit", limit)
            monkeypatch.setattr("ee.plan_limits.check_org_create_limit", lambda *_a, **_kw: asyncio.sleep(0))
            monkeypatch.setattr("ee.plan_limits.check_project_create_limit", lambda *_a, **_kw: asyncio.sleep(0))
        elif where == "recipe":
            body = {**body, "recipe_id": str(uuid.uuid4())}
        elif where == "first_publish":
            async def refuse(*_a, **_kw):
                raise HTTPException(status_code=409, detail={"code": "sentinel_publish_refused", "message": "sentinel"})
            monkeypatch.setattr("app.routers.events._publish_registry_event_core", refuse)

        r = await _confirm_new(c, code, who, body)
        assert r.status_code >= 400, r.text
        assert await _nothing_made(who, ORG_NAME) == NOTHING, f"half left after a failure {where}"
        assert (await c.post("/api/v2/desktop/setup-codes/exchange", json={"code": code, "verifier": verifier})).status_code == 202
        monkeypatch.undo()
        body = await _preset_body(c, who)
        again = await _confirm_new(c, code, who, body)
        assert again.status_code == 200, again.text


# ─── one lock on every first-organization path ────────────────────────────────


async def _holding_person_lock(who: uuid.UUID):
    """A separate connection that takes the person's lock and keeps it until `release` is set."""
    eng = create_async_engine(_ASYNC, poolclass=NullPool)
    conn = await eng.connect()
    tx = await conn.begin()
    await conn.execute(text("SELECT pg_advisory_xact_lock(hashtextextended(:u, 0))"), {"u": str(who)})
    return eng, conn, tx


async def _someone_waits_on_an_advisory_lock(ms: int = 10000) -> bool:
    """Condition wait: a backend is blocked on an advisory lock (not a fixed sleep)."""
    loop = asyncio.get_running_loop()
    deadline = loop.time() + ms / 1000
    while loop.time() < deadline:
        n = (await _sql(fetch="SELECT count(*) FROM pg_locks WHERE locktype='advisory' AND NOT granted"))[0][0]
        if n:
            return True
        await asyncio.sleep(0.02)
    return False


@pytest.mark.anyio
@pytest.mark.parametrize("path", ["confirm_new_org", "accept_invite", "post_organizations"])
async def test_every_first_organization_path_waits_on_the_same_person_lock(world, path):
    who = await world.person()
    inviter = await world.org_with()
    email = (await _sql(fetch="SELECT email FROM users WHERE id=:u", params={"u": str(who)}))[0][0]
    token = secrets.token_urlsafe(24)
    async with _client() as c:
        code, _ = await _code(c)
        body = await _preset_body(c, who)
        if path == "accept_invite":
            await _sql(
                "INSERT INTO org_invites (id,organization_id,email,role,token,status,expires_at,created_at) VALUES "
                "(gen_random_uuid(),:o,:e,'member',:t,'pending',now() + interval '3 days',now())",
                params={"o": str(inviter), "e": email, "t": token},
            )
        eng, conn, tx = await _holding_person_lock(who)
        try:
            if path == "confirm_new_org":
                call = asyncio.create_task(_confirm_new(c, code, who, body))
            elif path == "accept_invite":
                call = asyncio.create_task(c.post("/api/v2/invites/accept", json={"token": token}, headers=_person(who)))
            else:
                call = asyncio.create_task(c.post("/api/v2/organizations", json={"name": "Lock check"}, headers=_person(who)))
            assert await _someone_waits_on_an_advisory_lock(), f"{path} did not wait on the person's lock"
            assert not call.done()
        finally:
            await tx.rollback()
            await conn.close()
            await eng.dispose()
        r = await call
        assert r.status_code in (200, 201), r.text


@pytest.mark.anyio
async def test_an_invite_accepted_in_another_tab_leaves_one_organization(world):
    who = await world.person()
    inviter = await world.org_with()
    email = (await _sql(fetch="SELECT email FROM users WHERE id=:u", params={"u": str(who)}))[0][0]
    token = secrets.token_urlsafe(24)
    await _sql(
        "INSERT INTO org_invites (id,organization_id,email,role,token,status,expires_at,created_at) VALUES "
        "(gen_random_uuid(),:o,:e,'member',:t,'pending',now() + interval '3 days',now())",
        params={"o": str(inviter), "e": email, "t": token},
    )
    async with _client() as c:
        code, _ = await _code(c)
        body = await _preset_body(c, who)
        results = await asyncio.gather(
            c.post("/api/v2/invites/accept", json={"token": token}, headers=_person(who)),
            _confirm_new(c, code, who, body),
        )
    accepted, confirmed = results
    assert accepted.status_code == 200, accepted.text
    assert confirmed.status_code == 409 and confirmed.json()["error"]["code"] in ("has_organization", "pending_invites")
    rows = await _sql(fetch="SELECT org_id FROM org_members WHERE user_id=:u AND deleted_at IS NULL", params={"u": str(who)})
    assert [r[0] for r in rows] == [inviter]


# ─── the slug race inside the whole confirmation (PO 04:54Z) ──────────────────


@pytest.mark.anyio
async def test_a_slug_race_retried_inside_the_confirmation_still_makes_everything(world):
    """The SAVEPOINT roll-back happens in the middle of the confirmation's one transaction (code lock · the new
    organization · then the project, agents and first work item). Whatever the transaction read before the roll-back must
    still be usable after it (no expired object lazily loaded — MissingGreenlet). Forced order: another person's uncommitted
    organization holds the same derived slug; this confirmation waits on it, retries to `-2`, and finishes. Read back on a
    new connection."""
    from app.services.org_project_create import create_org_with_owner

    holder_user = await world.person()
    who = await world.person()
    name = f"Race Setup {uuid.uuid4().hex[:6]}"
    eng = create_async_engine(_ASYNC, poolclass=NullPool)
    try:
        async with _client() as c:
            code, _ = await _code(c)
            body = await _preset_body(c, who)
            async with async_sessionmaker(eng, expire_on_commit=False)() as holder:
                held = await create_org_with_owner(holder, name=name, slug=None, user_id=str(holder_user), owner_member_id=None)
                call = asyncio.create_task(_confirm_new(c, code, who, body, org_name=name))
                loop = asyncio.get_running_loop()
                deadline = loop.time() + 10
                waited = False
                while loop.time() < deadline:
                    if (await _sql(fetch="SELECT count(*) FROM pg_locks WHERE locktype='transactionid' AND NOT granted"))[0][0]:
                        waited = True
                        break
                    await asyncio.sleep(0.02)
                assert waited, "the confirmation should wait on the held organization's uncommitted row"
                assert not call.done()
                await holder.commit()
            r = await call
        assert r.status_code == 200, r.text
        got = r.json()
        rows = await _sql(fetch=(
            "SELECT o.slug, (SELECT count(*) FROM projects p WHERE p.id=:p AND p.org_id=o.id),"
            " (SELECT count(*) FROM members m WHERE m.org_id=o.id AND m.type='agent'),"
            " (SELECT count(*) FROM desktop_setups d WHERE d.id=:s AND d.org_id=o.id AND d.confirmed_at IS NOT NULL),"
            " (SELECT count(*) FROM stories st WHERE st.id=:w AND st.project_id=:p)"
            " FROM organizations o WHERE o.id=:o"
        ), params={"o": got["org_id"], "p": got["project_id"], "s": got["setup_id"], "w": got["work_item_id"]})
        slug, projects, agents, setups, stories = rows[0]
        assert slug == f"{held.slug}-2", (held.slug, slug)
        assert (projects, setups, stories) == (1, 1, 1)
        assert agents == len(body["roles"]) and agents >= 1
    finally:
        await eng.dispose()
