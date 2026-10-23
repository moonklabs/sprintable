"""story 4728 — the public links and keys of a deleted organization stop working.

AC0 (measured on a real PG, real routes): after `DELETE /api/v2/organizations/{id}` a doc share link still answered 200 with the deleted
organization's text (doc_share_tokens · docs have no foreign key to organizations), and the published site posts stay reachable through the
organization's public key the same way (org_metering_keys · site_posts). Human tokens (403/404) and agent keys (401) were already closed.

Two layers, each pinned here:
- the delete ends the links / keys / posts in its own transaction (rows are `revoked` / `unpublished`, the agent key is revoked), and
- the public readers check that the organization exists — which also covers organizations deleted BEFORE this change.

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
    j = resp.json()
    return j.get("data", j) if isinstance(j, dict) else {}


async def _call(c, method, url, *, bearer=None, json_body=None):
    headers = {"Authorization": f"Bearer {bearer}"} if bearer else {}
    return await c.request(method, url, headers=headers, json=json_body)


class World:
    """one organization with a project, a doc under a public share link, an agent with its key, a published site post under the
    organization's public key"""

    org: str | None = None
    sfx: str | None = None
    key_ids: list  # agent_api_keys has no org_id column: its rows are cleaned by id

    async def build(self, c) -> World:
        sfx = uuid.uuid4().hex[:8]
        self.sfx = sfx
        self.key_ids = []
        email = f"owner-{sfx}@{TAG}.test"
        reg = await _call(c, "POST", "/api/v2/auth/register", json_body={"email": email, "password": "Passw0rd!x-" + sfx, "display_name": "Owner 4728", "tos_accepted": True})
        assert reg.status_code in (200, 201), reg.text
        tokens = _data(reg)
        await _sql("UPDATE users SET email_verified = true WHERE email = :e", e=email)
        self.org_name = f"o4728-{sfx}"
        o = await _call(c, "POST", "/api/v2/organizations", bearer=tokens["access_token"], json_body={"name": self.org_name})
        assert o.status_code in (200, 201), o.text
        self.org = _data(o)["id"]
        rf = await _call(c, "POST", "/api/v2/auth/refresh", json_body={"refresh_token": tokens["refresh_token"]})
        assert rf.status_code == 200, rf.text
        self.token = _data(rf)["access_token"]
        p = await _call(c, "POST", "/api/v2/projects", bearer=self.token, json_body={"org_id": self.org, "name": f"p4728-{sfx}"})
        assert p.status_code in (200, 201), p.text
        self.proj = _data(p)["id"]
        a = await _call(c, "POST", "/api/v2/team-members", bearer=self.token, json_body={"org_id": self.org, "project_id": self.proj, "type": "agent", "name": f"agent-{sfx}", "role": "developer"})
        assert a.status_code in (200, 201), a.text
        self.agent_key = _data(a)["api_key"]
        self.agent_id = _data(a)["id"]
        self.key_ids = [r[0] for r in await _sql("SELECT id FROM agent_api_keys WHERE member_id = :m", m=self.agent_id)]
        assert self.key_ids
        d = await _call(c, "POST", "/api/v2/docs", bearer=self.token, json_body={"project_id": self.proj, "org_id": self.org, "title": f"doc {sfx}", "slug": f"doc-{sfx}", "content": "body of the doc"})
        assert d.status_code in (200, 201), d.text
        sh = await _call(c, "POST", f"/api/v2/docs/{_data(d)['id']}/share", bearer=self.token)
        assert sh.status_code == 200, sh.text
        self.share = _data(sh)["token"]
        self.public_key = f"pk_{TAG}_{sfx}"
        self.post_slug = f"post-{sfx}"
        await _sql("INSERT INTO org_metering_keys (id,org_id,public_key) VALUES (:i,:o,:k)", i=uuid.uuid4(), o=self.org, k=self.public_key)
        await _sql(
            "INSERT INTO site_posts (id,org_id,lang,slug,title,summary,body_md,published_at,source_story_id,gate_id) "
            "VALUES (:i,:o,'ko',:s,'t','s','body of the post',now(),:st,:g)",
            i=uuid.uuid4(), o=self.org, s=self.post_slug, st=uuid.uuid4(), g=uuid.uuid4(),
        )
        # what background jobs keep using: a channel token (its refresh cron), a GA4 connection (its scoring cron), a post waiting to go out
        await _sql(
            "INSERT INTO channel_connections (id,org_id,channel,account_id,status,encrypted_access_token,encrypted_refresh_token) "
            "VALUES (:i,:o,'threads',:a,'active','enc-access','enc-refresh')",
            i=uuid.uuid4(), o=self.org, a=f"acct-{sfx}",
        )
        await _sql("INSERT INTO ga4_connections (id,org_id,encrypted_access_token,encrypted_refresh_token) VALUES (:i,:o,'enc-a','enc-r')", i=uuid.uuid4(), o=self.org)
        self.command = uuid.uuid4()
        await _sql(
            "INSERT INTO publication_commands (id,org_id,gate_id,destination,approved_version,requested_by_member_id,status) "
            "VALUES (:i,:o,:g,:d,:v,:m,'pending')",
            i=self.command, o=self.org, g=uuid.uuid4(), d=uuid.uuid4(), v=uuid.uuid4(), m=uuid.uuid4(),
        )
        return self

    async def state(self) -> dict:
        """every row of this organization in the tables the delete reaches, as the values the delete would change"""
        key_rows = []
        for kid in self.key_ids:
            key_rows += await _sql("SELECT revoked_at IS NOT NULL FROM agent_api_keys WHERE id = :k", k=kid)
        return {
            "doc_share_tokens": await _sql("SELECT status, revoked_at IS NOT NULL FROM doc_share_tokens WHERE org_id = :o", o=self.org),
            "org_metering_keys": await _sql("SELECT revoked_at IS NOT NULL FROM org_metering_keys WHERE org_id = :o", o=self.org),
            "site_posts": await _sql("SELECT unpublished_at IS NOT NULL FROM site_posts WHERE org_id = :o", o=self.org),
            "channel_connections": await _sql(
                "SELECT status, encrypted_access_token IS NULL, encrypted_refresh_token IS NULL FROM channel_connections WHERE org_id = :o", o=self.org),
            "ga4_connections": await _sql("SELECT count(*) FROM ga4_connections WHERE org_id = :o", o=self.org),
            "publication_commands": await _sql("SELECT status FROM publication_commands WHERE org_id = :o", o=self.org),
            "agent_api_keys": key_rows,
        }

    async def cleanup(self) -> None:
        """leave nothing behind in the shared database: the agent's key rows (no org_id column), every row of this organization (whatever
        tables carry its org_id), then the person. Safe after a build that stopped half way."""
        for kid in self.key_ids:
            await _sql("DELETE FROM agent_api_keys WHERE id = :k", k=kid)
        if self.org:
            tables = [r[0] for r in await _sql(
                "SELECT c.table_name FROM information_schema.columns c JOIN information_schema.tables t "
                "ON t.table_name=c.table_name AND t.table_schema=c.table_schema AND t.table_type='BASE TABLE' "
                "WHERE c.table_schema='public' AND c.column_name='org_id'")]
            for _pass in range(2):  # a table that still points at a row another table holds fails the first time; the second pass gets it
                for t in tables:
                    with contextlib.suppress(DBAPIError):
                        await _sql(f'DELETE FROM "{t}" WHERE org_id = :o', o=self.org)
            await _sql("DELETE FROM organizations WHERE id = :o", o=self.org)
        if self.sfx:
            await _sql("DELETE FROM refresh_tokens WHERE user_id IN (SELECT id FROM users WHERE email LIKE :e)", e=f"%-{self.sfx}@{TAG}.test")
            await _sql("DELETE FROM users WHERE email LIKE :e", e=f"%-{self.sfx}@{TAG}.test")

    async def public_reads(self, c) -> dict:
        return {
            "doc": (await _call(c, "GET", f"/api/v2/public/docs/{self.share}")).status_code,
            "posts_list": (await _call(c, "GET", f"/api/v2/public/site-posts?public_key={self.public_key}&lang=ko")).status_code,
            "post": (await _call(c, "GET", f"/api/v2/public/site-posts/{self.post_slug}?public_key={self.public_key}&lang=ko")).status_code,
        }

    async def delete_through_the_route(self, c):
        r = await _call(c, "DELETE", f"/api/v2/organizations/{self.org}", bearer=self.token, json_body={"confirmation": self.org_name, "confirm_without_impact": False})
        assert r.status_code == 200, r.text


@pytest.mark.anyio
async def test_a_a_live_organization_keeps_its_public_links():
    async with _client() as c:
        w = World()
        try:
            await w.build(c)
            assert await w.public_reads(c) == {"doc": 200, "posts_list": 200, "post": 200}
            assert (await _sql("SELECT status FROM channel_connections WHERE org_id = :o", o=w.org)) == [("active",)]  # a live organization is untouched
            assert (await _sql("SELECT status FROM publication_commands WHERE id = :i", i=w.command)) == [("pending",)]
        finally:
            await w.cleanup()


@pytest.mark.anyio
async def test_b_deleting_the_organization_ends_its_links_keys_and_posts():
    async with _client() as c:
        w = World()
        try:
            await w.build(c)
            await w.delete_through_the_route(c)

            assert await w.public_reads(c) == {"doc": 410, "posts_list": 404, "post": 404}
            assert (await _sql("SELECT status, revoked_at IS NOT NULL FROM doc_share_tokens WHERE org_id = :o", o=w.org)) == [("revoked", True)]
            assert (await _sql("SELECT revoked_at IS NOT NULL FROM org_metering_keys WHERE org_id = :o", o=w.org)) == [(True,)]
            assert (await _sql("SELECT unpublished_at IS NOT NULL FROM site_posts WHERE org_id = :o", o=w.org)) == [(True,)]
            # what background jobs would have kept using: the channel token is revoked and its secrets dropped, the GA4 connection is gone,
            # the post waiting to go out is cancelled
            assert (await _sql("SELECT status, encrypted_access_token IS NULL, encrypted_refresh_token IS NULL FROM channel_connections WHERE org_id = :o", o=w.org)) == [("revoked", True, True)]
            assert (await _sql("SELECT count(*) FROM ga4_connections WHERE org_id = :o", o=w.org)) == [(0,)]
            assert (await _sql("SELECT status FROM publication_commands WHERE id = :i", i=w.command)) == [("cancelled",)]
            # the agent's key row is revoked too (the `members` cascade turns its member_id to NULL, so it could not be matched afterwards)
            for kid in w.key_ids:
                assert (await _sql("SELECT revoked_at IS NOT NULL FROM agent_api_keys WHERE id = :k", k=kid)) == [(True,)]
            r = await _call(c, "GET", f"/api/v2/stories?project_id={w.proj}", bearer=w.agent_key)
            assert r.status_code == 401
        finally:
            await w.cleanup()


@pytest.mark.anyio
async def test_c_an_organization_deleted_before_this_change_cannot_be_read_through_its_old_links():
    """what the delete did before: only the organizations row went (here: the same SQL), every link / key / post stayed in its table"""
    async with _client() as c:
        w = World()
        try:
            await w.build(c)
            await _sql("DELETE FROM organizations WHERE id = :o", o=w.org)
            assert (await _sql("SELECT status FROM doc_share_tokens WHERE org_id = :o", o=w.org)) == [("active",)]  # nothing ended it
            assert await w.public_reads(c) == {"doc": 410, "posts_list": 404, "post": 404}
        finally:
            await w.cleanup()


# What a live organization looks like, and what a deleted one must look like, in every table the delete reaches.
_LIVE = {
    "doc_share_tokens": [("active", False)],
    "org_metering_keys": [(False,)],
    "site_posts": [(False,)],
    "channel_connections": [("active", False, False)],
    "ga4_connections": [(1,)],
    "publication_commands": [("pending",)],
    "agent_api_keys": [(False,)],
}
_ENDED = {
    "doc_share_tokens": [("revoked", True)],
    "org_metering_keys": [(True,)],
    "site_posts": [(True,)],
    "channel_connections": [("revoked", True, True)],
    "ga4_connections": [(0,)],
    "publication_commands": [("cancelled",)],
    "agent_api_keys": [(True,)],
}


@pytest.mark.anyio
# story #4731 — measured 21.5 s (two organizations built through the real routes) on the CI runners against the default 30 s per-test timeout (a slower runner would fail it for no reason in the code under test):
@pytest.mark.timeout(120)
async def test_d_deleting_one_organization_changes_nothing_of_another():
    """two organizations: deleting A ends A's rows in every table and leaves B's rows exactly as they were — each ending statement is
    filtered by the organization's id, and a filter that widens (the whole table) would end B's rows too."""
    async with _client() as c:
        a, b = World(), World()
        try:
            await a.build(c)
            await b.build(c)
            assert await a.state() == _LIVE and await b.state() == _LIVE  # control: both are fully alive before

            await a.delete_through_the_route(c)

            assert await a.state() == _ENDED
            assert await b.state() == _LIVE  # B: every row untouched
            assert await b.public_reads(c) == {"doc": 200, "posts_list": 200, "post": 200}
            assert (await _call(c, "GET", f"/api/v2/stories?project_id={b.proj}", bearer=b.agent_key)).status_code == 200  # B's agent key still opens
        finally:
            await a.cleanup()
            await b.cleanup()
