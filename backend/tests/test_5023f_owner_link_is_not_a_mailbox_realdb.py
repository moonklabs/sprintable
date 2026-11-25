"""story 5023 (f) — the owner's hand-over reset link (5023 d) is NOT a mailbox proof. Found by the PO's reading of 5922 and the review of 5923: `reset_password` made an account nobody had proved `email_verified=true` («the mailed link
proves the mailbox», story 4725). On a workspace server (no mail) the link is not mailed — an OWNER hands it over; whoever opens it (the owner himself, too) would make that account «verified», and a verified account opens
`/invites/mine` and its accept: every OTHER organization's pending invitation for that address, without its token. And the same reclaim dropped a member's two-factor secret and provider links — the owner stepping round a 2FA.
Over real HTTP on a migrated PG (ALEMBIC_DATABASE_URL), on the worlds of `test_5023d_owner_reset_realdb`.

Each test goes red without the line it names:
F1  a server host: the person's account stays `email_verified=false` through the owner's link; ORG2 has a pending invitation for the same address; after the link the person signs in with the new password and `/invites/mine` is empty and the accept by id is refused (no membership of ORG2)
F2  a server host: the link keeps what a reset keeps for a verified account — the two-factor secret and the provider links stay (the owner does not step round them) — while the password changes and the refresh sessions end
F3  not a server host (the rule off · hosted · the desktop app): the mailed link of an account nobody proved still proves its mailbox — verified, the squatter's leftovers dropped (story 4725, unchanged)
F4  not a server host: a VERIFIED account keeps its two-factor secret and provider links through a reset (the unproved-account road is only for an unproved account)
"""
from __future__ import annotations

import asyncio
import uuid
from datetime import datetime, timedelta, timezone

import pytest

from app.core.config import settings
from tests.test_5023d_owner_reset_realdb import (  # noqa: F401 — fixtures and helpers of the same world
    LINK,
    NEW_PW,
    OLD_PW,
    ORG,
    ORG2,
    OWNER,
    PLAIN,
    _client,
    _dispose_global_engine_after_test,
    _mid,
    _person,
    _server_host,
    _sql,
    anyio_backend,
    pytestmark,
    world,
)

PLAIN_MAIL = "plain@d4424.test"


async def _link_token(c) -> str:
    r = await c.post(LINK(await _mid(PLAIN)), headers=_person(OWNER))
    assert r.status_code == 200, r.text
    return r.json()["reset_url"].split("token=")[1]


async def _pending_invite_from_org2(email: str) -> uuid.UUID:
    iid = uuid.uuid4()
    await _sql(
        f"INSERT INTO org_invites (id, organization_id, email, role, status, expires_at, token) VALUES "
        f"('{iid}', '{ORG2}', '{email}', 'member', 'pending', '{(datetime.now(timezone.utc) + timedelta(days=7)).isoformat()}', 'tok5023f{uuid.uuid4().hex}')"
    )
    return iid


async def test_f1_the_owners_link_does_not_verify_the_account_and_opens_no_other_organizations_invitation(world):
    async with _client() as c:
        await _sql(f"UPDATE users SET email_verified = false WHERE id = '{PLAIN}'")
        invite_id = await _pending_invite_from_org2(PLAIN_MAIL)
        token = await _link_token(c)
        assert (await c.post("/api/v2/auth/reset-password", json={"token": token, "new_password": NEW_PW})).status_code == 200
        assert (await _sql(fetch=f"SELECT email_verified FROM users WHERE id = '{PLAIN}'"))[0][0] is False
        signed = await c.post("/api/v2/auth/token", json={"email": PLAIN_MAIL, "password": NEW_PW})
        assert signed.status_code == 200, signed.text
        await asyncio.sleep(1.2)  # a token is stamped in whole seconds: one made in the second of the password change counts as older than it
        bearer = _person(PLAIN)  # the person's own session (the world signs a token for them)
        mine = await c.get("/api/v2/invites/mine", headers=bearer)
        assert mine.status_code == 200 and mine.json()["invites"] == [], mine.text
        accept = await c.post(f"/api/v2/invites/mine/{invite_id}/accept", headers=bearer)
        assert accept.status_code >= 400, accept.text
        assert (await _sql(fetch=f"SELECT count(*) FROM org_members WHERE org_id = '{ORG2}' AND user_id = '{PLAIN}' AND deleted_at IS NULL"))[0][0] == 0


async def test_f2_the_link_keeps_the_two_factor_secret_and_the_provider_links(world):
    async with _client() as c:
        await _sql(f"UPDATE users SET email_verified = false, totp_enabled = true, totp_secret = 'JBSWY3DPEHPK3PXP', google_id = 'g-5023f' WHERE id = '{PLAIN}'")
        token = await _link_token(c)
        assert (await c.post("/api/v2/auth/reset-password", json={"token": token, "new_password": NEW_PW})).status_code == 200
        row = (await _sql(fetch=f"SELECT totp_enabled, totp_secret IS NOT NULL, google_id, email_verified FROM users WHERE id = '{PLAIN}'"))[0]
        assert tuple(row) == (True, True, "g-5023f", False)


async def test_f3_off_a_server_host_the_mailed_link_of_an_unproved_account_still_proves_its_mailbox(world, monkeypatch):
    monkeypatch.setattr(settings, "server_owner_setup", False)  # the rule off: the desktop app / hosted — the mailed link is a mailed link
    from app.core.security import create_password_reset_token

    async with _client() as c:
        await _sql(f"UPDATE users SET email_verified = false, totp_enabled = true, totp_secret = 'JBSWY3DPEHPK3PXP', google_id = 'g-5023f' WHERE id = '{PLAIN}'")
        hashed = (await _sql(fetch=f"SELECT hashed_password FROM users WHERE id = '{PLAIN}'"))[0][0]
        token = create_password_reset_token(str(PLAIN), hashed)
        assert (await c.post("/api/v2/auth/reset-password", json={"token": token, "new_password": NEW_PW})).status_code == 200
        row = (await _sql(fetch=f"SELECT email_verified, totp_enabled, google_id FROM users WHERE id = '{PLAIN}'"))[0]
        assert row[0] is True and row[1] is False and row[2] is None  # verified; the leftovers dropped — as story 4725 made it


async def test_f4_off_a_server_host_a_verified_account_keeps_its_two_factor_and_provider_links_through_a_reset(world, monkeypatch):
    monkeypatch.setattr(settings, "server_owner_setup", False)
    from app.core.security import create_password_reset_token

    async with _client() as c:
        await _sql(f"UPDATE users SET email_verified = true, totp_enabled = true, totp_secret = 'JBSWY3DPEHPK3PXP', google_id = 'g-5023f' WHERE id = '{PLAIN}'")
        hashed = (await _sql(fetch=f"SELECT hashed_password FROM users WHERE id = '{PLAIN}'"))[0][0]
        token = create_password_reset_token(str(PLAIN), hashed)
        assert (await c.post("/api/v2/auth/reset-password", json={"token": token, "new_password": NEW_PW})).status_code == 200
        assert tuple((await _sql(fetch=f"SELECT email_verified, totp_enabled, google_id FROM users WHERE id = '{PLAIN}'"))[0]) == (True, True, "g-5023f")
