"""story #4427 (PO 01:21Z) — GET /api/v2/invites/mine over real HTTP on a migrated PG: the pending invites to the signed-in
person's own **verified** email (org name · invited at · expires), for a desktop sign-up to join by invite instead of making a
new org. Unverified → empty; expired · revoked · accepted · someone else's · an org the person already belongs to → left out;
no token anywhere in the answer; «mine» is never read as a token."""
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

ORG_A = uuid.UUID("d4427000-0000-0000-0000-00000000000a")
ORG_B = uuid.UUID("d4427000-0000-0000-0000-00000000000b")
ORG_C = uuid.UUID("d4427000-0000-0000-0000-00000000000c")
ORG_MINE = uuid.UUID("d4427000-0000-0000-0000-00000000000d")
VERIFIED = uuid.UUID("d4427000-0000-0000-0000-000000000101")
UNVERIFIED = uuid.UUID("d4427000-0000-0000-0000-000000000102")
ORGS = (ORG_A, ORG_B, ORG_C, ORG_MINE)
TOKENS = {name: f"d4427{name}".ljust(64, "0") for name in ("a", "b", "expired", "revoked", "accepted", "mine", "other", "unv")}


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


_IN = ",".join(f"'{o}'" for o in ORGS)
_CLEAN = [
    f"DELETE FROM org_invites WHERE organization_id IN ({_IN})",
    f"DELETE FROM org_members WHERE org_id IN ({_IN})",
    f"DELETE FROM users WHERE id IN ('{VERIFIED}','{UNVERIFIED}')",
    f"DELETE FROM organizations WHERE id IN ({_IN})",
]


def _invite(org: uuid.UUID, email: str, token: str, *, status: str = "pending", expires: str = "now() + interval '7 days'",
            created: str = "now()") -> str:
    return ("INSERT INTO org_invites (id,organization_id,email,role,token,status,expires_at,created_at) VALUES "
            f"(gen_random_uuid(),'{org}','{email}','member','{token}','{status}',{expires},{created})")


@pytest.fixture
async def world():
    await _sql(*_CLEAN)
    await _sql(
        f"INSERT INTO organizations (id,name,slug,plan) VALUES ('{ORG_A}','Alpha Co','d4427-a','free'),"
        f"('{ORG_B}','Beta Co','d4427-b','free'),('{ORG_C}','Gamma Co','d4427-c','free'),('{ORG_MINE}','Mine Co','d4427-m','free')",
        "INSERT INTO users (id,email,hashed_password,display_name,is_active,email_verified,login_fail_count,totp_enabled,"
        "totp_fail_count) VALUES "
        f"('{VERIFIED}','v@d4427.test','x','V',true,true,0,false,0),('{UNVERIFIED}','u@d4427.test','x','U',true,false,0,false,0)",
        f"INSERT INTO org_members (id,org_id,user_id,role) VALUES (gen_random_uuid(),'{ORG_MINE}','{VERIFIED}','member')",
        # to the verified person: two pending (Beta newer), and the ones that must stay out
        _invite(ORG_A, "v@d4427.test", TOKENS["a"], created="now() - interval '2 hours'"),
        _invite(ORG_B, "v@d4427.test", TOKENS["b"], created="now() - interval '1 hour'"),
        _invite(ORG_C, "v@d4427.test", TOKENS["expired"], expires="now() - interval '1 minute'"),
        _invite(ORG_C, "v@d4427.test", TOKENS["revoked"], status="revoked"),
        _invite(ORG_C, "v@d4427.test", TOKENS["accepted"], status="accepted"),
        _invite(ORG_MINE, "v@d4427.test", TOKENS["mine"]),  # an org the person already belongs to
        # to other addresses
        _invite(ORG_A, "someone@d4427.test", TOKENS["other"]),
        _invite(ORG_A, "u@d4427.test", TOKENS["unv"]),
    )
    yield
    await _sql(*_CLEAN)


def _client():
    import httpx

    from app.main import app

    return httpx.AsyncClient(transport=httpx.ASGITransport(app=app), base_url="http://test")


def _person(user_id: uuid.UUID) -> dict:
    from app.core.security import create_access_token

    return {"Authorization": f"Bearer {create_access_token(user_id=str(user_id))}"}


@pytest.mark.anyio
async def test_a_verified_person_sees_only_their_own_pending_invites(world):
    async with _client() as c:
        r = await c.get("/api/v2/invites/mine", headers=_person(VERIFIED))
    assert r.status_code == 200, r.text
    invites = r.json()["invites"]
    assert [(i["org_name"], i["org_id"], i["role"]) for i in invites] == [("Beta Co", str(ORG_B), "member"), ("Alpha Co", str(ORG_A), "member")]
    assert all(set(i) == {"invite_id", "org_id", "org_name", "role", "invited_at", "expires_at"} for i in invites)
    # no token of any invite in the answer
    assert not any(t in r.text for t in TOKENS.values())


@pytest.mark.anyio
async def test_an_unverified_email_sees_nothing(world):
    async with _client() as c:
        r = await c.get("/api/v2/invites/mine", headers=_person(UNVERIFIED))
    assert (r.status_code, r.json()) == (200, {"invites": []})


@pytest.mark.anyio
async def test_no_user_row_sees_nothing_and_no_session_is_refused(world):
    async with _client() as c:
        assert (await c.get("/api/v2/invites/mine", headers=_person(uuid.uuid4()))).json() == {"invites": []}
        assert (await c.get("/api/v2/invites/mine")).status_code == 401


@pytest.mark.anyio
async def test_mine_is_not_read_as_a_token_and_the_token_preview_still_works(world):
    async with _client() as c:
        assert (await c.get(f"/api/v2/invites/{TOKENS['a']}")).json()["org_name"] == "Alpha Co"
        assert "invites" in (await c.get("/api/v2/invites/mine", headers=_person(VERIFIED))).json()
