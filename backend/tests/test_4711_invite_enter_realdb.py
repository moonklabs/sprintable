"""story 4711 AC4 (PO 2026-10-17) — POST /api/v2/invites/mine/{invite_id}/accept over real HTTP on a migrated PG: a person takes an invite from the
`GET /invites/mine` list by its invite_id (the list gives no token), from inside the app. Same meaning as the sign-in auto-accept: a person's own session only, a proved
mailbox only, an invite addressed to THIS e-mail only, decided by the one `OrgInviteRepository.accept`; someone else's invite id and a missing id are the same 404."""
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

ORG_A = uuid.UUID("d4711000-0000-0000-0000-00000000000a")
ORG_B = uuid.UUID("d4711000-0000-0000-0000-00000000000b")
ORG_C = uuid.UUID("d4711000-0000-0000-0000-00000000000c")
ORG_OTHER = uuid.UUID("d4711000-0000-0000-0000-00000000000d")
VERIFIED = uuid.UUID("d4711000-0000-0000-0000-000000000101")
UNVERIFIED = uuid.UUID("d4711000-0000-0000-0000-000000000102")
PLAIN_ACCOUNT = uuid.UUID("d4711000-0000-0000-0000-000000000104")
STRANGER = uuid.UUID("d4711000-0000-0000-0000-000000000105")
INV = {n: uuid.UUID(f"d4711000-0000-0000-0000-0000000002{i:02d}") for i, n in enumerate(("a", "b", "expired", "accepted", "other", "unv", "untidy"), start=1)}
TOKENS = {n: f"d4711{n}".ljust(64, "0") for n in INV}
ORGS = (ORG_A, ORG_B, ORG_C, ORG_OTHER)
_IN = ",".join(f"'{o}'" for o in ORGS)
_USERS = ",".join(f"'{u}'" for u in (VERIFIED, UNVERIFIED, PLAIN_ACCOUNT, STRANGER))


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


_CLEAN = [
    f"DELETE FROM org_invites WHERE organization_id IN ({_IN})",
    f"DELETE FROM project_access WHERE org_member_id IN (SELECT id FROM org_members WHERE org_id IN ({_IN}))",
    f"DELETE FROM members WHERE org_id IN ({_IN})",
    f"DELETE FROM org_members WHERE org_id IN ({_IN})",
    f"DELETE FROM users WHERE id IN ({_USERS})",
    f"DELETE FROM organizations WHERE id IN ({_IN})",
]


def _invite(inv: str, org: uuid.UUID, email: str, *, status: str = "pending", expires: str = "now() + interval '7 days'") -> str:
    return ("INSERT INTO org_invites (id,organization_id,email,role,token,status,expires_at,created_at) VALUES "
            f"('{INV[inv]}','{org}','{email}','member','{TOKENS[inv]}','{status}',{expires},now())")


@pytest.fixture
async def world():
    await _sql(*_CLEAN)
    await _sql(
        f"INSERT INTO organizations (id,name,slug,plan) VALUES ('{ORG_A}','Alpha Co','d4711-a','free'),('{ORG_B}','Beta Co','d4711-b','free'),"
        f"('{ORG_C}','Gamma Co','d4711-c','free'),('{ORG_OTHER}','Other Co','d4711-o','free')",
        "INSERT INTO users (id,email,hashed_password,display_name,is_active,email_verified,login_fail_count,totp_enabled,totp_fail_count) VALUES "
        f"('{VERIFIED}','v@d4711.test','x','V',true,true,0,false,0),('{UNVERIFIED}','u@d4711.test','x','U',true,false,0,false,0),"
        f"('{PLAIN_ACCOUNT}','plain@d4711.test','x','P',true,true,0,false,0),('{STRANGER}','s@d4711.test','x','S',true,true,0,false,0)",
        _invite("a", ORG_A, "v@d4711.test"),
        _invite("b", ORG_B, "v@d4711.test"),
        _invite("expired", ORG_C, "v@d4711.test", expires="now() - interval '1 minute'"),
        _invite("accepted", ORG_C, "v@d4711.test", status="accepted"),
        _invite("other", ORG_OTHER, "someone-else@d4711.test"),
        _invite("unv", ORG_A, "u@d4711.test"),
        _invite("untidy", ORG_B, " Plain@D4711.test\t"),
    )
    yield
    await _sql(*_CLEAN)


def _client():
    import httpx

    from app.main import app

    return httpx.AsyncClient(transport=httpx.ASGITransport(app=app), base_url="http://test")


def _person(user_id: uuid.UUID, **app_metadata) -> dict:
    from app.core.security import create_access_token

    return {"Authorization": f"Bearer {create_access_token(user_id=str(user_id), app_metadata=app_metadata or None)}"}


def _url(inv) -> str:
    return f"/api/v2/invites/mine/{inv}/accept"


async def _members(org: uuid.UUID, user: uuid.UUID) -> int:
    return (await _rows(f"SELECT count(*) FROM org_members WHERE org_id = '{org}' AND user_id = '{user}' AND deleted_at IS NULL"))[0][0]


async def _org_count() -> int:
    return (await _rows(f"SELECT count(*) FROM organizations WHERE id NOT IN ({_IN})"))[0][0]


@pytest.mark.anyio
async def test_a_verified_person_takes_their_invite_by_its_id_and_nothing_else_is_made(world):
    before = await _org_count()
    async with _client() as c:
        r = await c.post(_url(INV["a"]), headers=_person(VERIFIED))
    assert r.status_code == 200, r.text
    assert r.json() == {"ok": True, "org_id": str(ORG_A), "role": "member"}
    assert not any(t in r.text for t in TOKENS.values())                      # the token never leaves the server
    assert await _members(ORG_A, VERIFIED) == 1                                 # a member of the invited org
    assert await _members(ORG_B, VERIFIED) == 0                                 # … and only that one
    assert await _org_count() == before                                         # no new organization
    assert (await _rows(f"SELECT status FROM org_invites WHERE id = '{INV['a']}'"))[0][0] == "accepted"


@pytest.mark.anyio
async def test_the_same_invite_taken_twice_is_one_membership_and_the_repeat_finds_nothing(world):
    async with _client() as c:
        first = await c.post(_url(INV["a"]), headers=_person(VERIFIED))
        again = await c.post(_url(INV["a"]), headers=_person(VERIFIED))
    assert first.status_code == 200
    assert again.status_code == 404                                            # it is not pending any more: the same 404 as a missing id
    assert await _members(ORG_A, VERIFIED) == 1


@pytest.mark.anyio
async def test_an_unproved_mailbox_is_refused_and_nothing_is_joined(world):
    async with _client() as c:
        r = await c.post(_url(INV["unv"]), headers=_person(UNVERIFIED))
    assert r.status_code == 403, r.text
    assert await _members(ORG_A, UNVERIFIED) == 0
    assert (await _rows(f"SELECT status FROM org_invites WHERE id = '{INV['unv']}'"))[0][0] == "pending"


@pytest.mark.anyio
async def test_someone_elses_invite_id_and_a_missing_id_are_the_same_404(world):
    async with _client() as c:
        theirs = await c.post(_url(INV["other"]), headers=_person(VERIFIED))
        missing = await c.post(_url(uuid.uuid4()), headers=_person(VERIFIED))
        junk = await c.post(_url("not-a-uuid"), headers=_person(VERIFIED))
    assert (theirs.status_code, missing.status_code, junk.status_code) == (404, 404, 404)
    assert theirs.text == missing.text == junk.text                             # not one byte tells another person's invite from none
    assert await _members(ORG_OTHER, VERIFIED) == 0


@pytest.mark.anyio
async def test_a_key_session_cannot_take_an_invite(world):
    async with _client() as c:
        for claim in ("api_key_id", "human_api_key_id"):
            r = await c.post(_url(INV["a"]), headers=_person(VERIFIED, **{claim: str(uuid.uuid4())}))
            assert r.status_code == 403, (claim, r.text)
    assert await _members(ORG_A, VERIFIED) == 0


@pytest.mark.anyio
async def test_no_session_is_401(world):
    async with _client() as c:
        assert (await c.post(_url(INV["a"]))).status_code == 401


@pytest.mark.anyio
async def test_an_expired_invite_answers_by_the_repositorys_judgment_410(world):
    async with _client() as c:
        expired = await c.post(_url(INV["expired"]), headers=_person(VERIFIED))
    assert expired.status_code == 410, expired.text
    assert await _members(ORG_C, VERIFIED) == 0


@pytest.mark.anyio
async def test_an_old_accepted_invite_is_not_a_way_back_into_an_organization_the_person_left(world):
    """the list shows only pending invites, so only a pending one is found: an accepted invite (membership since removed) is the same 404 as a missing id"""
    async with _client() as c:
        old = await c.post(_url(INV["accepted"]), headers=_person(VERIFIED))
        missing = await c.post(_url(uuid.uuid4()), headers=_person(VERIFIED))
    assert old.status_code == 404 and old.text == missing.text
    assert await _members(ORG_C, VERIFIED) == 0


@pytest.mark.anyio
async def test_an_invite_under_an_untidy_address_is_found_by_the_same_key_the_list_uses(world):
    async with _client() as c:
        r = await c.post(_url(INV["untidy"]), headers=_person(PLAIN_ACCOUNT))
    assert r.status_code == 200, r.text
    assert await _members(ORG_B, PLAIN_ACCOUNT) == 1
