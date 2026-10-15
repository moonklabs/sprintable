"""story 4496 (PO 09:32Z (가)) — «시작» on the desktop setup page with no project chosen, in an organization the person runs:
`POST /desktop/setup-codes/confirm` without `project_id` makes the organization's **first** project with the setup, in one
transaction — only when the organization has no project. Real HTTP on a migrated PG.

Pinned:
- 0 projects → one project (named as sent) · the setup confirmed into it · `project_id` in the answer;
- a second press by the same person (same code) → what that code made, **no second project** (made only after the replay check);
- the organization has a project → 409 `project_required`, nothing made (the server counts — not the web's list);
- the plan's project limit → 402 PLAN_LIMIT_EXCEEDED (resource project), nothing made;
- not an organization admin → 403 `not_org_admin`, nothing made · neither a project nor a name → 422.
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

DEVICE = "d4496fp laptop"


@pytest.fixture
def anyio_backend():
    return "asyncio"


@pytest.fixture(autouse=True)
def _addresses(monkeypatch):
    monkeypatch.setenv("MCP_PUBLIC_URL", "https://mcp.d4496fp.test/mcp")
    monkeypatch.setenv("FASTAPI_URL", "https://api.d4496fp.test")


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
            params={"id": str(uid), "email": f"fp-{uid.hex[:10]}@d4496fp.test", "name": name, "v": verified},
        )
        return uid

    async def org_with(self, member: uuid.UUID | None = None, *, left: bool = False) -> uuid.UUID:
        oid = uuid.uuid4()
        self.orgs.append(oid)
        await _sql(f"INSERT INTO organizations (id,name,slug,plan) VALUES ('{oid}','Other {oid.hex[:6]}','fp-{oid.hex[:12]}','free')")
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




async def _recipe_body(c, who: uuid.UUID, org: uuid.UUID) -> dict:
    r = await c.get("/api/v2/desktop/recipes", headers=_person(who, org))
    assert r.status_code == 200, r.text
    recipe = r.json()["recipes"][0]
    roles = [{"role": row["role"], "runtime": "claude"} for row in recipe["roles"] if row["kind"] != "human"]
    return {"recipe_id": recipe["id"], "roles": roles}


async def _confirm(c, code: str, who: uuid.UUID, org: uuid.UUID, body: dict, **extra):
    return await c.post("/api/v2/desktop/setup-codes/confirm", json={**body, "code": code, **extra}, headers=_person(who, org))


async def _projects(org: uuid.UUID) -> list[tuple]:
    return await _sql(fetch="SELECT id, name FROM projects WHERE org_id=:o AND deleted_at IS NULL ORDER BY created_at", params={"o": str(org)})


async def _confirmed() -> int:
    return (await _sql(fetch="SELECT count(*) FROM desktop_setups WHERE device_name=:d AND confirmed_at IS NOT NULL", params={"d": DEVICE}))[0][0]


async def _admin_org(world, role: str = "owner") -> tuple[uuid.UUID, uuid.UUID]:
    who = await world.person()
    org = await world.org_with()
    await _sql("INSERT INTO org_members (id,org_id,user_id,role) VALUES (gen_random_uuid(),:o,:u,:r)", params={"o": str(org), "u": str(who), "r": role})
    return who, org


@pytest.mark.anyio
async def test_no_project_yet_the_setup_makes_the_first_project_and_confirms_into_it(world):
    who, org = await _admin_org(world)
    async with _client() as c:
        code, verifier = await _code(c)
        body = await _recipe_body(c, who, org)
        r = await _confirm(c, code, who, org, body, project_name="첫 프로젝트")
        assert r.status_code == 200, r.text
        made = await _projects(org)
        assert [n for _, n in made] == ["첫 프로젝트"]
        assert r.json()["project_id"] == str(made[0][0])
        setup = (await _sql(fetch="SELECT org_id, project_id, confirmed_by FROM desktop_setups WHERE id=:s", params={"s": r.json()["setup_id"]}))[0]
        assert setup == (org, made[0][0], who)
        exchanged = await c.post("/api/v2/desktop/setup-codes/exchange", json={"code": code, "verifier": verifier})
        assert exchanged.status_code == 200, exchanged.text


@pytest.mark.anyio
async def test_pressing_again_gets_what_the_code_made_and_never_a_second_project(world):
    who, org = await _admin_org(world)
    async with _client() as c:
        code, _ = await _code(c)
        body = await _recipe_body(c, who, org)
        first = await _confirm(c, code, who, org, body, project_name="첫 프로젝트")
        assert first.status_code == 200, first.text
        again = await _confirm(c, code, who, org, body, project_name="다른 이름")
        assert again.status_code == 200, again.text
        for k in ("setup_id", "project_id", "work_item_id"):
            assert again.json()[k] == first.json()[k]
    assert [n for _, n in await _projects(org)] == ["첫 프로젝트"]


@pytest.mark.anyio
async def test_an_organization_with_a_project_is_refused_project_required_and_nothing_is_made(world):
    who, org = await _admin_org(world)
    await _sql("INSERT INTO projects (id,org_id,name) VALUES (gen_random_uuid(),:o,'있는 프로젝트')", params={"o": str(org)})
    async with _client() as c:
        code, _ = await _code(c)
        body = await _recipe_body(c, who, org)
        r = await _confirm(c, code, who, org, body, project_name="첫 프로젝트")
        assert r.status_code == 409, r.text
        assert r.json()["error"]["code"] == "project_required"
    assert [n for _, n in await _projects(org)] == ["있는 프로젝트"]
    assert await _confirmed() == 0


@pytest.mark.anyio
async def test_the_plan_project_limit_refuses_and_nothing_is_made(world, monkeypatch):
    import app.services.org_project_create as opc
    from ee.plan_limits import _plan_limit_error

    async def _full(_db, _org):
        raise _plan_limit_error("project", 1)

    monkeypatch.setattr(opc, "check_project_create_allowed", _full)
    who, org = await _admin_org(world)
    async with _client() as c:
        code, _ = await _code(c)
        body = await _recipe_body(c, who, org)
        r = await _confirm(c, code, who, org, body, project_name="첫 프로젝트")
        assert r.status_code == 402, r.text
        err = r.json()["error"]
        assert err["code"] == "PLAN_LIMIT_EXCEEDED" and err["resource"] == "project" and err["limit"] == 1
    assert await _projects(org) == []
    assert await _confirmed() == 0


@pytest.mark.anyio
async def test_not_an_admin_is_refused_before_anything_is_made(world):
    who, org = await _admin_org(world, role="member")
    async with _client() as c:
        code, _ = await _code(c)
        r = await _confirm(c, code, who, org, {"recipe_id": str(uuid.uuid4()), "roles": []}, project_name="첫 프로젝트")
        assert r.status_code == 403, r.text
        assert r.json()["error"]["code"] == "not_org_admin"
    assert await _projects(org) == []
    assert await _confirmed() == 0


@pytest.mark.anyio
async def test_neither_a_project_nor_a_name_is_a_bad_request(world):
    who, org = await _admin_org(world)
    async with _client() as c:
        code, _ = await _code(c)
        body = await _recipe_body(c, who, org)
        r = await _confirm(c, code, who, org, body)
        assert r.status_code == 422, r.text
    assert await _projects(org) == []
