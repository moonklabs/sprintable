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
ORG_E = uuid.UUID("d4427000-0000-0000-0000-00000000000e")  # an owner inviting (the create path)
VERIFIED = uuid.UUID("d4427000-0000-0000-0000-000000000101")
UNVERIFIED = uuid.UUID("d4427000-0000-0000-0000-000000000102")
# older rows whose address kept spaces or capitals (Qadir 4833 · PO 05:12Z): one account, one invite
OLD_ACCOUNT = uuid.UUID("d4427000-0000-0000-0000-000000000103")
PLAIN_ACCOUNT = uuid.UUID("d4427000-0000-0000-0000-000000000104")
OWNER = uuid.UUID("d4427000-0000-0000-0000-000000000105")
ORGS = (ORG_A, ORG_B, ORG_C, ORG_MINE, ORG_E)
TOKENS = {name: f"d4427{name}".ljust(64, "0") for name in ("a", "b", "expired", "revoked", "accepted", "mine", "other", "unv", "oldacct", "oldinv", "dup")}


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
    f"DELETE FROM project_access WHERE org_member_id IN (SELECT id FROM org_members WHERE org_id IN ({_IN}))",
    f"DELETE FROM members WHERE org_id IN ({_IN})",
    f"DELETE FROM org_members WHERE org_id IN ({_IN})",
    f"DELETE FROM users WHERE id IN ('{VERIFIED}','{UNVERIFIED}','{OLD_ACCOUNT}','{PLAIN_ACCOUNT}','{OWNER}')",
    f"DELETE FROM organizations WHERE id IN ({_IN})",
]


async def _rows(q: str) -> list[tuple]:
    eng = create_async_engine(_ASYNC, poolclass=NullPool)
    try:
        async with async_sessionmaker(eng)() as s:
            return [tuple(r) for r in (await s.execute(text(q))).all()]
    finally:
        await eng.dispose()


def _invite(org: uuid.UUID, email: str, token: str, *, status: str = "pending", expires: str = "now() + interval '7 days'",
            created: str = "now()") -> str:
    return ("INSERT INTO org_invites (id,organization_id,email,role,token,status,expires_at,created_at) VALUES "
            f"(gen_random_uuid(),'{org}','{email}','member','{token}','{status}',{expires},{created})")


@pytest.fixture
async def world():
    await _sql(*_CLEAN)
    await _sql(
        f"INSERT INTO organizations (id,name,slug,plan) VALUES ('{ORG_A}','Alpha Co','d4427-a','free'),"
        f"('{ORG_B}','Beta Co','d4427-b','free'),('{ORG_C}','Gamma Co','d4427-c','free'),('{ORG_MINE}','Mine Co','d4427-m','free'),"
        f"('{ORG_E}','Epsilon Co','d4427-e','free')",
        "INSERT INTO users (id,email,hashed_password,display_name,is_active,email_verified,login_fail_count,totp_enabled,"
        "totp_fail_count) VALUES "
        f"('{VERIFIED}','v@d4427.test','x','V',true,true,0,false,0),('{UNVERIFIED}','u@d4427.test','x','U',true,false,0,false,0),"
        # an older account whose address kept a space and capitals; a plain account invited under an older, untidy address
        f"('{OLD_ACCOUNT}',' Old@D4427.Test','x','O',true,true,0,false,0),('{PLAIN_ACCOUNT}','plain@d4427.test','x','P',true,true,0,false,0),"
        f"('{OWNER}','owner@d4427.test','x','Owner',true,true,0,false,0)",
        f"INSERT INTO org_members (id,org_id,user_id,role) VALUES (gen_random_uuid(),'{ORG_MINE}','{VERIFIED}','member'),"
        # Epsilon: its owner, and the older untidy account already a member there
        f"(gen_random_uuid(),'{ORG_E}','{OWNER}','owner'),(gen_random_uuid(),'{ORG_E}','{OLD_ACCOUNT}','member')",
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
        # the untidy pairs: a tidy invite to the older account · an untidy invite to the plain account
        _invite(ORG_C, "old@d4427.test", TOKENS["oldacct"]),
        _invite(ORG_B, " Plain@D4427.test\t", TOKENS["oldinv"]),
        # an older, untidy pending invite in Epsilon
        _invite(ORG_E, " Dup@D4427.Test\t", TOKENS["dup"]),
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


# Qadir 4833 · PO 05:12Z: the list and accept compare addresses the same way (invite_email_key) — before, an older address
# with a space or capitals was listed and then refused at accept (the «new org» screen sends such a person to accept).
@pytest.mark.anyio
@pytest.mark.parametrize(("person", "token", "org", "org_name"), [
    (OLD_ACCOUNT, "oldacct", ORG_C, "Gamma Co"),   # the account's address is untidy
    (PLAIN_ACCOUNT, "oldinv", ORG_B, "Beta Co"),   # the invite's address is untidy
])
async def test_an_untidy_address_on_either_side_is_both_listed_and_accepted(world, person, token, org, org_name):
    async with _client() as c:
        listed = (await c.get("/api/v2/invites/mine", headers=_person(person))).json()["invites"]
        assert [(i["org_name"], i["org_id"]) for i in listed] == [(org_name, str(org))]
        r = await c.post("/api/v2/invites/accept", json={"token": TOKENS[token]}, headers=_person(person))
        assert r.status_code == 200, r.text
        assert r.json()["org_id"] == str(org)
        # accepted → a member now, so the list no longer shows it
        assert (await c.get("/api/v2/invites/mine", headers=_person(person))).json() == {"invites": []}


# Qadir 4833 · PO 05:12Z: an agent key is refused by name — not left to its member id failing to match a users.id. The
# contract for «not a person» on this endpoint is an empty list (the docstring · no user · unverified). The hard case: the
# key's subject IS a verified person's id; the control is the same subject without the agent mark.
@pytest.mark.anyio
async def test_an_agent_key_gets_an_empty_list_even_when_its_subject_matches_a_verified_person(world):
    from app.dependencies.auth import AuthContext, get_current_user
    from app.main import app

    def as_caller(api_key: bool):
        meta = {"org_id": str(ORG_MINE), **({"api_key_id": str(uuid.uuid4())} if api_key else {})}
        return lambda: AuthContext(user_id=str(VERIFIED), email=None, claims={"sub": str(VERIFIED), "app_metadata": meta})

    try:
        async with _client() as c:
            app.dependency_overrides[get_current_user] = as_caller(api_key=False)
            control = (await c.get("/api/v2/invites/mine")).json()["invites"]
            assert [i["org_name"] for i in control] == ["Beta Co", "Alpha Co"], "control: the same subject as a person sees them"
            app.dependency_overrides[get_current_user] = as_caller(api_key=True)
            r = await c.get("/api/v2/invites/mine")
        assert (r.status_code, r.json()) == (200, {"invites": []})
    finally:
        app.dependency_overrides.pop(get_current_user, None)


# PO 05:15Z — the same comparison everywhere an invite's email is compared: making an invite sees an older untidy pending
# invite as a duplicate and an older untidy account as already a member; the invitee's locale finds the untidy account.
@pytest.mark.anyio
@pytest.mark.parametrize(("email", "detail"), [
    ("dup@d4427.test", "Invite already exists for this email"),       # a pending invite stored as " Dup@D4427.Test\t"
    ("  DUP@d4427.test ", "Invite already exists for this email"),
    ("old@d4427.test", "Email already a member of this organization"),  # a member whose account is " Old@D4427.Test"
])
async def test_inviting_again_sees_the_untidy_older_rows(world, email, detail):
    async with _client() as c:
        r = await c.post(f"/api/v2/organizations/{ORG_E}/invites", json={"email": email}, headers=_person(OWNER))
    assert (r.status_code, r.json()["error"]["message"]) == (409, detail), r.text
    rows = await _rows(f"SELECT count(*) FROM org_invites WHERE organization_id='{ORG_E}'")
    assert rows == [(1,)], "no second invite row was made"


@pytest.mark.anyio
async def test_the_invitee_locale_is_found_through_an_untidy_account_address(world):
    from app.routers.org_invites import _resolve_invitee_locale

    await _sql(f"UPDATE users SET locale='en' WHERE id='{OLD_ACCOUNT}'")
    eng = create_async_engine(_ASYNC, poolclass=NullPool)
    try:
        async with async_sessionmaker(eng)() as s:
            assert await _resolve_invitee_locale(s, "old@d4427.test") == "en"
    finally:
        await eng.dispose()


# PO 05:15Z — the login fallback (auth.py _build_app_metadata: no member yet → a pending invite to the person's email is
# accepted) finds an untidy older invite too. PLAIN_ACCOUNT belongs to no org; its one invite is stored " Plain@D4427.test\t".
@pytest.mark.anyio
async def test_the_login_fallback_accepts_an_untidy_older_invite(world):
    from app.models.user import User
    from app.routers.auth import _build_app_metadata

    eng = create_async_engine(_ASYNC, poolclass=NullPool)
    try:
        async with async_sessionmaker(eng)() as s:
            user = await s.get(User, PLAIN_ACCOUNT)
            md = await _build_app_metadata(user, s)
            await s.commit()
    finally:
        await eng.dispose()
    assert md["org_id"] == str(ORG_B)
    assert await _rows(f"SELECT role FROM org_members WHERE org_id='{ORG_B}' AND user_id='{PLAIN_ACCOUNT}'") == [("member",)]
    assert await _rows(f"SELECT status FROM org_invites WHERE token='{TOKENS['oldinv']}'") == [("accepted",)]
