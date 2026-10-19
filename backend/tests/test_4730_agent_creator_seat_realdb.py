"""story 4730 — the «creator» branch of `assert_agent_owner` only counts while the creator still holds the seat that could create the agent.

Before: `agent.created_by == current_user` passed on the spot — a person who was moved down from org admin, who left the organization, or who
lost the project admin seat kept managing the agent they once created (keys, personas, deployments, message policy, the agent row itself, ...).
Now (PO decision 2026-10-19): the creator branch stays, but only when the creator is still an active organization member AND still holds a
seat that may create that agent — org owner/admin, or admin of a project the agent belongs to (the same rule `POST /team-members` applies,
`project_auth.holds_agent_seat`).

Real Postgres, real routes. Each state is one person who created the agent; every route is called with that person's own token.
`pass` = anything but 403 (the guard let it through); `stale` = exactly 403.

DB env (ALEMBIC_DATABASE_URL or PARITY_TEST_DATABASE_URL, plus DATABASE_URL for the app's own engine) is required, otherwise skip."""
from __future__ import annotations

import contextlib
import os
import uuid

import pytest
from sqlalchemy import text
from sqlalchemy.exc import DBAPIError
from sqlalchemy.ext.asyncio import async_sessionmaker, create_async_engine
from sqlalchemy.pool import NullPool

_RAW = os.environ.get("ALEMBIC_DATABASE_URL") or os.environ.get("PARITY_TEST_DATABASE_URL") or ""
_ASYNC = _RAW.replace("postgresql+psycopg2://", "postgresql+asyncpg://").replace("postgresql://", "postgresql+asyncpg://")

pytestmark = pytest.mark.skipif(not _RAW, reason="real-DB URL not set — skip")

TAG = "d4730"


@pytest.fixture
def anyio_backend():
    return "asyncio"


@pytest.fixture(autouse=True)
async def _dispose_global_engine_after_test():
    yield
    from app.core.database import engine as _global_engine

    await _global_engine.dispose()


async def _sql(stmt: str, **params):
    eng = create_async_engine(_ASYNC, poolclass=NullPool)
    try:
        async with async_sessionmaker(eng)() as s:
            res = await s.execute(text(stmt), params)
            rows = [tuple(r) for r in res.all()] if res.returns_rows else []
            await s.commit()
            return rows
    finally:
        await eng.dispose()


def _client():
    import httpx

    from app.main import app

    return httpx.AsyncClient(transport=httpx.ASGITransport(app=app), base_url="http://test")


def _data(resp):
    j = resp.json()
    return j.get("data", j) if isinstance(j, dict) else {}


async def _call(c, method, url, *, bearer=None, json_body=None):
    headers = {"Authorization": f"Bearer {bearer}"} if bearer else {}
    return await c.request(method, url, headers=headers, json=json_body)


class Person:
    def __init__(self, label: str):
        self.label = label
        self.email = ""
        self.user_id = None
        self.org_member_id = None
        self.token = None


class World:
    """one organization, one project, an owner; people are added one state at a time"""

    def __init__(self):
        self.sfx = uuid.uuid4().hex[:8]
        self.org = None
        self.proj = None
        self.owner = None
        self.agent_ids: list = []
        self.api_keys: dict = {}
        self.people: list[Person] = []

    async def _register(self, c, label: str) -> tuple[Person, dict]:
        p = Person(label)
        p.email = f"{label}-{self.sfx}@{TAG}.test"
        reg = await _call(c, "POST", "/api/v2/auth/register", json_body={"email": p.email, "password": "Passw0rd!x-" + self.sfx, "display_name": label, "tos_accepted": True})
        assert reg.status_code in (200, 201), reg.text
        await _sql("UPDATE users SET email_verified = true WHERE email = :e", e=p.email)
        p.user_id = (await _sql("SELECT id FROM users WHERE email = :e", e=p.email))[0][0]
        self.people.append(p)
        return p, _data(reg)

    async def _org_token(self, c, tokens) -> str:
        """a token that carries the organization AND the project (personas · deployments read both from the claims)"""
        rf = await _call(c, "POST", "/api/v2/auth/refresh", json_body={"refresh_token": tokens["refresh_token"]})
        assert rf.status_code == 200, rf.text
        got = _data(rf)
        if self.proj is None:
            return got["access_token"]
        sp = await _call(c, "POST", "/api/v2/auth/switch-project", bearer=got["access_token"], json_body={"project_id": self.proj, "refresh_token": got.get("refresh_token")})
        assert sp.status_code == 200, sp.text
        return _data(sp)["access_token"]

    async def build(self, c) -> World:
        self.owner, tokens = await self._register(c, "owner")
        o = await _call(c, "POST", "/api/v2/organizations", bearer=tokens["access_token"], json_body={"name": f"o4730-{self.sfx}"})
        assert o.status_code in (200, 201), o.text
        self.org = _data(o)["id"]
        self.owner.token = await self._org_token(c, tokens)
        self.owner.org_member_id = (await _sql("SELECT id FROM org_members WHERE org_id = :o AND user_id = :u", o=self.org, u=self.owner.user_id))[0][0]
        p = await _call(c, "POST", "/api/v2/projects", bearer=self.owner.token, json_body={"org_id": self.org, "name": f"p4730-{self.sfx}"})
        assert p.status_code in (200, 201), p.text
        self.proj = _data(p)["id"]
        self.owner.token = await self._org_token(c, tokens)  # again, now that the project exists
        return self

    async def add_person(self, c, label: str, *, org_role: str, project_role: str | None = None) -> Person:
        """a person with an org seat (and optionally an explicit project role), holding a token that was issued while the seat was live"""
        p, tokens = await self._register(c, label)
        p.org_member_id = uuid.uuid4()
        await _sql("INSERT INTO org_members (id, org_id, user_id, role) VALUES (:i, :o, :u, :r)", i=p.org_member_id, o=self.org, u=p.user_id, r=org_role)
        await _sql("INSERT INTO members (id, org_id, type, name, user_id) VALUES (:i, :o, 'human', :n, :u) ON CONFLICT (id) DO NOTHING", i=p.org_member_id, o=self.org, n=label, u=p.user_id)
        if project_role:
            await _sql("INSERT INTO project_access (id, project_id, org_member_id, role, permission) VALUES (:i, :p, :m, :r, 'granted')", i=uuid.uuid4(), p=self.proj, m=p.org_member_id, r=project_role)
        p.token = await self._org_token(c, tokens)
        return p

    async def new_agent(self, c, creator: Person | None) -> str:
        """a fresh agent made through the real route by the owner; then its creator is set to `creator` (default: stays the owner)"""
        n = uuid.uuid4().hex[:6]
        a = await _call(c, "POST", "/api/v2/team-members", bearer=self.owner.token, json_body={"org_id": self.org, "project_id": self.proj, "type": "agent", "name": f"agent-{n}", "role": "developer"})
        assert a.status_code in (200, 201), a.text
        agent_id = _data(a)["id"]
        self.api_keys[agent_id] = _data(a).get("api_key")
        self.agent_ids.append(agent_id)
        if creator is not None:
            await _sql("UPDATE members SET owner_member_id = :m WHERE id = :a", m=creator.org_member_id, a=agent_id)
        return agent_id

    async def cleanup(self) -> None:
        for aid in self.agent_ids:
            await _sql("DELETE FROM agent_api_keys WHERE member_id = :a OR team_member_id = :a", a=aid)
        if self.org:
            tables = [r[0] for r in await _sql(
                "SELECT c.table_name FROM information_schema.columns c JOIN information_schema.tables t "
                "ON t.table_name=c.table_name AND t.table_schema=c.table_schema AND t.table_type='BASE TABLE' "
                "WHERE c.table_schema='public' AND c.column_name='org_id'")]
            for _pass in range(2):
                for t in tables:
                    with contextlib.suppress(DBAPIError):
                        await _sql(f'DELETE FROM "{t}" WHERE org_id = :o', o=self.org)
            await _sql("DELETE FROM organizations WHERE id = :o", o=self.org)
        await _sql("DELETE FROM refresh_tokens WHERE user_id IN (SELECT id FROM users WHERE email LIKE :e)", e=f"%-{self.sfx}@{TAG}.test")
        await _sql("DELETE FROM users WHERE email LIKE :e", e=f"%-{self.sfx}@{TAG}.test")


# (name, method, url template, body template, extra resources the route needs) — `{a}` the agent, `{key}` its active key, `{persona}`,
# `{dep}`, `{om}` an org member id. Routes that need a request body get the smallest valid one.
ROUTES = [
    ("message_policy_get", "GET", "/api/v2/agents/{a}/message-policy", None, ()),
    ("message_policy_candidates", "GET", "/api/v2/agents/{a}/message-policy/candidates", None, ()),
    ("message_policy_put", "PUT", "/api/v2/agents/{a}/message-policy", {"mode": "org_wide"}, ()),
    ("allowlist_add", "POST", "/api/v2/agents/{a}/message-policy/allowlist", {"member_id": "{om}"}, ()),
    ("allowlist_remove", "DELETE", "/api/v2/agents/{a}/message-policy/allowlist/{om}", None, ()),
    ("keys_list", "GET", "/api/v2/agents/{a}/api-keys", None, ()),
    ("keys_create", "POST", "/api/v2/agents/{a}/api-keys", {"scope": None, "expires_at": None}, ()),
    ("keys_revoke", "DELETE", "/api/v2/agents/{a}/api-keys/{key}", None, ("key",)),
    ("keys_rotate", "POST", "/api/v2/api-keys/rotate", {"api_key_id": "{key}"}, ("key",)),
    ("keys_logs", "GET", "/api/v2/api-keys/{key}/logs", None, ("key",)),
    ("keys_usage_summary", "GET", "/api/v2/api-keys/{key}/usage-summary", None, ("key",)),
    ("persona_create", "POST", "/api/v2/agent-personas", {"agent_id": "{a}", "name": "persona-x"}, ()),
    ("persona_patch", "PATCH", "/api/v2/agent-personas/{persona}", {"name": "persona-y"}, ("persona",)),
    ("persona_delete", "DELETE", "/api/v2/agent-personas/{persona}", None, ("persona",)),
    ("deployment_create", "POST", "/api/v2/agent-deployments", {"agent_id": "{a}", "name": "dep-x"}, ()),
    ("deployment_preflight", "POST", "/api/v2/agent-deployments/preflight", {"agent_id": "{a}", "name": "dep-x"}, ()),
    ("deployment_patch", "PATCH", "/api/v2/agent-deployments/{dep}", {"status": "active"}, ("dep",)),
    ("deployment_delete", "DELETE", "/api/v2/agent-deployments/{dep}", None, ("dep",)),
    ("team_member_patch", "PATCH", "/api/v2/team-members/{a}", {"name": "renamed"}, ()),
    ("team_member_delete", "DELETE", "/api/v2/team-members/{a}", None, ()),
    ("verify_connection", "POST", "/api/v2/agents/{a}/verify-connection", None, ()),
]


def _fill(obj, ctx: dict):
    if isinstance(obj, str):
        return obj.format(**ctx)
    if isinstance(obj, list):
        return [_fill(x, ctx) for x in obj]
    if isinstance(obj, dict):
        return {k: _fill(v, ctx) for k, v in obj.items()}
    return obj


async def _resources(c, w: World, agent_id: str, needs) -> dict:
    ctx = {"a": agent_id, "om": str(w.owner.org_member_id)}
    if "key" in needs:
        ctx["key"] = str((await _sql("SELECT id FROM agent_api_keys WHERE member_id = :a AND revoked_at IS NULL ORDER BY created_at LIMIT 1", a=agent_id))[0][0])
    if "persona" in needs:
        r = await _call(c, "POST", "/api/v2/agent-personas", bearer=w.owner.token, json_body={"agent_id": agent_id, "name": f"persona-{uuid.uuid4().hex[:6]}"})
        assert r.status_code in (200, 201), r.text
        ctx["persona"] = _data(r)["id"]
    if "dep" in needs:
        r = await _call(c, "POST", "/api/v2/agent-deployments", bearer=w.owner.token, json_body={"agent_id": agent_id, "name": f"dep-{uuid.uuid4().hex[:6]}"})
        assert r.status_code in (200, 201, 202), r.text
        ctx["dep"] = _data(r).get("id") or _data(r)["deployment"]["id"]
    return ctx


async def _run_state(c, w: World, who: Person, creator: Person | None):
    """every route, each on a fresh agent whose creator is `creator`, called with `who`'s token → {route: status}"""
    out = {}
    for name, method, url, body, needs in ROUTES:
        agent_id = await w.new_agent(c, creator)
        ctx = await _resources(c, w, agent_id, needs)
        r = await _call(c, method, _fill(url, ctx), bearer=who.token, json_body=_fill(body, ctx) if body is not None else None)
        out[name] = r.status_code
    return out


def _not_let_through(out: dict) -> dict:
    """routes whose answer is not «the guard let the call through and the handler did its job» (2xx; 409 is the deployment status conflict):
    a 403 from the guard — and also a 404 / 422 / 5xx, which would hide an unguarded or mis-built call behind a «not 403»"""
    return {k: v for k, v in out.items() if not (v < 300 or v == 409)}


@pytest.mark.anyio
async def test_a_current_holders_of_a_seat_pass_on_every_route():
    async with _client() as c:
        w = World()
        try:
            await w.build(c)
            org_admin = await w.add_person(c, "orgadmin", org_role="admin")
            proj_admin = await w.add_person(c, "projadmin", org_role="member", project_role="admin")
            # creator and still an org admin / still a project admin → the creator branch holds
            for who in (org_admin, proj_admin):
                out = await _run_state(c, w, who, creator=who)
                assert _not_let_through(out) == {}, f"{who.label}: a person who still holds the seat was not let through: {_not_let_through(out)}"
            # control: an org admin who did not create the agent (the admin branch, untouched by the fix)
            out = await _run_state(c, w, org_admin, creator=None)
            assert _not_let_through(out) == {}, f"non-creator org admin: {_not_let_through(out)}"
        finally:
            await w.cleanup()


@pytest.mark.anyio
async def test_b_a_creator_who_lost_the_seat_gets_403_on_every_route():
    async with _client() as c:
        w = World()
        try:
            await w.build(c)
            demoted = await w.add_person(c, "demoted", org_role="admin")  # was an org admin when the agent was made ...
            await _sql("UPDATE org_members SET role = 'member' WHERE id = :m", m=demoted.org_member_id)  # ... is a plain member now
            gone = await w.add_person(c, "gone", org_role="admin")
            await _sql("UPDATE org_members SET deleted_at = now() WHERE id = :m", m=gone.org_member_id)  # left the organization (token still alive)
            ex_proj_admin = await w.add_person(c, "exproj", org_role="member", project_role="admin")
            await _sql("UPDATE project_access SET role = 'member' WHERE org_member_id = :m", m=ex_proj_admin.org_member_id)  # lost the project admin seat
            for who in (demoted, gone, ex_proj_admin):
                out = await _run_state(c, w, who, creator=who)
                not_403 = {k: v for k, v in out.items() if v != 403}
                assert not_403 == {}, f"{who.label}: routes that did NOT answer 403 for a creator who lost the seat: {not_403}"
            # control: an ordinary org member who never created the agent has no way in either (the guard denies, it is not blind)
            plain = await w.add_person(c, "plain", org_role="member", project_role="member")  # in the project, but no admin seat
            out = await _run_state(c, w, plain, creator=None)
            not_403 = {k: v for k, v in out.items() if v != 403}
            assert not_403 == {}, f"plain member, not the creator: routes that did NOT answer 403: {not_403}"
        finally:
            await w.cleanup()


@pytest.mark.anyio
async def test_c_an_agent_made_by_an_agent_has_no_human_creator_and_the_seat_rule_reads_the_agents_own_grant():
    """an agent that holds a project admin grant can create an agent (POST /team-members): the new agent's `created_by` is NULL (the view
    projects the human creator only), so the creator branch cannot be reached by an agent creator — and the seat rule itself reads the
    agent's own grant (`project_access.member_id`) and lets go of it when the grant is lowered."""
    from app.services.project_auth import holds_agent_seat

    async with _client() as c:
        w = World()
        try:
            await w.build(c)
            parent = await w.new_agent(c, None)
            await _sql("UPDATE project_access SET role = 'admin' WHERE member_id = :a AND project_id = :p", a=parent, p=w.proj)
            r = await _call(c, "POST", "/api/v2/team-members", bearer=w.api_keys[parent], json_body={"org_id": w.org, "project_id": w.proj, "type": "agent", "name": f"child-{w.sfx}", "role": "developer"})
            assert r.status_code in (200, 201), r.text
            child = _data(r)["id"]
            w.agent_ids.append(child)
            assert (await _sql("SELECT DISTINCT created_by FROM team_members WHERE id = :a", a=child)) == [(None,)]  # no human creator
            # the parent agent is neither the creator nor an org admin: the ownership guard says 403 for the child
            denied = await _call(c, "GET", f"/api/v2/agents/{child}/message-policy", bearer=w.api_keys[parent])
            assert denied.status_code == 403, denied.text

            eng = create_async_engine(_ASYNC, poolclass=NullPool)
            try:
                async with async_sessionmaker(eng)() as session:
                    assert await holds_agent_seat(session, uuid.UUID(parent), [uuid.UUID(w.proj)]) is True  # its own project admin grant
                    await _sql("UPDATE project_access SET role = 'member' WHERE member_id = :a AND project_id = :p", a=parent, p=w.proj)
                    assert await holds_agent_seat(session, uuid.UUID(parent), [uuid.UUID(w.proj)]) is False  # lowered → the seat is gone
            finally:
                await eng.dispose()
        finally:
            await w.cleanup()


@pytest.mark.anyio
async def test_d_an_agent_with_no_project_is_out_of_reach_for_a_creator_who_lost_the_seat():
    """an agent with zero project rows: the `team_members` view needs a project profile, so the guard finds no agent at all — a creator who lost
    her seat gets nothing (never a 2xx), and the org-admin branch answers exactly as it did before (same status for the current org admin)."""
    async with _client() as c:
        w = World()
        try:
            await w.build(c)
            demoted = await w.add_person(c, "demoted", org_role="admin")
            org_admin = await w.add_person(c, "orgadmin", org_role="admin")
            agent_id = await w.new_agent(c, demoted)
            await _sql("DELETE FROM agent_project_profiles WHERE member_id = :a", a=agent_id)
            await _sql("DELETE FROM project_access WHERE member_id = :a", a=agent_id)
            assert (await _sql("SELECT count(*) FROM team_members WHERE id = :a", a=agent_id)) == [(0,)], "the agent must really have no project row left"
            await _sql("UPDATE org_members SET role = 'member' WHERE id = :m", m=demoted.org_member_id)
            url = f"/api/v2/agents/{agent_id}/message-policy"
            as_creator = (await _call(c, "GET", url, bearer=demoted.token)).status_code
            as_admin = (await _call(c, "GET", url, bearer=org_admin.token)).status_code
            assert as_creator >= 400 and as_admin >= 400 and as_creator == as_admin, (as_creator, as_admin)
        finally:
            await w.cleanup()


@pytest.mark.anyio
async def test_e_a_creator_who_is_admin_only_of_a_later_project_of_the_agent_still_passes():
    """an agent that belongs to three projects; its creator is a plain member of the first, holds nothing in the second and is admin of the LAST one only.
    The guard must look at every project of the agent (not just the first row of the `team_members` projection): a lookup cut to one project fails this
    for the creator, while a plain member who is admin of none of the three still gets 403."""
    async with _client() as c:
        w = World()
        try:
            await w.build(c)
            extra = []
            for n in (2, 3):
                p = await _call(c, "POST", "/api/v2/projects", bearer=w.owner.token, json_body={"org_id": w.org, "name": f"p4730-{n}-{w.sfx}"})
                assert p.status_code in (200, 201), p.text
                extra.append(_data(p)["id"])
            creator = await w.add_person(c, "latecreator", org_role="member", project_role="member")  # a plain member of the first project
            plain = await w.add_person(c, "plainmember", org_role="member", project_role="member")  # a plain member everywhere
            for person in (creator, plain):
                await _sql("INSERT INTO project_access (id, project_id, org_member_id, role, permission) VALUES (:i, :p, :m, 'member', 'granted')", i=uuid.uuid4(), p=extra[0], m=person.org_member_id)
            await _sql("INSERT INTO project_access (id, project_id, org_member_id, role, permission) VALUES (:i, :p, :m, 'admin', 'granted')", i=uuid.uuid4(), p=extra[1], m=creator.org_member_id)
            agent_id = await w.new_agent(c, creator)
            for pid in extra:  # the agent belongs to all three projects
                await _sql("INSERT INTO agent_project_profiles (id, member_id, project_id) VALUES (:i, :a, :p)", i=uuid.uuid4(), a=agent_id, p=pid)
            assert (await _sql("SELECT count(DISTINCT project_id) FROM team_members WHERE id = :a", a=agent_id)) == [(3,)]

            for who, expect_pass in ((creator, True), (plain, False)):
                for name, method, url, body in (
                    ("message_policy_get", "GET", f"/api/v2/agents/{agent_id}/message-policy", None),
                    ("keys_list", "GET", f"/api/v2/agents/{agent_id}/api-keys", None),
                    ("message_policy_put", "PUT", f"/api/v2/agents/{agent_id}/message-policy", {"mode": "org_wide"}),
                ):
                    r = await _call(c, method, url, bearer=who.token, json_body=body)
                    if expect_pass:
                        assert r.status_code < 300, f"{who.label} (admin of the agent's last project) was refused on {name}: {r.status_code} {r.text}"
                    else:
                        assert r.status_code == 403, f"{who.label} (admin of none) got {r.status_code} on {name}"
        finally:
            await w.cleanup()
