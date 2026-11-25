"""story 5023 (B2-2, a) — who may make an account on a workspace SERVER (a headless Linux host), and the answer `sprintable-host server set-public-origin` asks before it opens the door.

A server host has no app and so no owner made by `local-bootstrap`: until somebody makes the first account that creates the organization, anybody who could reach the page could sign up and become the owner. This module closes that with one rule, only when the
host switches it on (`SERVER_OWNER_SETUP=1`, set by the server host's own start — never by the desktop app, which keeps its sign-up exactly as it is, and never on a hosted deployment: it needs `settings.is_embedded`):

  · NO OWNER YET  → a sign-up needs the SETUP CODE (printed by `sprintable-host server status` on the server, to the person who has a shell there). The code is derived from the install's own secret, so nothing new is stored and it stops mattering the moment an owner exists.
  · AN OWNER EXISTS → sign-up is CLOSED, except with an invitation: the e-mail must be the invited one, the invitation pending and not expired. Everyone else joins by being invited.

`owner_exists` is any live `owner` row of `org_members`. The state route (`routers/server_setup.py`) reports `{owner_exists, signup_open}`; «open» means a stranger could still register: it is False exactly when the rule above is on and an owner exists.
"""
from __future__ import annotations

import base64
import hashlib
import hmac
import re
from datetime import datetime, timezone

from sqlalchemy import select
from sqlalchemy.ext.asyncio import AsyncSession

from app.core.config import settings
from app.models.org_invite import OrgInvite
from app.models.project import OrgMember
from app.repositories.org_invite import invite_email_key

_CODE_LABEL = b"sprintable-first-owner-setup-v1"


def enabled() -> bool:
    """The rule is on: this is a workspace server (embedded, never Cloud Run) AND its host asked for it."""
    return bool(settings.is_embedded and settings.server_owner_setup)


def setup_code() -> str:
    """`XXXX-XXXX-XXXX-XXXX` (80 bits, base32) derived from the install's secret. The server host derives the same text to show it; nothing is stored."""
    mac = hmac.new(settings.local_bootstrap_secret.encode(), _CODE_LABEL, hashlib.sha256).digest()[:10]
    raw = base64.b32encode(mac).decode().rstrip("=")
    return "-".join(raw[i : i + 4] for i in range(0, 16, 4))


def code_matches(provided: str | None) -> bool:
    """Constant-time; case, spaces and dashes in what a person typed do not matter."""
    normal = re.sub(r"[\s-]", "", (provided or "")).upper()
    expected = re.sub(r"-", "", setup_code())
    return hmac.compare_digest(normal.encode(), expected.encode())


async def owner_exists(session: AsyncSession) -> bool:
    found = await session.execute(select(OrgMember.id).where(OrgMember.role == "owner", OrgMember.deleted_at.is_(None)).limit(1))
    return found.first() is not None


async def signup_refusal(session: AsyncSession, *, email: str, setup_code_given: str | None, invite_token: str | None) -> tuple[str, str] | None:
    """None = this sign-up may go on. Otherwise `(code, message)` for a 403. Nothing is written here; a rule that is off allows everything (the app and hosted behaviour are unchanged)."""
    if not enabled():
        return None
    if not await owner_exists(session):
        if code_matches(setup_code_given):
            return None
        return "SETUP_CODE_REQUIRED", "This server has no owner yet: sign up with the setup code shown by `sprintable-host server status` on the server"
    if invite_token:
        now = datetime.now(timezone.utc)
        invite = (await session.execute(select(OrgInvite).where(OrgInvite.token == invite_token))).scalar_one_or_none()
        if invite is not None and invite.status == "pending" and invite.expires_at > now and invite_email_key(invite.email or "") == invite_email_key(email or ""):
            return None
    return "SIGNUP_CLOSED", "Sign-up is closed on this server: ask the owner to invite you"
