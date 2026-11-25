"""story 5023 (d) — a workspace SERVER has no mail: its OWNER hands a member a password-reset link (`POST /api/v2/org-members/{id}/password-reset-link`).

Only on a server host (embedded + the host's own switch) · only an owner of the organization, in a person's session · for a member of THIS organization who is not the owner asking, not an owner, and in no other organization.
The link is the ordinary reset link (30 minutes · dead once the password changes). Real database; the harness (people · organizations) is test_4424's.
"""
from __future__ import annotations

import uuid
from datetime import datetime, timedelta, timezone

import pytest

from app.core.config import settings
from tests.test_4424_desktop_setup_realdb import (  # noqa: F401 — fixtures (autouse ones apply here too)
    ORG,
    ORG2,
    OUTSIDER,
    OWNER,
    PLAIN,
    _addresses,
    _dispose_global_engine_after_test,
    _person,
    _sql,
    anyio_backend,
    world,
)

pytestmark = pytest.mark.anyio


def _client():
    """the server host answers only to its own loopback Host (TrustedHost, `local_auth.py`): the client names it"""
    from httpx import ASGITransport, AsyncClient

    from app.main import app

    return AsyncClient(transport=ASGITransport(app=app, raise_app_exceptions=False), base_url="http://127.0.0.1")

APP = "https://team.lap.test"
OLD_PW, NEW_PW = "Old-pw-5023d-1!", "New-pw-5023d-2!"
ADMIN = uuid.UUID("d5023d00-0000-0000-0000-000000000031")
THIRD = uuid.UUID("d5023d00-0000-0000-0000-000000000032")  # a second plain member
LINK = lambda mid: f"/api/v2/org-members/{mid}/password-reset-link"  # noqa: E731


@pytest.fixture(autouse=True)
async def _server_host(world, monkeypatch):
    """the host's own start switches the rule on; the app's address is the public one; every person's sign-in has a real hash; the limits start empty"""
    from app.core.rate_limit import reset_person_limits
    from app.core.security import hash_password

    monkeypatch.setenv("SPRINTABLE_EMBEDDED", "1")  # `is_embedded` is a property: this variable AND a bootstrap secret of 32+ characters
    monkeypatch.setattr(settings, "local_bootstrap_secret", "b" * 40)
    monkeypatch.setattr(settings, "server_owner_setup", True)
    monkeypatch.setattr(settings, "app_url", APP)
    reset_person_limits()
    pw = hash_password(OLD_PW)
    await _sql(
        f"INSERT INTO users (id,email,hashed_password,display_name,is_active,email_verified,login_fail_count,totp_enabled,totp_fail_count) VALUES "
        f"('{ADMIN}','admin@d5023d.test','x','Admin',true,true,0,false,0),('{THIRD}','third@d5023d.test','x','Third',true,true,0,false,0)",
        f"INSERT INTO org_members (id,org_id,user_id,role) VALUES (gen_random_uuid(),'{ORG}','{ADMIN}','admin'),(gen_random_uuid(),'{ORG}','{THIRD}','member')",
    )
    for u in (OWNER, PLAIN, ADMIN, THIRD, OUTSIDER):
        await _sql(f"UPDATE users SET hashed_password = '{pw}' WHERE id = '{u}'")
    yield
    await _sql(f"DELETE FROM login_audit_logs WHERE event_type = 'owner_password_reset_link_issued'", f"DELETE FROM org_members WHERE user_id IN ('{ADMIN}','{THIRD}')", f"DELETE FROM users WHERE id IN ('{ADMIN}','{THIRD}')")


async def _mid(user: uuid.UUID, org: uuid.UUID = ORG) -> uuid.UUID:
    return (await _sql(fetch=f"SELECT id FROM org_members WHERE org_id = '{org}' AND user_id = '{user}'"))[0][0]


async def _error(r) -> str | None:
    try:
        return r.json()["error"]["code"]
    except Exception:  # noqa: BLE001
        return None


# ── the road: link → the person sets their own password → the owner never saw one ──────────────────────────────────────────────────────────────────────────────────────

async def test_a1_the_owner_hands_a_link_and_the_person_sets_their_own_password_with_it(world):
    from app.core.security import decode_password_reset_token

    async with _client() as c:
        r = await c.post(LINK(await _mid(PLAIN)), headers=_person(OWNER))
        assert r.status_code == 200, r.text
        body = r.json()
        assert set(body) == {"reset_url", "expires_in_seconds"} and body["expires_in_seconds"] == 1800 and "no-store" in r.headers.get("cache-control", "")
        assert body["reset_url"].startswith(f"{APP}/reset-password?token=")
        token = body["reset_url"].split("token=")[1]
        assert decode_password_reset_token(token)["sub"] == str(PLAIN)  # the link is for THAT person
        # the person opens it and sets a password of their own (the page's call)
        done = await c.post("/api/v2/auth/reset-password", json={"token": token, "new_password": NEW_PW})
        assert done.status_code == 200, done.text
        assert (await c.post("/api/v2/auth/token", json={"email": "plain@d4424.test", "password": NEW_PW})).status_code == 200
        assert (await c.post("/api/v2/auth/token", json={"email": "plain@d4424.test", "password": OLD_PW})).status_code in (400, 401)
        # a link is used once: the same one again is dead (the password it was made for is gone)
        again = await c.post("/api/v2/auth/reset-password", json={"token": token, "new_password": "Another-pw-9!"})
        assert again.status_code == 400


async def test_a2_the_audit_row_names_who_was_given_a_link_by_which_owner_and_never_the_link(world):
    async with _client() as c:
        r = await c.post(LINK(await _mid(PLAIN)), headers=_person(OWNER))
        token = r.json()["reset_url"].split("token=")[1]
    rows = await _sql(fetch="SELECT user_id, detail FROM login_audit_logs WHERE event_type = 'owner_password_reset_link_issued'")
    assert len(rows) == 1 and rows[0][0] == PLAIN and str(await _mid(OWNER)) in rows[0][1] and token not in rows[0][1] and "token" not in rows[0][1].lower()


# ── where it does not exist ──────────────────────────────────────────────────────────────────────────────────────────────────────────────────────────────────────────

async def test_b1_it_is_not_there_on_hosted_or_in_the_desktop_app(world, monkeypatch):
    async with _client() as c:
        mid = await _mid(PLAIN)
        monkeypatch.setattr(settings, "server_owner_setup", False)  # the desktop app: embedded, but the host's switch is off
        r = await c.post(LINK(mid), headers=_person(OWNER))
        assert r.status_code == 404 and await _error(r) == "not_available"
        monkeypatch.delenv("SPRINTABLE_EMBEDDED", raising=False)  # hosted: not embedded at all (the host's switch alone does nothing)
        monkeypatch.setattr(settings, "server_owner_setup", True)
        r2 = await c.post(LINK(mid), headers=_person(OWNER))
        assert r2.status_code == 404 and await _error(r2) == "not_available"
        # and the members list does not offer it anywhere
        listed = (await c.get("/api/v2/org-members", headers=_person(OWNER))).json()
        assert listed and all(m["password_reset_link_available"] is False for m in listed)


# ── who may ask ──────────────────────────────────────────────────────────────────────────────────────────────────────────────────────────────────────────────────────

async def test_c1_only_an_owner_of_this_organization(world):
    async with _client() as c:
        mid = await _mid(THIRD)
        for who, why in ((ADMIN, "an admin"), (PLAIN, "a plain member"), (OUTSIDER, "an admin of ANOTHER organization")):
            r = await c.post(LINK(mid), headers=_person(who, ORG2 if who == OUTSIDER else ORG))
            assert r.status_code in (403, 404), f"{why}: {r.status_code} {r.text}"
            assert r.status_code != 200
        r = await c.post(LINK(mid), headers=_person(ADMIN))
        assert r.status_code == 403 and await _error(r) == "ORG_MEMBER_OWNER_ONLY_ACTION"


async def test_c2_an_agent_or_a_key_never_hands_out_a_way_into_a_persons_account(world):
    from tests.test_4529_desktop_relay_realdb import _device

    async with _client() as c:
        device = await _device(c, name="d4424 mac 5023d")
        key = {"Authorization": f"Bearer {device['agents'][0]['api_key']}", "X-Org-Id": str(ORG)}
        r = await c.post(LINK(await _mid(PLAIN)), headers=key)
        assert r.status_code == 403 and await _error(r) == "person_session_required"


async def test_c3_nobody_signed_in_gets_nothing(world):
    async with _client() as c:
        assert (await c.post(LINK(await _mid(PLAIN)))).status_code in (401, 403, 422)


# ── for whom ────────────────────────────────────────────────────────────────────────────────────────────────────────────────────────────────────────────────────────

async def test_d1_not_for_oneself_not_for_an_owner_not_for_somebody_else_the_other_organization_or_nobody(world):
    async with _client() as c:
        me = await _mid(OWNER)
        r = await c.post(LINK(me), headers=_person(OWNER)); assert r.status_code == 409 and await _error(r) == "ORG_RESET_SELF"
        # a second owner: one owner does not take over another
        await _sql(f"UPDATE org_members SET role = 'owner' WHERE org_id = '{ORG}' AND user_id = '{THIRD}'")
        r = await c.post(LINK(await _mid(THIRD)), headers=_person(OWNER)); assert r.status_code == 403 and await _error(r) == "ORG_RESET_OWNER_FORBIDDEN"
        await _sql(f"UPDATE org_members SET role = 'member' WHERE org_id = '{ORG}' AND user_id = '{THIRD}'")
        # somebody who is also a member of another organization: the link would hand that account (and that organization) to this owner
        await _sql(f"INSERT INTO org_members (id,org_id,user_id,role) VALUES (gen_random_uuid(),'{ORG2}','{PLAIN}','member')")
        r = await c.post(LINK(await _mid(PLAIN)), headers=_person(OWNER)); assert r.status_code == 409 and await _error(r) == "ORG_RESET_PERSON_IN_OTHER_ORGS"
        # a member of ANOTHER organization named by its id: not found here (the caller's organization is the scope)
        r = await c.post(LINK(await _mid(OUTSIDER, ORG2)), headers=_person(OWNER)); assert r.status_code == 404 and await _error(r) == "org_member_not_found"
        r = await c.post(LINK(uuid.uuid4()), headers=_person(OWNER)); assert r.status_code == 404
        # and none of those made a link or an audit row
        assert (await _sql(fetch="SELECT count(*) FROM login_audit_logs WHERE event_type = 'owner_password_reset_link_issued'"))[0][0] == 0


async def test_d3_a_person_who_left_the_other_organization_is_no_longer_in_it(world):
    async with _client() as c:
        await _sql(f"INSERT INTO org_members (id,org_id,user_id,role,deleted_at) VALUES (gen_random_uuid(),'{ORG2}','{PLAIN}','member', now())")  # removed from the other organization
        listed = {m["user_id"]: m["password_reset_link_available"] for m in (await c.get("/api/v2/org-members", headers=_person(OWNER))).json()}
        assert listed[str(PLAIN)] is True
        assert (await c.post(LINK(await _mid(PLAIN)), headers=_person(OWNER))).status_code == 200


async def test_d2_a_removed_member_is_not_found(world):
    async with _client() as c:
        mid = await _mid(THIRD)
        await _sql(f"UPDATE org_members SET deleted_at = now() WHERE id = '{mid}'")
        r = await c.post(LINK(mid), headers=_person(OWNER)); assert r.status_code == 404


# ── the list says where the button is ──────────────────────────────────────────────────────────────────────────────────────────────────────────────────────────────

async def test_e1_the_list_offers_it_only_to_an_owner_and_only_for_the_eligible(world):
    async with _client() as c:
        await _sql(f"INSERT INTO org_members (id,org_id,user_id,role) VALUES (gen_random_uuid(),'{ORG2}','{THIRD}','member')")  # THIRD is in another organization too
        listed = {m["user_id"]: m["password_reset_link_available"] for m in (await c.get("/api/v2/org-members", headers=_person(OWNER))).json()}
        assert listed[str(PLAIN)] is True  # eligible
        assert listed[str(OWNER)] is False  # oneself
        assert listed[str(ADMIN)] is True  # an admin is not an owner: eligible
        assert listed[str(THIRD)] is False  # also in another organization
        # an admin sees the roster (their own right) but is offered nothing
        as_admin = (await c.get("/api/v2/org-members", headers=_person(ADMIN))).json()
        assert as_admin and all(m["password_reset_link_available"] is False for m in as_admin)
        # the list and the route agree: what the list offers, the route gives; what it does not, the route refuses
        assert (await c.post(LINK(await _mid(PLAIN)), headers=_person(OWNER))).status_code == 200
        assert (await c.post(LINK(await _mid(THIRD)), headers=_person(OWNER))).status_code == 409


async def test_e2_a_second_owner_is_not_offered_and_not_given_a_link(world):
    async with _client() as c:
        await _sql(f"UPDATE org_members SET role = 'owner' WHERE org_id = '{ORG}' AND user_id = '{ADMIN}'")
        listed = {m["user_id"]: m["password_reset_link_available"] for m in (await c.get("/api/v2/org-members", headers=_person(OWNER))).json()}
        assert listed[str(ADMIN)] is False and listed[str(PLAIN)] is True
        r = await c.post(LINK(await _mid(ADMIN)), headers=_person(OWNER)); assert r.status_code == 403 and await _error(r) == "ORG_RESET_OWNER_FORBIDDEN"
        # and the second owner, asking, is offered the same rows the first one was (an owner is an owner)
        as_second = {m["user_id"]: m["password_reset_link_available"] for m in (await c.get("/api/v2/org-members", headers=_person(ADMIN))).json()}
        assert as_second[str(PLAIN)] is True and as_second[str(OWNER)] is False and as_second[str(ADMIN)] is False


# ── a limit: ten an hour per owner; a refused try is not a link and does not use one up ──────────────────────────────────────────────────────────────────────────────────

async def test_f1_ten_links_an_hour_and_refusals_do_not_count(world):
    async with _client() as c:
        for _ in range(12):  # refusals first: oneself (409) — they must not use up the ten
            assert (await c.post(LINK(await _mid(OWNER)), headers=_person(OWNER))).status_code == 409
        mid = await _mid(PLAIN)
        for i in range(10):
            r = await c.post(LINK(mid), headers=_person(OWNER)); assert r.status_code == 200, (i, r.text)
        r = await c.post(LINK(mid), headers=_person(OWNER))
        assert r.status_code == 429 and await _error(r) == "RATE_LIMITED" and int(r.headers["retry-after"]) > 0


# ── an account nobody proved the mailbox of: the link still works (the server has no mail to prove it with) ───────────────────────────────────────────────────────────────

async def test_g1_a_member_whose_email_was_never_verified_can_still_use_the_link(world):
    async with _client() as c:
        await _sql(f"UPDATE users SET email_verified = false WHERE id = '{PLAIN}'")
        token = (await c.post(LINK(await _mid(PLAIN)), headers=_person(OWNER))).json()["reset_url"].split("token=")[1]
        done = await c.post("/api/v2/auth/reset-password", json={"token": token, "new_password": NEW_PW})
        assert done.status_code == 200, done.text
        assert (await c.post("/api/v2/auth/token", json={"email": "plain@d4424.test", "password": NEW_PW})).status_code == 200
