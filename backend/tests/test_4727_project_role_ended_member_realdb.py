"""story 4727 — a person whose organization membership has ENDED must not keep project authority.

`get_project_role` (services/project_auth.py) is the one place a person's effective project role is decided for every owner / admin gated write
(gate config, workflow lines, repeat schedules, agent grants, project-access edits, conversations' per-project role…). Its org-role subselect
filters `om.deleted_at IS NULL`, but the project-grant subselect joined `org_members om2` WITHOUT it: a person whose org_members row was ended
(member removed · account deleted · the organization deleted — the three ways a row gets `deleted_at`) still counted as a granted project member with
the grant's role, owner included.

AC0 (before the fix): the three ways below return the grant's role / write the gate level; AC2 (after): every one is refused, a live member
is unchanged. Real HTTP + real service calls over a migrated PG.
"""
from __future__ import annotations

import os
import uuid

import pytest
from sqlalchemy import text
from sqlalchemy.ext.asyncio import async_sessionmaker, create_async_engine
from sqlalchemy.pool import NullPool

_RAW = os.environ.get("ALEMBIC_DATABASE_URL") or os.environ.get("PARITY_TEST_DATABASE_URL") or ""
_ASYNC = _RAW.replace("postgresql+psycopg2://", "postgresql+asyncpg://").replace("postgresql://", "postgresql+asyncpg://")

pytestmark = pytest.mark.skipif(not _RAW, reason="real-DB URL 미설정 — skip")

TAG = "d4727"


@pytest.fixture
def anyio_backend():
    return "asyncio"


@pytest.fixture(autouse=True)
async def _dispose_global_engine_after_test():
    yield
    from app.core.database import engine as _global_engine

    await _global_engine.dispose()


async def _sql(*stmts: str):
    eng = create_async_engine(_ASYNC, poolclass=NullPool)
    try:
        async with async_sessionmaker(eng)() as s:
            for st in stmts:
                await s.execute(text(st))
            await s.commit()
    finally:
        await eng.dispose()


async def _rows(q: str) -> list[tuple]:
    eng = create_async_engine(_ASYNC, poolclass=NullPool)
    try:
        async with async_sessionmaker(eng)() as s:
            return [tuple(r) for r in (await s.execute(text(q))).all()]
    finally:
        await eng.dispose()


class World:
    """one organization, one project, an owner who stays, and two members granted the project: `gone` (whose membership the test ends) and `live`"""

    def __init__(self) -> None:
        self.org, self.proj = uuid.uuid4(), uuid.uuid4()
        self.boss, self.gone, self.live = uuid.uuid4(), uuid.uuid4(), uuid.uuid4()         # users
        self.om_boss, self.om_gone, self.om_live = uuid.uuid4(), uuid.uuid4(), uuid.uuid4()  # org_members

    async def build(self, gone_role: str = "owner") -> "World":
        users = ",".join(
            f"('{u}','{n}-{self.org.hex[:8]}@{TAG}.test','x',' U',true,true,0,false,0)"
            for u, n in ((self.boss, "boss"), (self.gone, "gone"), (self.live, "live"))
        )
        await _sql(
            f"INSERT INTO organizations (id,name,slug,plan) VALUES ('{self.org}','Org {TAG}','{TAG}-{self.org.hex[:8]}','free')",
            f"INSERT INTO projects (id,org_id,name) VALUES ('{self.proj}','{self.org}','P {TAG}')",
            "INSERT INTO users (id,email,hashed_password,display_name,is_active,email_verified,login_fail_count,totp_enabled,totp_fail_count) VALUES " + users,
            f"INSERT INTO org_members (id,org_id,user_id,role) VALUES ('{self.om_boss}','{self.org}','{self.boss}','owner'),"
            f"('{self.om_gone}','{self.org}','{self.gone}','member'),('{self.om_live}','{self.org}','{self.live}','member')",
            f"INSERT INTO project_access (project_id,org_member_id,permission,role) VALUES ('{self.proj}','{self.om_gone}','granted','{gone_role}'),"
            f"('{self.proj}','{self.om_live}','granted','owner')",
        )
        return self

    async def end_member_removed(self) -> None:
        """the org-members DELETE route: `OrgMemberRepository.soft_delete` — `deleted_at` on that one row"""
        await _sql(f"UPDATE org_members SET deleted_at = now() WHERE id = '{self.om_gone}'")

    async def end_account_deleted(self) -> None:
        """`DELETE /account` (routers/account.py): `UPDATE org_members SET deleted_at = now() WHERE user_id = :uid` — every org the person was in"""
        await _sql(f"UPDATE org_members SET deleted_at = now() WHERE user_id = '{self.gone}'")

    async def end_organization_deleted(self) -> None:
        """an organization deleted (story 4726 shape): every member row of the organization ended"""
        await _sql(f"UPDATE org_members SET deleted_at = now() WHERE org_id = '{self.org}'")

    async def cleanup(self) -> None:
        await _sql(
            f"DELETE FROM hitl_gate_config WHERE project_id = '{self.proj}'",
            f"DELETE FROM project_access WHERE project_id = '{self.proj}'",
            f"DELETE FROM org_members WHERE org_id = '{self.org}'",
            f"DELETE FROM projects WHERE id = '{self.proj}'",
            f"DELETE FROM organizations WHERE id = '{self.org}'",
            f"DELETE FROM users WHERE id IN ('{self.boss}','{self.gone}','{self.live}')",
        )


@pytest.fixture
async def world():
    w = World()
    await w.build()
    yield w
    await w.cleanup()


async def _role(user: uuid.UUID, proj: uuid.UUID) -> str | None:
    from app.core.database import async_session_factory
    from app.services.project_auth import get_project_role

    async with async_session_factory() as s:
        return await get_project_role(s, user, proj)


async def _has_access(user: uuid.UUID, proj: uuid.UUID, org: uuid.UUID) -> bool:
    from app.core.database import async_session_factory
    from app.services.project_auth import has_project_access

    async with async_session_factory() as s:
        return bool(await has_project_access(s, user, proj, org))


def _token(user: uuid.UUID, org: uuid.UUID) -> dict:
    from app.core.security import create_access_token

    return {"Authorization": "Bearer " + create_access_token(str(user), f"u@{TAG}.test", {"org_id": str(org)})}


def _client():
    import httpx

    from app.main import app

    return httpx.AsyncClient(transport=httpx.ASGITransport(app=app), base_url="http://test")


GATE = {"scope": "project", "work_type": "merge", "actor_type": "agent", "level": "block"}


async def _put_gate(w: World, user: uuid.UUID):
    async with _client() as c:
        return await c.put(f"/api/v2/projects/{w.proj}/gate-config", json=GATE, headers=_token(user, w.org))


ENDINGS = ["end_member_removed", "end_account_deleted", "end_organization_deleted"]


@pytest.mark.anyio
async def test_a_live_member_keeps_the_grants_role_and_can_write(world):
    assert await _role(world.live, world.proj) == "owner"
    assert await _has_access(world.live, world.proj, world.org) is True
    r = await _put_gate(world, world.live)
    assert r.status_code == 200, r.text


@pytest.mark.anyio
@pytest.mark.parametrize("ending", ENDINGS)
async def test_an_ended_membership_has_no_project_role(world, ending):
    assert await _role(world.gone, world.proj) == "owner"          # before: the grant's owner role
    await getattr(world, ending)()
    assert await _role(world.gone, world.proj) is None            # after: nothing


@pytest.mark.anyio
@pytest.mark.parametrize("ending", ENDINGS)
async def test_an_ended_membership_cannot_write_a_project_owner_gated_setting(world, ending):
    await getattr(world, ending)()
    r = await _put_gate(world, world.gone)
    assert r.status_code == 403, r.text
    rows = await _rows(f"SELECT count(*) FROM hitl_gate_config WHERE project_id = '{world.proj}'")
    assert rows[0][0] == 0                                         # nothing was written


@pytest.mark.anyio
@pytest.mark.parametrize("ending", ENDINGS)
async def test_an_ended_membership_has_no_project_access_to_read_either(world, ending):
    """the read side already filtered `deleted_at` (has_project_access) — pinned so the two never drift apart again"""
    assert await _has_access(world.gone, world.proj, world.org) is True
    await getattr(world, ending)()
    assert await _has_access(world.gone, world.proj, world.org) is False


@pytest.mark.anyio
async def test_ending_one_member_does_not_touch_the_other_members_role(world):
    await world.end_member_removed()
    assert await _role(world.live, world.proj) == "owner"
    assert await _role(world.boss, world.proj) == "owner"          # the org owner floor
