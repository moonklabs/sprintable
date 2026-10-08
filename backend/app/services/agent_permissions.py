"""story #4533 (E-DESKTOP-2 B-2) — an agent's permission request: from its desktop's daemon to the person who decides it, and the
phone's signed decision back down. Contract: doc «E-DESKTOP-2 B-1 — 기기 줄 계약 v1» §9 · §10 (02d2cf71 v1.7).

The server carries the phone's signed blob as it is: it never makes, opens, changes or checks one — the daemon checks it against
the phone key it pinned from a QR code, and a key kept here is never handed to it. What the server decides is who sees the
request, whether a person may still answer it, and its state.

Who receives it (PO 13:21Z): the chain ① the person on the recipe's next human stage after that agent's (on the device's own
setup) → ② the org's recipe-gate default approver → ③ the person who confirmed the device. The recipient is the first one in the
chain with a phone paired to that device (only that phone's signature is taken there); with none, the chain's head gets a card
to look at, with the reason.
"""
from __future__ import annotations

import base64
import hashlib
import logging
import uuid
from datetime import datetime, timedelta, timezone
from typing import Literal

from pydantic import AwareDatetime, BaseModel, ConfigDict, Field, model_validator
from sqlalchemy import func, select, update
from sqlalchemy.exc import IntegrityError
from sqlalchemy.dialects.postgresql import insert as pg_insert
from sqlalchemy.ext.asyncio import AsyncSession

from app.models.agent_permission import AgentPermissionRequest, RemoteDevice, RemoteDevicePairing, RemoteDevicePairingOffer
from app.models.desktop_relay import DesktopDeviceToken, DesktopSession
from app.models.desktop_setup import DesktopSetup
from app.services.desktop_relay import SESSION_KEY_PATTERN, UNKNOWN_AFTER, DesktopRelayError, _check_agent
from app.services.tool_names import shown_tool

logger = logging.getLogger(__name__)

MAX_WINDOW = timedelta(seconds=3600)  # a daemon's permission window is never longer (contract §9 ①)
PHONES_PER_PERSON = 3  # PO B-4 · story #4535 AC2 — registered phone keys a person may hold
_TOOL_PATTERN = r"^[A-Za-z0-9_.:-]{1,64}$"
_HASH_PATTERN = r"^sha256:[0-9a-f]{64}$"


def _now() -> datetime:
    return datetime.now(timezone.utc)


# ── phone keys · the confirmation number (contract §10 — one computation on the phone, the desktop and the web) ─────────────


def fingerprint_of(der: bytes) -> str:
    return "sha256:" + hashlib.sha256(der).hexdigest()


def confirm_number(der: bytes) -> str:
    """The first four bytes of sha256(SPKI DER) as a big-endian unsigned integer, mod 1,000,000, six digits, «482 917»."""
    n = int.from_bytes(hashlib.sha256(der).digest()[:4], "big") % 1_000_000
    s = f"{n:06d}"
    return f"{s[:3]} {s[3:]}"


def _decode_public_key(value: str) -> bytes:
    """A base64url SPKI DER public key that parses — its algorithm is the phone's and the daemon's to choose (4531 · 4532)."""
    from cryptography.hazmat.primitives.serialization import load_der_public_key

    try:
        der = base64.urlsafe_b64decode(value + "=" * (-len(value) % 4))
        load_der_public_key(der)
    except Exception as exc:  # noqa: BLE001 — any shape we cannot read is the same 422
        raise DesktopRelayError(422, "invalid_public_key", "public_key must be a base64url SPKI DER public key") from exc
    return der


class RemoteDeviceRegistration(BaseModel):
    model_config = ConfigDict(extra="forbid")

    label: str = Field(min_length=1, max_length=64)
    public_key: str = Field(min_length=1, max_length=2048)
    # story #4629: the phone's own refresh token, added by the web route from its session cookie (never by the phone) — only
    # its hash is looked up, to record which session registered the key; never stored, never echoed back
    refresh_token: str | None = Field(default=None, max_length=4096, repr=False)


async def _session_row_id(db: AsyncSession, *, user_id: uuid.UUID, raw: str | None) -> uuid.UUID | None:
    """story #4629: the live refresh-token row this raw token is — the person's own only (another person's token binds nothing)."""
    if not raw:
        return None
    from app.core.security import hash_token
    from app.models.user import RefreshToken

    return (await db.execute(
        select(RefreshToken.id).where(
            RefreshToken.token_hash == hash_token(raw), RefreshToken.user_id == user_id,
            RefreshToken.revoked_at.is_(None), RefreshToken.expires_at > func.now(),
        )
    )).scalar_one_or_none()


def _device_view(d: RemoteDevice, pairs: list[dict] | None = None) -> dict:
    der = base64.urlsafe_b64decode(d.public_key + "=" * (-len(d.public_key) % 4))
    return {
        "id": str(d.id), "label": d.label, "fingerprint": d.fingerprint, "confirm_number": confirm_number(der),
        "created_at": d.created_at.isoformat() if d.created_at else None,
        "last_used_at": d.last_used_at.isoformat() if d.last_used_at else None,
        **({"pairs": pairs} if pairs is not None else {}),
    }


async def register_phone(
    db: AsyncSession, *, member_id: uuid.UUID, org_id: uuid.UUID, body: RemoteDeviceRegistration, user_id: uuid.UUID | None = None,
) -> tuple[dict, bool]:
    """The phone app registers its key under the person's own login. The same key again → the same row (created False); a
    fourth live key → 409 remote_device_limit with the three, to choose one to remove (PO B-4). story #4629: the session it
    registered from is recorded on the key (each registration — the latest login wins; none found keeps what was there)."""
    der = _decode_public_key(body.public_key)
    fp = fingerprint_of(der)
    session_id = await _session_row_id(db, user_id=user_id, raw=body.refresh_token) if user_id is not None else None
    existing = (await db.execute(select(RemoteDevice).where(RemoteDevice.fingerprint == fp).with_for_update())).scalar_one_or_none()
    if existing is not None and existing.member_id != member_id:
        raise DesktopRelayError(409, "remote_device_taken", "this phone key is registered by someone else")
    if existing is not None and existing.revoked_at is None:
        if session_id is not None:
            existing.session_token_id = session_id
            await db.flush()
        return _device_view(existing), False
    # count under the person's rows' lock: two registrations at once cannot both be the third
    live = (await db.execute(
        select(RemoteDevice).where(RemoteDevice.member_id == member_id, RemoteDevice.revoked_at.is_(None))
        .order_by(RemoteDevice.created_at).with_for_update()
    )).scalars().all()
    if len(live) >= PHONES_PER_PERSON:
        raise DesktopRelayError(409, "remote_device_limit", "at most three phones", detail={"devices": [_device_view(d) for d in live]})
    if existing is not None:  # the person's own key, removed before — back as it was
        existing.revoked_at, existing.label, existing.org_id = None, body.label, org_id
        if session_id is not None:
            existing.session_token_id = session_id
        await db.flush()
        return _device_view(existing), True
    row = RemoteDevice(
        id=uuid.uuid4(), member_id=member_id, org_id=org_id, label=body.label, public_key=body.public_key.rstrip("="), fingerprint=fp,
        session_token_id=session_id,
    )
    db.add(row)
    await db.flush()
    return _device_view(row), True


async def list_phones(db: AsyncSession, *, member_id: uuid.UUID | None, org_id: uuid.UUID) -> list[dict]:
    """The person's phones (member_id) or, for an owner/admin, the org's (None) — each with the devices it is paired to now."""
    q = select(RemoteDevice).where(RemoteDevice.org_id == org_id, RemoteDevice.revoked_at.is_(None)).order_by(RemoteDevice.created_at)
    if member_id is not None:
        q = q.where(RemoteDevice.member_id == member_id)
    phones = (await db.execute(q)).scalars().all()
    if not phones:
        return []
    pairs = (await db.execute(
        select(RemoteDevicePairing.remote_device_id, RemoteDevicePairing.setup_id, RemoteDevicePairing.paired_at, DesktopSetup.device_name)
        .join(DesktopSetup, DesktopSetup.id == RemoteDevicePairing.setup_id)
        .where(RemoteDevicePairing.remote_device_id.in_([p.id for p in phones]), RemoteDevicePairing.removed_at.is_(None),
               DesktopSetup.revoked_at.is_(None))
        .order_by(RemoteDevicePairing.paired_at)
    )).all()
    by_phone: dict[uuid.UUID, list[dict]] = {}
    for phone_id, setup_id, paired_at, device_name in pairs:
        by_phone.setdefault(phone_id, []).append(
            {"setup_id": str(setup_id), "device_name": device_name, "paired_at": paired_at.isoformat()}
        )
    return [_device_view(p, by_phone.get(p.id, [])) for p in phones]


async def remove_pair(
    db: AsyncSession, *, phone_id: uuid.UUID, setup_id: uuid.UUID, actor_member_id: uuid.UUID | None, actor_is_admin: bool, org_id: uuid.UUID,
) -> bool:
    """[빼기] — at once on the server (an answer with that key: 409 phone_not_paired), then sent down as `pairing_removed` until
    the device's snapshot drops it. The phone's owner or an owner/admin of the device's org. Already removed → False."""
    phone = (await db.execute(
        select(RemoteDevice).where(RemoteDevice.id == phone_id, RemoteDevice.org_id == org_id)
    )).scalar_one_or_none()
    if phone is None or not (actor_is_admin or phone.member_id == actor_member_id):
        raise DesktopRelayError(404, "pairing_not_found", "no such pairing")
    pair = (await db.execute(
        select(RemoteDevicePairing).where(RemoteDevicePairing.remote_device_id == phone_id, RemoteDevicePairing.setup_id == setup_id)
        .with_for_update()
    )).scalar_one_or_none()
    if pair is None:
        raise DesktopRelayError(404, "pairing_not_found", "no such pairing")
    if pair.removed_at is not None:
        return False
    pair.removed_at, pair.removed_by, pair.removal_acked_at = _now(), actor_member_id, None
    await db.flush()
    _wake_device_after_commit(db, setup_id)
    return True


async def _end_phone_session(db: AsyncSession, phone: RemoteDevice, now: datetime) -> Literal["ended", "not_found"]:
    """story #4629 (PO 09:02Z: A2): the login session the phone registered its key from — that one only. Its refresh token rotates
    on every refresh (`replaced_by` · #2449), so the chain is followed to its live end and every live row of it is revoked through
    the one revoke seam (`_explicit_revoke_values` · #3649 — it also closes the refresh grace window). No recorded session (a key
    registered before 0446 · no token sent) or a chain with nothing live (already logged out · expired) → nothing is revoked:
    «not_found» (PO: no other session is ever touched to make up for it)."""
    from app.models.user import RefreshToken
    from app.routers.auth import _explicit_revoke_values

    chain: list[uuid.UUID] = []
    at = phone.session_token_id
    while at is not None and at not in chain and len(chain) < 10_000:
        chain.append(at)
        at = (await db.execute(select(RefreshToken.replaced_by).where(RefreshToken.id == at))).scalar_one_or_none()
    if not chain:
        logger.info("phone removed: no session recorded — key and pairs only", extra={"structured": {"event": "phone_removed_session_not_found", "why": "none_recorded"}})
        return "not_found"
    result = await db.execute(
        update(RefreshToken)
        .where(RefreshToken.id.in_(chain), RefreshToken.revoked_at.is_(None), RefreshToken.expires_at > now)
        .values(**_explicit_revoke_values(now))
    )
    if not result.rowcount:
        logger.info("phone removed: its session is no longer live — key and pairs only", extra={"structured": {"event": "phone_removed_session_not_found", "why": "not_live"}})
        return "not_found"
    return "ended"


async def remove_phone(
    db: AsyncSession, *, phone_id: uuid.UUID, actor_member_id: uuid.UUID | None, actor_is_admin: bool, org_id: uuid.UUID,
) -> tuple[bool, Literal["ended", "not_found"] | None]:
    """story #4624 (1선 · PO 07:58Z): [이 폰 빼기] — the key itself. Before, nothing ever set `revoked_at`: a phone reinstalled three
    times held three live keys for good (`remote_device_limit`), and the product's own advice («원격 기기에서 하나를 빼 주세요») could
    only remove pairs. Now: the key's owner or an owner/admin of its org — anyone else gets the same 404 as a key that does not exist.
    `revoked_at` set (the limit counts live keys only) · every live pair of it removed the [빼기] way (`pairing_removed` goes down to
    each setup until its snapshot drops it) · each of those setups woken. Already removed → False (idempotent). The same key
    registered again by its owner comes back (register_phone · unchanged). story #4629: also that phone's own login session
    (`_end_phone_session` → «ended» · «not_found»; None when nothing was removed)."""
    phone = (await db.execute(
        select(RemoteDevice).where(RemoteDevice.id == phone_id, RemoteDevice.org_id == org_id).with_for_update()
    )).scalar_one_or_none()
    if phone is None or not (actor_is_admin or phone.member_id == actor_member_id):
        raise DesktopRelayError(404, "phone_not_found", "no such phone")
    if phone.revoked_at is not None:
        return False, None
    now = _now()
    phone.revoked_at = now
    pairs = (await db.execute(
        select(RemoteDevicePairing).where(RemoteDevicePairing.remote_device_id == phone_id, RemoteDevicePairing.removed_at.is_(None))
        .with_for_update()
    )).scalars().all()
    for pair in pairs:
        pair.removed_at, pair.removed_by, pair.removal_acked_at = now, actor_member_id, None
    await db.flush()
    session = await _end_phone_session(db, phone, now)
    for setup_id in {p.setup_id for p in pairs}:
        _wake_device_after_commit(db, setup_id)
    return True, session


class PairingReport(BaseModel):
    model_config = ConfigDict(extra="forbid")

    phone_key_fingerprint: str = Field(pattern=_HASH_PATTERN)
    paired_at: AwareDatetime


class PairingSnapshot(BaseModel):
    model_config = ConfigDict(extra="forbid")

    pairings: list[PairingReport] = Field(max_length=16)


async def replace_pairings(db: AsyncSession, setup: DesktopSetup, snapshot: PairingSnapshot) -> dict:
    """The device's whole list of QR-pinned phone keys. A key nobody registered in this org is counted, never stored (it can
    answer nothing here). A pair removed on the server stays removed while the device still lists it (the frame goes again);
    only once a snapshot has dropped it (`removal_acked_at`) does the same key listed again count as a new QR pairing. Never by
    comparing `paired_at` (the Mac's clock) with `removed_at` (the server's): a Mac clock ahead would revive a pair just removed,
    while the daemon still holds the key (PO 13:55Z)."""
    fps = [p.phone_key_fingerprint for p in snapshot.pairings]
    if len(set(fps)) != len(fps):
        raise DesktopRelayError(422, "duplicate_pairing", "a phone key appears twice in the snapshot")
    phones = {d.fingerprint: d for d in (await db.execute(
        select(RemoteDevice).where(RemoteDevice.fingerprint.in_(fps), RemoteDevice.org_id == setup.org_id,
                                   RemoteDevice.revoked_at.is_(None))
    )).scalars().all()} if fps else {}
    rows = {r.remote_device_id: r for r in (await db.execute(
        select(RemoteDevicePairing).where(RemoteDevicePairing.setup_id == setup.id).with_for_update()
    )).scalars().all()}
    now = _now()
    listed: set[uuid.UUID] = set()
    for p in snapshot.pairings:
        phone = phones.get(p.phone_key_fingerprint)
        if phone is None:
            continue
        listed.add(phone.id)
        row = rows.get(phone.id)
        if row is None:
            db.add(RemoteDevicePairing(id=uuid.uuid4(), remote_device_id=phone.id, setup_id=setup.id, paired_at=p.paired_at, reported_at=now))
        elif row.removed_at is not None and row.removal_acked_at is None:
            row.reported_at = now  # still on the device: the removal is not done — the stream sends it again
        else:
            if row.removed_at is not None:  # dropped by the device once, now listed again: a new QR pairing
                row.removed_at = row.removed_by = row.removal_acked_at = None
            row.paired_at, row.reported_at = p.paired_at, now
    for phone_id, row in rows.items():
        if phone_id in listed:
            continue
        if row.removed_at is None:
            row.removed_at = now  # the device dropped it on its own
        if row.removal_acked_at is None:
            row.removal_acked_at = now
    await db.flush()
    return {"pairings": len(listed), "unregistered": len(snapshot.pairings) - len(listed)}


async def removals_to_send(db: AsyncSession, setup_id: uuid.UUID) -> list[str]:
    """Fingerprints removed on the server that the device has not dropped yet — sent on every connection until it does."""
    return list((await db.execute(
        select(RemoteDevice.fingerprint).join(RemoteDevicePairing, RemoteDevicePairing.remote_device_id == RemoteDevice.id)
        .where(RemoteDevicePairing.setup_id == setup_id, RemoteDevicePairing.removed_at.is_not(None),
               RemoteDevicePairing.removal_acked_at.is_(None))
        .order_by(RemoteDevicePairing.removed_at)
    )).scalars().all())


# ── a pairing offer (story #4531 · contract v1.10 §10 ⑤) ─────────────────────────────────────────────────────────────────────

PAIRING_OFFER_TTL = timedelta(minutes=5)  # the QR's own window — an offer further out is not one the desktop opened
_MAC = r"^[A-Za-z0-9_-]{43}$"  # HMAC-SHA256 · 32 bytes · base64url, no padding


class PairingOffer(BaseModel):
    model_config = ConfigDict(extra="forbid")

    setup_id: uuid.UUID
    offer_id: uuid.UUID
    phone_key_id: uuid.UUID
    label: str = Field(min_length=1, max_length=64)  # v1.11: inside the MAC
    expires_at: AwareDatetime
    mac: str = Field(pattern=_MAC)


class PairingReveal(BaseModel):
    model_config = ConfigDict(extra="forbid")

    reveal: str = Field(pattern=r"^[A-Za-z0-9_-]{43}$")  # 32 bytes · base64url, no padding


async def offer_pairing(db: AsyncSession, *, member_id: uuid.UUID, org_id: uuid.UUID, body: PairingOffer) -> RemoteDevicePairingOffer:
    """The phone scanned a desktop's QR: carry its registered key down to that desktop with the MAC the phone made from the QR's
    secret. The server never sees that secret, so it can neither make nor check the MAC — a key it swapped would not match it on
    the daemon. Only the key's owner, in their own session, may offer it."""
    from app.services import remote_control

    phone = (await db.execute(
        select(RemoteDevice).where(RemoteDevice.id == body.phone_key_id, RemoteDevice.member_id == member_id,
                                   RemoteDevice.revoked_at.is_(None))
    )).scalar_one_or_none()
    if phone is None:
        raise DesktopRelayError(404, "phone_key_not_found", "no such phone key of yours")
    # one answer for «not there · another org's · disconnected · not exchanged» (as the device-token code · PO 08:36Z)
    setup = (await db.execute(
        select(DesktopSetup).where(DesktopSetup.id == body.setup_id, DesktopSetup.org_id == org_id,
                                   DesktopSetup.revoked_at.is_(None), DesktopSetup.exchanged_at.is_not(None))
    )).scalar_one_or_none()
    if setup is None:
        raise DesktopRelayError(404, "setup_not_found", "no such computer")
    if not await remote_control.is_enabled(db, org_id):
        raise DesktopRelayError(409, remote_control.OFF_CODE, "remote control is off for this organization")
    now = _now()
    if not (now < body.expires_at <= now + PAIRING_OFFER_TTL + timedelta(seconds=5)):  # 5 s for the two clocks
        raise DesktopRelayError(422, "invalid_expiry", "the offer has expired or reaches beyond its window")
    if setup.id not in await _reachable(db, {setup.id}, now):
        raise DesktopRelayError(409, "device_unreachable", "that computer has not been heard from")
    existing = (await db.execute(
        select(RemoteDevicePairingOffer).where(RemoteDevicePairingOffer.setup_id == setup.id,
                                               RemoteDevicePairingOffer.offer_id == body.offer_id)
    )).scalar_one_or_none()
    if existing is not None:
        # the same phone sending the same offer again: the same row · another key or MAC for an offer already answered: no
        if existing.remote_device_id == phone.id and existing.mac == body.mac and existing.label == body.label:
            return existing
        raise DesktopRelayError(409, "offer_used", "this pairing code was already answered")
    row = RemoteDevicePairingOffer(id=uuid.uuid4(), setup_id=setup.id, offer_id=body.offer_id, remote_device_id=phone.id,
                                   offered_by=member_id, label=body.label, mac=body.mac, expires_at=body.expires_at)
    db.add(row)
    try:
        await db.flush()
    except IntegrityError:
        raise DesktopRelayError(409, "offer_used", "this pairing code was already answered") from None
    _wake_device_after_commit(db, setup.id)
    return row


async def offers_to_send(db: AsyncSession, setup_id: uuid.UUID) -> list[dict]:
    """Offers for this device not yet past their window — sent on every connection until then (the daemon keeps the offers it
    opened and drops any other). `label` and `expires_at` are outside the MAC: shown, never trusted (the daemon goes by the
    window of the offer it opened)."""
    now = _now()
    rows = (await db.execute(
        select(RemoteDevicePairingOffer, RemoteDevice)
        .join(RemoteDevice, RemoteDevice.id == RemoteDevicePairingOffer.remote_device_id)
        .where(RemoteDevicePairingOffer.setup_id == setup_id, RemoteDevicePairingOffer.expires_at > now,
               RemoteDevice.revoked_at.is_(None))
        .order_by(RemoteDevicePairingOffer.created_at)
    )).all()
    return [{"offer_id": str(o.offer_id), "phone_key_id": str(d.id), "public_key": d.public_key, "label": o.label,
             "mac": o.mac, "expires_at": o.expires_at.isoformat()} for o, d in rows]


async def reveal_pairing(db: AsyncSession, setup: DesktopSetup, offer_id: uuid.UUID, body: PairingReveal) -> None:
    """v1.11 — the desktop's random value for this pairing's number, drawn after the offer's MAC bound the key; kept for the phone
    that sent the offer. Once: the same value again is fine, another is refused (the number the person compares must not move)."""
    row = (await db.execute(
        select(RemoteDevicePairingOffer).where(RemoteDevicePairingOffer.setup_id == setup.id, RemoteDevicePairingOffer.offer_id == offer_id)
        .with_for_update()
    )).scalar_one_or_none()
    if row is None:
        raise DesktopRelayError(404, "offer_not_found", "no such pairing offer for this device")
    if row.expires_at <= _now():
        raise DesktopRelayError(410, "offer_expired", "the pairing offer has expired")
    if row.reveal is not None:
        if row.reveal != body.reveal:
            raise DesktopRelayError(409, "already_revealed", "this pairing offer was revealed with another value")
        return
    row.reveal, row.revealed_at = body.reveal, _now()
    await db.flush()


async def pairing_offer_state(db: AsyncSession, *, member_id: uuid.UUID, org_id: uuid.UUID, setup_id: uuid.UUID, offer_id: uuid.UUID) -> dict:
    """v1.11 — what the phone that sent the offer waits for: the desktop's value (then it shows the same pairing number) · the
    window over. Only the person who sent it — anyone else gets the same «not found»."""
    row = (await db.execute(
        select(RemoteDevicePairingOffer).join(DesktopSetup, DesktopSetup.id == RemoteDevicePairingOffer.setup_id)
        .where(RemoteDevicePairingOffer.setup_id == setup_id, RemoteDevicePairingOffer.offer_id == offer_id,
               RemoteDevicePairingOffer.offered_by == member_id, DesktopSetup.org_id == org_id)
    )).scalar_one_or_none()
    if row is None:
        raise DesktopRelayError(404, "offer_not_found", "no such pairing offer of yours")
    if row.reveal is not None:
        return {"state": "revealed", "reveal": row.reveal}
    return {"state": "expired" if row.expires_at <= _now() else "sent", "reveal": None}


def _wake_device_after_commit(db: AsyncSession, setup_id: uuid.UUID) -> None:
    from app.services.desktop_relay import _schedule_wake_after_commit

    _schedule_wake_after_commit(db, setup_id, 0)


# ── who receives a request ────────────────────────────────────────────────────────────────────────────────────────────────


async def _chain(db: AsyncSession, setup: DesktopSetup, agent_member_id: uuid.UUID) -> list[uuid.UUID]:
    from app.models.hitl_config import OrgGatePolicy
    from app.models.member import Member

    chain: list[uuid.UUID | None] = []
    members = setup.members or []
    agent_at = max((i for i, m in enumerate(members) if m.get("member_id") == str(agent_member_id)), default=None)
    if agent_at is not None:  # ① the next human stage after the agent's, when the recipe has one
        chain.append(next((_uuid(m.get("member_id")) for m in members[agent_at + 1:] if m.get("kind") == "human"), None))
    chain.append((await db.execute(
        select(OrgGatePolicy.recipe_gate_default_approver_member_id).where(OrgGatePolicy.org_id == setup.org_id)
    )).scalar_one_or_none())
    if setup.confirmed_by is not None:
        chain.append((await db.execute(
            select(Member.id).where(Member.org_id == setup.org_id, Member.user_id == setup.confirmed_by, Member.type == "human",
                                    Member.deleted_at.is_(None))
        )).scalar_one_or_none())
    ids = list(dict.fromkeys(m for m in chain if m is not None))
    if not ids:
        return []
    live = set((await db.execute(
        select(Member.id).where(Member.id.in_(ids), Member.org_id == setup.org_id, Member.type == "human",
                                Member.is_active.is_(True), Member.deleted_at.is_(None))
    )).scalars().all())
    return [m for m in ids if m in live]


async def _paired_members(db: AsyncSession, setup_id: uuid.UUID, member_ids: list[uuid.UUID]) -> set[uuid.UUID]:
    if not member_ids:
        return set()
    return set((await db.execute(
        select(RemoteDevice.member_id).join(RemoteDevicePairing, RemoteDevicePairing.remote_device_id == RemoteDevice.id)
        .where(RemoteDevicePairing.setup_id == setup_id, RemoteDevicePairing.removed_at.is_(None),
               RemoteDevice.revoked_at.is_(None), RemoteDevice.member_id.in_(member_ids))
    )).scalars().all())


async def resolve_recipient(db: AsyncSession, setup: DesktopSetup, agent_member_id: uuid.UUID) -> tuple[uuid.UUID | None, str]:
    chain = await _chain(db, setup, agent_member_id)
    paired = await _paired_members(db, setup.id, chain)
    for m in chain:
        if m in paired:
            return m, "paired"
    return (chain[0] if chain else None), "no_paired_phone"


def _uuid(value) -> uuid.UUID | None:
    try:
        return uuid.UUID(str(value)) if value else None
    except ValueError:
        return None


# ── ① the daemon reports · withdraws ─────────────────────────────────────────────────────────────────────────────────────


class PermissionRequestReport(BaseModel):
    """What a person sees — a masked, cut summary; no raw input, no full path, no key (extra fields → 422)."""

    model_config = ConfigDict(extra="forbid")

    request_id: uuid.UUID
    session_key: str = Field(pattern=SESSION_KEY_PATTERN)
    agent_member_id: uuid.UUID
    runtime: Literal["claude", "codex"]
    tool: str | None = Field(default=None, pattern=_TOOL_PATTERN)
    summary: str | None = Field(default=None, min_length=1, max_length=200)
    masked: bool = False
    truncated: bool = False
    workdir: str | None = Field(default=None, max_length=200)
    input_hash: str | None = Field(default=None, pattern=_HASH_PATTERN)
    expires_at: AwareDatetime
    # story #4590 (Mirko's contract v1.14 ①): a question only that computer's terminal can answer — nothing to sign, so no hash;
    # its tool and summary only when the daemon read them. Every other report keeps all three, as before.
    terminal_only: bool = False

    @model_validator(mode="after")
    def _fields_for_its_kind(self) -> "PermissionRequestReport":
        if self.terminal_only:
            if self.input_hash is not None:
                raise ValueError("a terminal-only request carries no input_hash (nothing is signed)")
        elif self.tool is None or self.summary is None or self.input_hash is None:
            raise ValueError("tool, summary and input_hash are required unless the request is terminal_only")
        return self


async def report_request(db: AsyncSession, setup: DesktopSetup, body: PermissionRequestReport) -> tuple[AgentPermissionRequest, bool]:
    _check_agent(setup, body.agent_member_id)
    now = _now()
    if not now < body.expires_at <= now + MAX_WINDOW:
        raise DesktopRelayError(422, "invalid_expiry", "expires_at must be in the next 3600 seconds")
    q = select(AgentPermissionRequest).where(
        AgentPermissionRequest.setup_id == setup.id, AgentPermissionRequest.request_id == body.request_id,
    )
    existing = (await db.execute(q)).scalar_one_or_none()
    if existing is not None:
        return existing, False
    session = (await db.execute(
        select(DesktopSession.agent_member_id).where(DesktopSession.setup_id == setup.id, DesktopSession.session_key == body.session_key)
    )).scalar_one_or_none()
    if session is None:
        raise DesktopRelayError(422, "unknown_session", "no such session on this device")
    if session != body.agent_member_id:
        # Qadir · PO 16:17Z — another agent of the same device must not stand in for the session's own: its approval chain
        # would choose the recipient and its name would go on the bell
        raise DesktopRelayError(422, "session_agent_mismatch", "the session belongs to another agent of this device")
    recipient, reason = await resolve_recipient(db, setup, body.agent_member_id)
    row = AgentPermissionRequest(
        id=uuid.uuid4(), setup_id=setup.id, request_id=body.request_id, session_key=body.session_key,
        agent_member_id=body.agent_member_id, runtime=body.runtime, tool=body.tool, summary=body.summary, masked=body.masked,
        truncated=body.truncated, workdir=body.workdir, input_hash=body.input_hash, expires_at=body.expires_at, state="pending",
        recipient_member_id=recipient, recipient_reason=reason, terminal_only=body.terminal_only,
    )
    try:
        async with db.begin_nested():  # the same request twice at once: one row, the other reads it
            db.add(row)
    except IntegrityError:
        return (await db.execute(q)).scalar_one(), False
    # story #4590 (Yuna §3): a terminal-only question sends no notice — the notice is the phone's push, and a push calls a person to
    # something they cannot do there; the card is on the approvals list (its count), the one at that computer sees the board
    if recipient is not None and not row.terminal_only:
        await _send_permission_notice(db, setup, row, recipient)
    return row, True


async def _send_permission_notice(db: AsyncSession, setup: DesktopSetup, row: AgentPermissionRequest, recipient: uuid.UUID) -> None:
    """The recipient's bell line (and the phone push channel every notice takes): an agent waits at a prompt with a window, so
    not knowing until the inbox is opened leaves it standing (PO 14:28Z). The words are the spec's (명세 B-2 · 폰 알림) — the
    agent and the tool only: no summary, no working folder, no command (a lock screen · a notice history keeps them). Sent once,
    with the row (the same request_id again finds the row and sends nothing). To the chain's head too when no phone is paired —
    the look-only card is theirs."""
    from app.models.member import Member
    from app.services.i18n_catalog import t
    from app.services.notification_dispatch import dispatch_notification
    from app.services.org_locale import resolve_org_locale

    # the words in the org's language from the shared catalog (the push and a notice history read the server's title; the web
    # bell builds its own line from the type)
    locale = await resolve_org_locale(db, setup.org_id)
    agent_name = (await db.execute(select(Member.name).where(Member.id == row.agent_member_id))).scalar_one_or_none() or ""
    # story 4542: the computer once (its exact tail only) · the tool by the one naming rule (app/services/tool-names.json)
    from app.services.tool_names import agent_on_device

    who = agent_on_device(agent_name, setup.device_name) if agent_name else ""
    title = t("agent_permission.notice_title", locale, agent=who) if who else t("agent_permission.notice_title_bare", locale)
    await dispatch_notification(
        db, org_id=setup.org_id, event_type="agent.permission_request", target_member_ids=[recipient],
        title=title, body=t("agent_permission.notice_body", locale, tool=shown_tool(row.runtime, row.tool, locale)),
        reference_type="agent_permission_request", reference_id=row.id, source_project_id=setup.project_id,
        event={"payload": {"agent_name": agent_name}},
    )


class Withdrawal(BaseModel):
    model_config = ConfigDict(extra="forbid")

    # story #4590 (Mirko ②): `terminal_only` — the question the phone could answer became one only the terminal can; the daemon withdraws
    # the answerable row so and reports a new terminal-only one (a row never turns from answerable to not: the signing path is untouched)
    reason: Literal["answered_locally", "session_ended", "expired", "host_unread", "terminal_only"]


# story #4612 (PO 23:36Z · after 4607): a request's later change — answered · withdrawn · rejected by the daemon · back to pending
# for its second answer — told to the one person whose list shows it (`list_for_member`: recipient_member_id only), so a card left
# open on another screen leaves at once instead of at its next 15 s read. A transient SSE frame (no Event row — nothing for the
# bell), carrying only which request and its state (the 4533 rule: no summary · tool · folder), sent after the outer commit
# (`schedule_after_commit` — a rolled-back change sends nothing).
PERMISSION_CHANGED_EVENT = "agent.permission_request.changed"


def _schedule_changed(db: AsyncSession, request_id: uuid.UUID, recipient: uuid.UUID | None, state: str) -> None:
    if recipient is None:
        return
    import functools

    from app.services.after_commit import schedule_after_commit

    payload = {"event_type": PERMISSION_CHANGED_EVENT, "request_id": str(request_id), "state": state}
    schedule_after_commit(db, [functools.partial(_fire_changed, str(recipient), payload)])


def _fire_changed(member_id: str, payload: dict) -> None:
    from app.routers.events import _push_to_agent

    _push_to_agent(member_id, dict(payload))  # no event_id → the transient path (its own id · the reconnect replay buffer)


async def withdraw_request(db: AsyncSession, setup: DesktopSetup, request_id: uuid.UUID, body: Withdrawal) -> AgentPermissionRequest:
    row = (await db.execute(
        select(AgentPermissionRequest).where(AgentPermissionRequest.setup_id == setup.id, AgentPermissionRequest.request_id == request_id)
        .with_for_update()
    )).scalar_one_or_none()
    if row is None:
        raise DesktopRelayError(404, "request_not_found", "no such permission request on this device")
    if body.reason == "host_unread":
        # story #4580 AC2 F2: only a network question answered «allow…» at its first stage — the daemon pressed Esc and found no host
        # it may trust in Claude's own text; the request ends with nothing allowed (Yuna 2-7)
        if row.runtime != "claude" or row.tool != SANDBOX_NET_TOOL or row.stage != "ask" or row.state != "answered" or row.decision != "allow":
            raise DesktopRelayError(409, "not_allowed_yet", "only a network question answered «allow…» can end with its host unread")
        row.state, row.result_code = "withdrawn", "host_unread"
        await db.flush()
        _schedule_changed(db, row.request_id, row.recipient_member_id, row.state)  # story #4612
        return row
    if row.state == "pending":
        row.state, row.result_code = "withdrawn", body.reason
        await db.flush()
        _schedule_changed(db, row.request_id, row.recipient_member_id, row.state)  # story #4612
    return row


# ── story #4580 AC2 B (Kadir ⓐ) — a network question's second answer · the host it added ────────────────────────────────


SANDBOX_NET_TOOL = "SandboxNetwork"  # the desktop daemon's value for Claude's sandbox network question (tool-names.json)


class HostConfirm(BaseModel):
    model_config = ConfigDict(extra="forbid")

    host: str = Field(min_length=1, max_length=253)
    expires_at: AwareDatetime


class HostAdded(BaseModel):
    model_config = ConfigDict(extra="forbid")

    host: str = Field(min_length=1, max_length=253)


async def _own_row(db: AsyncSession, setup: DesktopSetup, request_id: uuid.UUID) -> AgentPermissionRequest:
    row = (await db.execute(
        select(AgentPermissionRequest).where(AgentPermissionRequest.setup_id == setup.id, AgentPermissionRequest.request_id == request_id)
        .with_for_update()
    )).scalar_one_or_none()
    if row is None:
        raise DesktopRelayError(404, "request_not_found", "no such permission request on this device")
    return row


async def confirm_host(db: AsyncSession, setup: DesktopSetup, request_id: uuid.UUID, body: HostConfirm) -> AgentPermissionRequest:
    """The daemon, after the first answer «allow…» on a network question: it pressed Esc (never a key that allows), read the host
    from Claude's own hook text, and asks the same person again with it — the row goes back to `pending` at stage `confirm`."""
    from app.services.agent_run_profile import clean_host

    row = await _own_row(db, setup, request_id)
    if row.runtime != "claude" or row.tool != SANDBOX_NET_TOOL:
        raise DesktopRelayError(409, "not_a_network_request", "only a network question has a second answer")
    host = clean_host(body.host)
    if host is None:
        raise DesktopRelayError(422, "invalid_host", "a DNS name only (no IP, wildcard, port or path)")
    if row.stage == "confirm":  # the same report again: the same row · another host: never replaced
        if row.host != host:
            raise DesktopRelayError(409, "host_mismatch", "this request already carries another host")
        return row
    if row.state != "answered" or row.decision != "allow":
        raise DesktopRelayError(409, "not_allowed_yet", "the first answer was not «allow»")
    now = _now()
    if not now < body.expires_at <= now + MAX_WINDOW:
        raise DesktopRelayError(422, "invalid_expiry", "expires_at must be in the next 3600 seconds")
    row.stage, row.host, row.state, row.expires_at = "confirm", host, "pending", body.expires_at
    row.decision = row.answered_by = row.answered_phone_key_id = row.answered_at = row.result_code = None
    await db.flush()
    _schedule_changed(db, row.request_id, row.recipient_member_id, row.state)  # story #4612: the card's second state
    return row


async def host_added(db: AsyncSession, setup: DesktopSetup, request_id: uuid.UUID, body: HostAdded) -> bool:
    """The daemon checked the second signature and wrote the agent folder's line: the host joins the agent's «허용 주소» list —
    only for a row of this device at stage `confirm` answered «allow», and only the row's own host (never one taken from here:
    Kadir ⓐ · a different host is refused). `added_by` = the person who signed it. True when a row was added."""
    from app.models.agent_allowed_host import AgentAllowedHost
    from app.services.agent_run_profile import _bump, clean_host

    row = await _own_row(db, setup, request_id)
    if row.stage != "confirm" or row.state != "answered" or row.decision != "allow" or row.host is None:
        raise DesktopRelayError(409, "not_confirmed", "no signed «allow» on this request's host")
    if clean_host(body.host) != row.host:
        raise DesktopRelayError(409, "host_mismatch", "not the host this request was answered for")
    added = (await db.execute(
        pg_insert(AgentAllowedHost).values(
            member_id=row.agent_member_id, host=row.host, added_by=row.answered_by, request_id=row.request_id,
        ).on_conflict_do_nothing(index_elements=[AgentAllowedHost.member_id, AgentAllowedHost.host])
    )).rowcount
    if added:
        await _bump(db, member_id=row.agent_member_id, updated_by=row.answered_by)
    return bool(added)


# ── ② the person's view ──────────────────────────────────────────────────────────────────────────────────────────────────


async def _reachable(db: AsyncSession, setup_ids: set[uuid.UUID], now: datetime) -> set[uuid.UUID]:
    if not setup_ids:
        return set()
    rows = (await db.execute(
        select(DesktopDeviceToken.setup_id, func.max(DesktopDeviceToken.last_used_at))
        .join(DesktopSetup, DesktopSetup.id == DesktopDeviceToken.setup_id)
        .where(DesktopDeviceToken.setup_id.in_(setup_ids), DesktopDeviceToken.revoked_at.is_(None), DesktopSetup.revoked_at.is_(None))
        .group_by(DesktopDeviceToken.setup_id)
    )).all()
    return {sid for sid, last in rows if last is not None and now - last <= UNKNOWN_AFTER}


def shown_state(row: AgentPermissionRequest, now: datetime) -> str:
    """`expired` is read, never swept: a pending request past its window shows as expired."""
    return "expired" if row.state == "pending" and row.expires_at <= now else row.state


async def list_for_member(db: AsyncSession, *, member_id: uuid.UUID, org_id: uuid.UUID, state: str | None) -> list[dict]:
    from app.models.member import Member

    now = _now()
    rows = (await db.execute(
        select(AgentPermissionRequest, DesktopSetup)
        .join(DesktopSetup, DesktopSetup.id == AgentPermissionRequest.setup_id)
        .where(AgentPermissionRequest.recipient_member_id == member_id, DesktopSetup.org_id == org_id)
        .order_by(AgentPermissionRequest.created_at.desc())
        .limit(100)
    )).all()
    rows = [(r, s) for r, s in rows if state is None or shown_state(r, now) == state]
    if not rows:
        return []
    from app.services import remote_control

    setup_ids = {s.id for _r, s in rows}
    reachable = await _reachable(db, setup_ids, now)
    # story #4589 (PO 00:37Z): with the org's «원격 제어» off no answer can go down (the command is refused 409) — read here, never
    # withdrawn: turned on again, the same rows are answerable again (a withdrawn row could never be: the daemon's same request_id
    # finds it). The card says why in place of its buttons; «unknown» would call it a lost connection
    off = not await remote_control.is_enabled(db, org_id)
    paired_setups = set((await db.execute(
        select(RemoteDevicePairing.setup_id).join(RemoteDevice, RemoteDevice.id == RemoteDevicePairing.remote_device_id)
        .where(RemoteDevice.member_id == member_id, RemoteDevice.revoked_at.is_(None), RemoteDevicePairing.removed_at.is_(None),
               RemoteDevicePairing.setup_id.in_(setup_ids))
    )).scalars().all())
    names = dict((await db.execute(
        select(Member.id, Member.name).where(
            Member.id.in_({r.agent_member_id for r, _s in rows} | {r.answered_by for r, _s in rows if r.answered_by}),
        )
    )).all())
    out = []
    for r, s in rows:
        shown = shown_state(r, now)
        # story #4590: a terminal-only question is never answerable here (no button · no signing values · the answer route refuses it)
        # story #4589: nor anything while the org's «원격 제어» is off
        answerable = shown == "pending" and s.id in reachable and s.id in paired_setups and not r.terminal_only and not off
        role = next((m.get("role") for m in (s.members or []) if m.get("member_id") == str(r.agent_member_id)), None)
        out.append({
            "id": str(r.id), "request_id": str(r.request_id), "setup_id": str(s.id), "device_name": s.device_name,
            "agent_member_id": str(r.agent_member_id), "agent_name": names.get(r.agent_member_id), "role": role,
            # story 4542: the name a person reads (web card) by the one rule, from the row's own runtime + tool — the phone's signing
            # sheet never shows it (it names the tool from the value it signs)
            "runtime": r.runtime, "tool": r.tool,
            # story #4590: no tool read (a terminal-only question) → no name; the card says «무엇을 묻는지는 … 볼 수 있어요» instead
            "tool_name": {lang: shown_tool(r.runtime, r.tool, lang) for lang in ("ko", "en")} if r.tool is not None else None,
            "terminal_only": r.terminal_only,
            "summary": r.summary, "masked": r.masked, "truncated": r.truncated, "workdir": r.workdir,
            "created_at": r.created_at.isoformat(), "expires_at": r.expires_at.isoformat(), "state": shown,
            "answered_by_name": names.get(r.answered_by) if r.answered_by else None, "decision": r.decision,
            "device_reachable": s.id in reachable, "recipient_reason": r.recipient_reason,
            "answerable": answerable, "remote_control_off": off,
            # story 4532 (PO 21:39Z · 까디르 1선): the values the phone signs, read by the phone's own shell from here — never handed
            # over by the web page (a page that passes them could have the phone sign another request of the same tool). Only on a
            # row the person can answer now (까디르 ② · PO 01:40Z): `input_hash` is an unsalted sha256 of the raw input, so a short
            # secret in it could be matched offline — no row carries it longer than its answer needs. (the keyed hash is second-line)
            "session_key": r.session_key if answerable else None, "input_hash": r.input_hash if answerable else None,
            # story #4580 AC2: the second answer of a network question — the card's second state shows the host (the daemon's value
            # from Claude's own hook text) and the phone signs it along
            "stage": r.stage, "host": r.host if r.stage == "confirm" else None,
            "host_unread": r.state == "withdrawn" and r.result_code == "host_unread",
        })
    return out


def open_requests_count(*, member_id, org_id: uuid.UUID):
    """A scalar subquery: the requests sent to this person still open — pending and inside the window (an expired one is still
    shown for a while, but waits for no answer). For the approvals badge's one statement (routers.gates). story #4589: none while
    the org's «원격 제어» is off — nothing can be answered here then (the list still shows them, with why)."""
    from app.models.organization import Organization

    return (
        select(func.count()).select_from(AgentPermissionRequest)
        .join(DesktopSetup, DesktopSetup.id == AgentPermissionRequest.setup_id)
        .join(Organization, Organization.id == DesktopSetup.org_id)
        .where(AgentPermissionRequest.recipient_member_id == member_id, AgentPermissionRequest.state == "pending",
               AgentPermissionRequest.expires_at > func.now(), DesktopSetup.org_id == org_id,
               # story #4590 (Yuna §3): a terminal-only question is on the list but never on the badge — nothing to do here
               AgentPermissionRequest.terminal_only.is_(False),
               # story #4589: nor anything while the org's «원격 제어» is off
               Organization.remote_control_enabled_at.is_not(None))
        .scalar_subquery()
    )


# ── ③ the phone answers ──────────────────────────────────────────────────────────────────────────────────────────────────


class Answer(BaseModel):
    model_config = ConfigDict(extra="forbid")

    decision: Literal["allow", "deny"]
    signed: str = Field(min_length=1, max_length=16384)  # the phone's blob — carried, never opened
    phone_key_id: uuid.UUID


async def answer_request(db: AsyncSession, *, member_id: uuid.UUID, org_id: uuid.UUID, request_pk: uuid.UUID, body: Answer) -> AgentPermissionRequest:
    from app.models.member import Member
    from app.services.desktop_relay import enqueue_command

    found = (await db.execute(
        select(AgentPermissionRequest, DesktopSetup).join(DesktopSetup, DesktopSetup.id == AgentPermissionRequest.setup_id)
        .where(AgentPermissionRequest.id == request_pk, AgentPermissionRequest.recipient_member_id == member_id,
               DesktopSetup.org_id == org_id)
        .with_for_update(of=AgentPermissionRequest)
    )).first()
    if found is None:
        raise DesktopRelayError(404, "request_not_found", "no such permission request for you")
    row, setup = found
    now = _now()
    if row.state in ("answered", "rejected"):
        who = (await db.execute(select(Member.name).where(Member.id == row.answered_by))).scalar_one_or_none() if row.answered_by else None
        raise DesktopRelayError(409, "already_answered", "this request was answered", detail={"answered_by_name": who, "decision": row.decision})
    if row.state == "withdrawn":
        raise DesktopRelayError(410, "withdrawn", "the agent no longer waits for this answer")
    # story #4590 (Mirko ③): only that computer's terminal answers it — no command goes down (its list row was never answerable)
    if row.terminal_only:
        raise DesktopRelayError(409, "terminal_only", "this question can only be answered in that computer's terminal")
    if shown_state(row, now) == "expired":
        raise DesktopRelayError(410, "expired", "the permission window has passed")
    # the phone must be this person's and paired to this device now — or the daemon would refuse it (unknown_key) and, the
    # first answer being the only one, a real answer after it could not come (PO 13:21Z): refused here, the request stays pending
    phone = await paired_phone(db, member_id=member_id, phone_id=body.phone_key_id, setup_id=setup.id)
    if phone is None:
        raise DesktopRelayError(409, "phone_not_paired", "this phone is not paired with that computer")
    if setup.id not in await _reachable(db, {setup.id}, now):
        raise DesktopRelayError(409, "device_unreachable", "that computer has not been heard from")
    # story #4580: the second answer (stage «confirm») is its own command — the first one's key would drop it as a repeat — and
    # carries the host the person saw, which the daemon checks against its own value and the signed payload
    confirm = row.stage == "confirm"
    await enqueue_command(
        db, setup=setup, kind="answer_approval", idempotency_key=f"perm:{row.request_id}{':confirm' if confirm else ''}",
        requested_by=member_id,
        payload={"session_key": row.session_key, "request_id": str(row.request_id), "decision": body.decision, "signed": body.signed,
                 **({"stage": "confirm", "host": row.host} if confirm else {})},
    )
    row.state, row.answered_by, row.answered_phone_key_id = "answered", member_id, phone.id
    row.decision, row.answered_at = body.decision, now
    phone.last_used_at = now
    await db.flush()
    _schedule_changed(db, row.request_id, row.recipient_member_id, row.state)  # story #4612: other open screens
    return row


async def paired_phone(db: AsyncSession, *, member_id: uuid.UUID, phone_id: uuid.UUID, setup_id: uuid.UUID) -> RemoteDevice | None:
    """The person's own phone key, paired with that computer now (not removed) — or None. One check for a permission answer
    (§9 ③) and a stop/instruction (§11 ②, story #4534)."""
    return (await db.execute(
        select(RemoteDevice).join(RemoteDevicePairing, RemoteDevicePairing.remote_device_id == RemoteDevice.id)
        .where(RemoteDevice.id == phone_id, RemoteDevice.member_id == member_id, RemoteDevice.revoked_at.is_(None),
               RemoteDevicePairing.setup_id == setup_id, RemoteDevicePairing.removed_at.is_(None))
    )).scalar_one_or_none()


# ── ④ the daemon's verdict on the answer ────────────────────────────────────────────────────────────────────────────────


async def on_answer_result(db: AsyncSession, setup_id: uuid.UUID, request_id: str, state: str, result_code: str | None, *, stage: str = "ask") -> None:
    """Called with an `answer_approval` command's result: the daemon refused the signature (or failed) → `rejected` + its code.
    `done` leaves `answered` as it is."""
    if state not in ("rejected", "failed"):
        return
    rid = _uuid(request_id)
    if rid is None:
        return
    changed = (await db.execute(
        update(AgentPermissionRequest)
        .where(AgentPermissionRequest.setup_id == setup_id, AgentPermissionRequest.request_id == rid,
               AgentPermissionRequest.state == "answered", AgentPermissionRequest.stage == stage)
        .values(state="rejected", result_code=result_code or state)
        .returning(AgentPermissionRequest.request_id, AgentPermissionRequest.recipient_member_id)
    )).all()
    for req_id, recipient in changed:  # story #4612: only a row that really moved
        _schedule_changed(db, req_id, recipient, "rejected")
