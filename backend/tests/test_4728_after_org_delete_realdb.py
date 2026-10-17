"""story 4728 AC0 — what an organization delete leaves behind, and which credentials still reach what is left.

Builds one organization through the real routes (a person who registers, an organization, a project, a human member with a project grant,
an agent with its API key, a story, a doc with a public share link, a refresh token), deletes the organization through the real
`DELETE /api/v2/organizations/{id}` route, then (a) counts the rows each org-keyed table holds for it before / after and (b) tries every
credential against what is left, writing the table to $AC0_OUT (json). Measurement only — it asserts that the delete itself worked.

DB env (ALEMBIC_DATABASE_URL or PARITY_TEST_DATABASE_URL, plus DATABASE_URL for the app's own engine) is required, otherwise skip."""
from __future__ import annotations

import json
import os
import uuid

import pytest
from sqlalchemy import text
from sqlalchemy.ext.asyncio import async_sessionmaker, create_async_engine
from sqlalchemy.pool import NullPool

_RAW = os.environ.get("ALEMBIC_DATABASE_URL") or os.environ.get("PARITY_TEST_DATABASE_URL") or ""
_ASYNC = _RAW.replace("postgresql+psycopg2://", "postgresql+asyncpg://").replace("postgresql://", "postgresql+asyncpg://")

pytestmark = pytest.mark.skipif(not _RAW, reason="real-DB URL not set — skip")

TAG = "d4728"


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
    try:
        j = resp.json()
    except Exception:
        return {}
    return j.get("data", j) if isinstance(j, dict) else {}


async def _call(c, method, url, *, bearer=None, json_body=None):
    headers = {"Authorization": f"Bearer {bearer}"} if bearer else {}
    r = await c.request(method, url, headers=headers, json=json_body)
    return r


@pytest.mark.anyio
async def test_4728_ac0_what_is_left_after_an_organization_delete():
    from app.core.security import create_access_token

    out: dict = {"credentials": {}, "tables": {}}
    sfx = uuid.uuid4().hex[:8]
    async with _client() as c:
        # --- the people ---------------------------------------------------------------------------------------------
        owner_email, member_email = f"owner-{sfx}@{TAG}.test", f"member-{sfx}@{TAG}.test"
        reg = await _call(c, "POST", "/api/v2/auth/register", json_body={"email": owner_email, "password": "Passw0rd!x-" + sfx, "display_name": "Owner 4728", "tos_accepted": True})
        assert reg.status_code in (200, 201), reg.text
        owner_tokens = _data(reg)
        await _sql("UPDATE users SET email_verified = true WHERE email = :e", e=owner_email)
        reg2 = await _call(c, "POST", "/api/v2/auth/register", json_body={"email": member_email, "password": "Passw0rd!y-" + sfx, "display_name": "Member 4728", "tos_accepted": True})
        assert reg2.status_code in (200, 201), reg2.text
        member_user = (await _sql("SELECT id FROM users WHERE email = :e", e=member_email))[0][0]

        # --- organization, project -------------------------------------------------------------------------------------
        org_name = f"o4728-{sfx}"
        o = await _call(c, "POST", "/api/v2/organizations", bearer=owner_tokens["access_token"], json_body={"name": org_name})
        assert o.status_code in (200, 201), o.text
        org = _data(o)["id"]
        rf = await _call(c, "POST", "/api/v2/auth/refresh", json_body={"refresh_token": owner_tokens["refresh_token"]})
        assert rf.status_code == 200, rf.text
        owner_tokens = _data(rf)  # now carries the organization
        p = await _call(c, "POST", "/api/v2/projects", bearer=owner_tokens["access_token"], json_body={"org_id": org, "name": f"p4728-{sfx}"})
        assert p.status_code in (200, 201), p.text
        proj = _data(p)["id"]

        # --- a human member with a project grant -----------------------------------------------------------------------
        om = uuid.uuid4()
        await _sql("INSERT INTO org_members (id,org_id,user_id,role) VALUES (:i,:o,:u,'member')", i=om, o=org, u=member_user)
        await _sql("INSERT INTO project_access (project_id,org_member_id,permission,role) VALUES (:p,:om,'granted','member')", p=proj, om=om)
        member_token = create_access_token(str(member_user), member_email, {"org_id": str(org)})

        # --- an agent with its key, a story, a doc with a public share link ------------------------------------------------
        a = await _call(c, "POST", "/api/v2/team-members", bearer=owner_tokens["access_token"], json_body={"org_id": org, "project_id": proj, "type": "agent", "name": f"agent-{sfx}", "role": "developer"})
        assert a.status_code in (200, 201), a.text
        agent_key = _data(a).get("api_key")
        agent_id = _data(a).get("id")
        out["agent_created"] = {"has_key": bool(agent_key)}
        key_ids = [r[0] for r in await _sql("SELECT id FROM agent_api_keys WHERE member_id = :m", m=agent_id)]
        s = await _call(c, "POST", "/api/v2/stories", bearer=owner_tokens["access_token"], json_body={"project_id": proj, "org_id": org, "title": f"story {sfx}"})
        assert s.status_code in (200, 201), s.text
        d = await _call(c, "POST", "/api/v2/docs", bearer=owner_tokens["access_token"], json_body={"project_id": proj, "org_id": org, "title": f"doc {sfx}", "slug": f"doc-{sfx}", "content": "secret body"})
        assert d.status_code in (200, 201), d.text
        doc = _data(d)["id"]
        sh = await _call(c, "POST", f"/api/v2/docs/{doc}/share", bearer=owner_tokens["access_token"])
        share_token = _data(sh).get("token")
        out["share_created"] = {"status": sh.status_code, "has_token": bool(share_token)}

        # --- before counts ------------------------------------------------------------------------------------------------
        tables = [r[0] for r in await _sql(
            "SELECT c.table_name FROM information_schema.columns c JOIN information_schema.tables t "
            "ON t.table_name=c.table_name AND t.table_schema=c.table_schema AND t.table_type='BASE TABLE' "
            "WHERE c.table_schema='public' AND c.column_name='org_id' ORDER BY 1")]
        async def counts():
            res = {}
            for t in tables:
                n = (await _sql(f'SELECT count(*) FROM "{t}" WHERE org_id = :o', o=org))[0][0]
                if n:
                    res[t] = n
            return res
        before = await counts()
        before_proj = {t: (await _sql(f"SELECT count(*) FROM {t} WHERE project_id = :p", p=proj))[0][0] for t in ("project_access", "project_api_keys")}

        # --- delete through the real route ---------------------------------------------------------------------------------
        dl = await _call(c, "DELETE", f"/api/v2/organizations/{org}", bearer=owner_tokens["access_token"], json_body={"confirmation": org_name, "confirm_without_impact": False})
        out["delete_status"] = dl.status_code
        assert dl.status_code == 200, dl.text

        after = await counts()
        after_proj = {t: (await _sql(f"SELECT count(*) FROM {t} WHERE project_id = :p", p=proj))[0][0] for t in ("project_access", "project_api_keys")}
        out["tables"] = {t: {"before": before.get(t, 0), "after": after.get(t, 0)} for t in sorted(set(before) | set(after))}
        out["project_keyed"] = {"before": before_proj, "after": after_proj}
        out["org_row_exists"] = (await _sql("SELECT count(*) FROM organizations WHERE id = :o", o=org))[0][0]
        out["agent_members_left"] = (await _sql("SELECT count(*) FROM members WHERE id = :m", m=agent_id))[0][0]
        out["api_key_rows"] = [dict(zip(("revoked", "member_id_null"), r)) for k in key_ids for r in await _sql("SELECT revoked_at IS NOT NULL, member_id IS NULL FROM agent_api_keys WHERE id = :k", k=k)]

        # --- every credential against what is left ----------------------------------------------------------------------
        async def attempt(label, bearer, *, org_header=False):
            res = {}
            r1 = await _call(c, "GET", f"/api/v2/stories?project_id={proj}", bearer=bearer)
            res["GET stories"] = r1.status_code
            r2 = await _call(c, "POST", "/api/v2/stories", bearer=bearer, json_body={"project_id": proj, "org_id": org, "title": "after-delete"})
            res["POST story"] = r2.status_code
            r3 = await _call(c, "GET", f"/api/v2/docs/{doc}", bearer=bearer)
            res["GET doc"] = r3.status_code
            out["credentials"][label] = res

        await attempt("owner access token issued before the delete", owner_tokens["access_token"])
        await attempt("member access token (project grant)", member_token)
        if agent_key:
            await attempt("agent API key", agent_key)
        rr = await _call(c, "POST", "/api/v2/auth/refresh", json_body={"refresh_token": owner_tokens["refresh_token"]})
        res = {"POST auth/refresh": rr.status_code}
        if rr.status_code == 200:
            new_access = _data(rr).get("access_token")
            from app.core.security import decode_jwt

            res["new token's org claim"] = str(decode_jwt(new_access).get("app_metadata", {}).get("org_id"))
            r1 = await _call(c, "GET", f"/api/v2/stories?project_id={proj}", bearer=new_access)
            res["GET stories with the new token"] = r1.status_code
        out["credentials"]["owner refresh token issued before the delete"] = res
        if share_token:
            pub = await _call(c, "GET", f"/api/v2/public/docs/{share_token}")
            out["credentials"]["public doc share link"] = {"GET /public/docs/{token}": pub.status_code}

    path = os.environ.get("AC0_OUT")
    if path:
        with open(path, "w") as f:
            json.dump(out, f, indent=1, default=str, ensure_ascii=False)
    print(json.dumps(out, indent=1, default=str, ensure_ascii=False))
