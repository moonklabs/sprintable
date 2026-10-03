"""story #4548 (E-DESKTOP-2 B-1) — an already set-up device gets its relay token by a person's confirmation.

Setting it up again would make new agents (new members · new keys · the old agents' work left behind), so the app asks for a
short code with that setup's own agent key, an owner/admin of its org confirms on the web, and the app exchanges the code with
its PKCE verifier for the device token alone (contract doc 02d2cf71 v1.4 §1.1). The agents and their keys are untouched; an
earlier device token is revoked.

The key only asks: the token still needs the person's confirmation and the verifier the app holds, so an agent key never mints
a device token (PO 05:19Z · 08:36Z). The code is asked with the key, not openly, because a confirmation screen headed by a real
computer's name is a consent someone could fish for with nothing but a setup id (PO 08:36Z).
"""
from __future__ import annotations

import hmac
import secrets
import uuid
from dataclasses import dataclass
from datetime import datetime, timedelta, timezone

from sqlalchemy import select
from sqlalchemy.ext.asyncio import AsyncSession

from app.models.desktop_relay import DesktopDeviceTokenCode
from app.models.desktop_setup import DesktopSetup
from app.services.desktop_setup import _CHALLENGE_RE, _VERIFIER_RE, DesktopSetupError, _hash
from app.services.oauth_handoff import pkce_challenge_from_verifier

CODE_TTL = timedelta(minutes=10)


def _now() -> datetime:
    return datetime.now(timezone.utc)


async def create_code(db: AsyncSession, *, api_key_id: str | None, setup_id: uuid.UUID, challenge: str) -> tuple[str, datetime]:
    """One answer for every refusal (`setup_not_found`): no key · another setup's key · a revoked key · a disconnected or never
    handed-over setup — a caller learns nothing about a setup it does not hold the key of."""
    from app.models.api_key import ApiKey

    if not _CHALLENGE_RE.match(challenge):
        raise DesktopSetupError("request_invalid", "challenge must be base64url(sha256(verifier)) without padding")
    key_id = _uuid(api_key_id)
    setup = None
    if key_id is not None:
        setup = (await db.execute(
            select(DesktopSetup).join(ApiKey, ApiKey.desktop_setup_id == DesktopSetup.id).where(
                ApiKey.id == key_id, ApiKey.revoked_at.is_(None), DesktopSetup.id == setup_id,
                DesktopSetup.exchanged_at.is_not(None), DesktopSetup.revoked_at.is_(None),
            )
        )).scalar_one_or_none()
    if setup is None:
        raise DesktopSetupError("setup_not_found")
    code = secrets.token_urlsafe(32)
    expires_at = _now() + CODE_TTL
    db.add(DesktopDeviceTokenCode(setup_id=setup.id, code_hash=_hash(code), code_challenge=challenge, expires_at=expires_at))
    await db.flush()
    return code, expires_at


def _uuid(value) -> uuid.UUID | None:
    try:
        return uuid.UUID(str(value)) if value else None
    except ValueError:
        return None


async def _code_and_setup(db: AsyncSession, code: str, *, lock: bool) -> tuple[DesktopDeviceTokenCode, DesktopSetup]:
    q = select(DesktopDeviceTokenCode).where(DesktopDeviceTokenCode.code_hash == _hash(code))
    row = (await db.execute(q.with_for_update() if lock else q)).scalar_one_or_none()
    if row is None:
        raise DesktopSetupError("code_not_found")
    sq = select(DesktopSetup).where(DesktopSetup.id == row.setup_id)
    setup = (await db.execute(sq.with_for_update() if lock else sq)).scalar_one()
    return row, setup


async def _require_admin_of(db: AsyncSession, user_id: uuid.UUID, setup: DesktopSetup) -> None:
    from app.services.project_auth import is_org_owner_or_admin

    if setup.org_id is None or not await is_org_owner_or_admin(db, user_id, setup.org_id):
        raise DesktopSetupError("not_org_admin")


@dataclass
class Peeked:
    device_name: str
    org_name: str | None
    expires_at: datetime


async def peek_code(db: AsyncSession, *, code: str, user_id: uuid.UUID) -> Peeked:
    """The confirmation screen's head (the computer's name · the org) — only for whoever may confirm it."""
    from app.models.organization import Organization

    row, setup = await _code_and_setup(db, code, lock=False)
    await _require_admin_of(db, user_id, setup)
    _refuse_unusable(row, setup)
    org_name = (await db.execute(select(Organization.name).where(Organization.id == setup.org_id))).scalar_one_or_none()
    return Peeked(device_name=setup.device_name, org_name=org_name, expires_at=row.expires_at)


def _refuse_unusable(row: DesktopDeviceTokenCode, setup: DesktopSetup) -> None:
    if setup.revoked_at is not None:
        raise DesktopSetupError("setup_disconnected")
    if row.exchanged_at is not None:
        raise DesktopSetupError("code_used")
    if _now() >= row.expires_at:
        raise DesktopSetupError("code_expired")


async def confirm_code(db: AsyncSession, *, code: str, user_id: uuid.UUID) -> uuid.UUID:
    """The same person pressing again gets 200 (as the setup confirmation: a commit that went through with a lost answer)."""
    row, setup = await _code_and_setup(db, code, lock=True)
    await _require_admin_of(db, user_id, setup)
    _refuse_unusable(row, setup)
    if row.confirmed_at is not None:
        if row.confirmed_by == user_id:
            return setup.id
        raise DesktopSetupError("already_confirmed")
    row.confirmed_by, row.confirmed_at = user_id, _now()
    await db.flush()
    return setup.id


async def exchange_code(db: AsyncSession, *, code: str, verifier: str) -> tuple[uuid.UUID, str] | None:
    """None = not confirmed yet. The verifier is checked before anything else about the code, and a wrong one does not burn
    it (as the setup exchange). The setup row is locked, so two exchanges for one device leave one active token."""
    from app.services.desktop_relay import issue_device_token

    row, setup = await _code_and_setup(db, code, lock=True)
    if not _VERIFIER_RE.match(verifier) or not hmac.compare_digest(
        row.code_challenge.encode(), pkce_challenge_from_verifier(verifier).encode()
    ):
        raise DesktopSetupError("verifier_mismatch")
    _refuse_unusable(row, setup)
    if row.confirmed_at is None:
        return None
    token = await issue_device_token(db, setup.id)  # revokes the device's earlier token · the agents and keys are untouched
    row.exchanged_at = _now()
    await db.flush()
    return setup.id, token
