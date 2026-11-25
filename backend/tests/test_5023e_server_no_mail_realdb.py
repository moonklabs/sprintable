"""story 5023 (B2-2, e) — what a workspace SERVER (no mail) does about «verify your e-mail», and an invitation link that names only the server computer.
Over real HTTP on a migrated PG (ALEMBIC_DATABASE_URL), on the worlds of `test_5023a_first_owner_realdb` (one outer transaction, rolled back).

THE DECISION these tests pin (codex review, two passes): an account is NEVER made `email_verified` because the SERVER let it in (the setup code · an invitation link). «Verified» means a proved mailbox, and it opens
`/invites/mine` and the invitation auto-accept (every other organization's pending invitation for that address, no token) — a link or a setup code proves control of a LINK or of the SERVER, not of the mailbox.
What a no-mail server does instead is say `email_verification_required: false` on `/auth/me` (its supervisor turns `require_verified_email_for_org_create` off) and the web follows it.

V1  the first owner (right setup code) and an invited person are let in but stay UNVERIFIED, and the first owner can still make the organization (the server does not ask); a wrong / missing code makes NO account
V2  `/auth/me` of such a person says `email_verified: false` AND `email_verification_required: false` — the pair the onboarding page reads to open the door instead of «check your inbox»
V3  an invitation link made while the server's address is `localhost` says `link_is_local`; with a public address, on a hosted deployment, on the desktop app: not
"""
from __future__ import annotations

import uuid
from datetime import datetime, timedelta, timezone

import pytest
from sqlalchemy import text

from tests.test_5023a_first_owner_realdb import (  # noqa: F401  (fixtures and helpers of the same worlds)
    _body,
    _code,
    _dispose_global_engine_after_test,
    _make_owner,
    _mail,
    _register,
    anyio_backend,
    make_world,
    pytestmark,
)


async def _row(w, email: str):
    async with w.session() as s:
        return (await s.execute(text("SELECT email_verified FROM users WHERE lower(email) = lower(:e)"), {"e": email})).first()


async def _invite(w, org_id: str, email: str) -> str:
    from app.models.org_invite import OrgInvite

    async with w.session() as s:
        inv = OrgInvite(organization_id=uuid.UUID(org_id), email=email, role="member", status="pending", expires_at=datetime.now(timezone.utc) + timedelta(days=7))
        s.add(inv)
        await s.commit()
        return inv.token


async def test_v1_nobody_is_verified_because_the_server_let_them_in(make_world):
    from app.services import server_owner_setup

    async with make_world(embedded=True, rule=True) as w:
        for wrong in (None, "", "AAAA-AAAA-AAAA-AAAA"):
            mail = _mail("w")
            r = await _register(w, email=mail, **({"setup_code": wrong} if wrong is not None else {}))
            assert r.status_code == 403 and _code(r) == "SETUP_CODE_REQUIRED" and await _row(w, mail) is None
        first = _mail("first")
        ok = await _register(w, email=first, setup_code=server_owner_setup.setup_code())
        assert ok.status_code == 201, ok.text
        assert (await _row(w, first))[0] is False  # the setup code proves the SERVER, not the mailbox
        token = ok.json()["data"]["access_token"]
        async with w.client(headers={"Authorization": f"Bearer {token}"}) as c:
            org = await c.post("/api/v2/organizations", json={"name": "No Mail Lab"})
        assert org.status_code == 201, org.text  # …and the server does not ask for it (its supervisor turned the requirement off)
        org_id = org.json()["data"]["id"] if "data" in org.json() else org.json()["id"]
        invited = _mail("inv")
        link = await _invite(w, org_id, invited.upper())
        joined = await _register(w, email=invited.lower(), invite_token=link)
        assert joined.status_code == 201, joined.text
        assert (await _row(w, invited))[0] is False  # let in by the owner's link, not vouched for a mailbox (that would open /invites/mine for every other organization's invitation to this address)


async def test_v2_me_says_unverified_and_not_required_on_a_server_that_cannot_send_mail(make_world):
    from app.services import server_owner_setup

    async with make_world(embedded=True, rule=True) as w:
        r = await _register(w, email=_mail("me"), setup_code=server_owner_setup.setup_code())
        token = r.json()["data"]["access_token"]
        async with w.client(headers={"Authorization": f"Bearer {token}"}) as c:
            me = await c.get("/api/v2/auth/me")
        assert me.status_code == 200, me.text
        data = me.json()["data"] if "data" in me.json() else me.json()
        assert data["email_verified"] is False and data["email_verification_required"] is False


async def test_v3_an_invitation_link_says_when_its_address_is_only_the_server_computers(make_world, monkeypatch):
    from app.core.config import settings
    from app.models.org_invite import OrgInvite
    from app.routers import org_invites

    def pending() -> OrgInvite:
        inv = OrgInvite(organization_id=uuid.uuid4(), email=_mail("l"), role="member", status="pending", expires_at=datetime.now(timezone.utc) + timedelta(days=7))
        inv.id = uuid.uuid4(); inv.created_at = datetime.now(timezone.utc); inv.token = "t" * 40; inv.project_ids = []
        for k in ("accepted_at", "created_by", "email_sent_at", "email_error"):
            setattr(inv, k, None)
        return inv

    async with make_world(embedded=True, rule=True):  # a workspace server
        for app_url, local in [("http://localhost:3000", True), ("http://127.0.0.1:8787", True), ("https://team.example.com", False), ("https://localhost.example.com", False)]:
            monkeypatch.setattr(settings, "app_url", app_url)
            resp = org_invites._to_response(pending())
            assert resp.invite_url and resp.invite_url.startswith(app_url) and resp.link_is_local is local, app_url
        done = pending(); done.status = "accepted"
        monkeypatch.setattr(settings, "app_url", "http://localhost:3000")
        assert org_invites._to_response(done).invite_url is None and org_invites._to_response(done).link_is_local is False  # no link, nothing to warn about
    for embedded, rule in [(False, False), (False, True), (True, False)]:  # hosted · the switch alone · the desktop app: never
        async with make_world(embedded=embedded, rule=rule):
            monkeypatch.setattr(settings, "app_url", "http://localhost:3000")
            assert org_invites._to_response(pending()).link_is_local is False, (embedded, rule)
