"""story 4972 (design ② §5-2 «숫자 절차») — pairing on the new procedure, the server's half: it carries four small public messages between a computer and a phone and enforces ORDER and «ONE».

host   → server   register the offer the QR names (the window of the QR: ≤ 5 min)
phone  → server   COMMIT  C_p                      (one per offer — a second one, from anyone, ends the offer: «burn»)
server → host     frame `pairing_commit`
host   → server   NONCE   n_m + its signature over «offer ‖ C_p ‖ n_m»   (one per commitment)
phone  ← server   the nonce (it checks the host's signature with the host key the QR carried — the server cannot make one)
phone  → server   REVEAL  its keys · n_p · name · the box key's binding signature   (one per nonce)
server → host     frame `pairing_reveal`
both              the 8-digit number is computed on each side and compared by the two people — the check; the server has no secret and checks no cryptography of it.

What the server decides: who may send (a commitment and a reveal only from a person of the computer's organization, the key theirs and live, the reveal only by the one who committed; the host's messages only by the
device token of that computer), the order (nonce only after a commitment, a reveal only after a nonce — the database says so too, 0481), the «one» (a second different commitment or reveal ends the offer for good), and the window.
A computer that registered such an offer is on this procedure for good: the old six-digit offer is refused for it (`has_session`). Nothing here changes a pin: the host pins only after its own person's [같아요].
"""
from __future__ import annotations

import logging
import uuid
from datetime import datetime, timedelta

from pydantic import AwareDatetime, BaseModel, ConfigDict, Field, field_validator
from sqlalchemy import delete, select, update
from sqlalchemy.exc import IntegrityError
from sqlalchemy.ext.asyncio import AsyncSession

from app.models.agent_permission import RemoteDevice, RemoteDevicePairingSession
from app.models.desktop_setup import DesktopSetup
from app.services.agent_permissions import PAIRING_OFFER_TTL, _log_setup_not_found, _now, _reachable, _wake_device_after_commit
from app.services.desktop_relay import DesktopRelayError

logger = logging.getLogger(__name__)

RECEIPT_GRACE = timedelta(seconds=15)  # story 4972 (4a): how long after the offer's end a receipt is still taken — the same constant as the phone's provisional-pin window (FINISH_GRACE_MS in lib/phoneCalls.js)
BURNED = "offer_burned"  # the code a router commits (the burn is the point of the refusal: it must not be rolled back with it)
_B64_32 = r"^[A-Za-z0-9_-]{43}$"   # 32 bytes
_B64_16 = r"^[A-Za-z0-9_-]{22}$"   # 16 bytes
_B64_SPKI = r"^[A-Za-z0-9_-]{122}$"  # the 91-byte P-256 SPKI
_B64_SIG = r"^[A-Za-z0-9_-]{16,100}$"  # a DER ECDSA P-256 signature


class SessionRegister(BaseModel):
    model_config = ConfigDict(extra="forbid")

    offer_id: uuid.UUID
    expires_at: AwareDatetime


class SessionCommit(BaseModel):
    model_config = ConfigDict(extra="forbid")

    setup_id: uuid.UUID
    phone_key_id: uuid.UUID
    commit: str = Field(pattern=_B64_32)


class SessionNonce(BaseModel):
    model_config = ConfigDict(extra="forbid")

    n_m: str = Field(pattern=_B64_16)
    sig: str = Field(pattern=_B64_SIG)


class SessionConfirmed(BaseModel):
    model_config = ConfigDict(extra="forbid")

    sig: str = Field(pattern=_B64_SIG)


class SessionReveal(BaseModel):
    model_config = ConfigDict(extra="forbid")

    setup_id: uuid.UUID
    phone_spki: str = Field(pattern=_B64_SPKI)
    phone_box_pub: str = Field(pattern=_B64_32)
    n_p: str = Field(pattern=_B64_16)
    label: str = Field(min_length=1, max_length=64)
    binding_sig: str = Field(pattern=_B64_SIG)

    @field_validator("label")
    @classmethod
    def _label_utf16(cls, v: str) -> str:
        """the limit in the unit the phone and the host count (UTF-16 code units): 64 code points is up to 128 of them — a name the host would refuse must not be carried"""
        if len(v.encode("utf-16-le")) // 2 > 64:
            raise ValueError("label too long")
        return v


class SessionPhoneRef(BaseModel):
    model_config = ConfigDict(extra="forbid")

    setup_id: uuid.UUID


async def lock_setup(db: AsyncSession, setup_id: uuid.UUID) -> None:
    """Serialize everything that decides «which procedure does this computer pair by» — a registration (and the replacement of the offer before it) and an old-style offer — on the computer's own row, so that an old offer cannot be accepted
    beside a registration that is just being made, and two registrations cannot both stay live (codex)."""
    await db.execute(select(DesktopSetup.id).where(DesktopSetup.id == setup_id).with_for_update())


async def has_session(db: AsyncSession, setup_id: uuid.UUID) -> bool:
    """Did this computer ever register an offer on the new procedure? — then the old six-digit offer is refused for it (no downgrade). The mark is the column `desktop_setups.pairing_v2_at` (one way), not the existence of session rows."""
    return (await db.execute(select(DesktopSetup.pairing_v2_at).where(DesktopSetup.id == setup_id))).scalar_one_or_none() is not None


async def _lock(db: AsyncSession, setup_id: uuid.UUID, offer_id: uuid.UUID) -> RemoteDevicePairingSession | None:
    return (await db.execute(
        select(RemoteDevicePairingSession).where(RemoteDevicePairingSession.setup_id == setup_id, RemoteDevicePairingSession.offer_id == offer_id).with_for_update()
    )).scalar_one_or_none()


def _live(row: RemoteDevicePairingSession | None) -> RemoteDevicePairingSession:
    """the row, or the one «not found» — and a burned or expired offer says so (nothing on a dead offer is carried any more)"""
    if row is None:
        raise DesktopRelayError(404, "offer_not_found", "no such pairing offer")
    if row.burned_at is not None:
        raise DesktopRelayError(409, BURNED, "this pairing offer was ended")
    if row.expires_at <= _now():
        raise DesktopRelayError(410, "offer_expired", "the pairing offer has expired")
    return row


async def _burn(db: AsyncSession, row: RemoteDevicePairingSession, reason: str) -> DesktopRelayError:
    """end the offer for good and return the refusal to raise (the router commits the burn for this code)"""
    if row.burned_at is None:
        row.burned_at, row.burn_reason = _now(), reason
        await db.flush()
        _wake_device_after_commit(db, row.setup_id)  # the computer hears of it now, not at the stream's next look
    return DesktopRelayError(409, BURNED, "this pairing offer was ended")


# ── the computer (device token) ─────────────────────────────────────────────────────────────────────────────────────────────


async def register(db: AsyncSession, setup: DesktopSetup, body: SessionRegister) -> RemoteDevicePairingSession:
    """The computer opened a QR on the new procedure: its offer is registered here (so that a commitment can come only for an offer that exists — and only the computer can make one exist)."""
    from app.services import remote_control

    await lock_setup(db, setup.id)
    if not await remote_control.is_enabled(db, setup.org_id):
        raise DesktopRelayError(409, remote_control.OFF_CODE, "remote control is off for this organization")
    now = _now()
    if not (now < body.expires_at <= now + PAIRING_OFFER_TTL + timedelta(seconds=5)):  # 5 s for the two clocks
        raise DesktopRelayError(422, "invalid_expiry", "the offer has expired or reaches beyond its window")
    existing = await _lock(db, setup.id, body.offer_id)
    if existing is not None:
        if existing.burned_at is not None:  # the real state, never «registered» again (a computer that registers again must learn the offer ended)
            raise DesktopRelayError(409, BURNED, "this pairing offer was ended")
        if existing.expires_at == body.expires_at:  # the same registration again (a reconnect)
            return existing
        raise DesktopRelayError(409, "offer_used", "this pairing offer was already registered")
    # a new QR replaces the one before it: that one ends (no two offers of one computer are live at once), and old rows go
    await db.execute(update(RemoteDevicePairingSession).where(
        RemoteDevicePairingSession.setup_id == setup.id, RemoteDevicePairingSession.burned_at.is_(None), RemoteDevicePairingSession.expires_at > now,
    ).values(burned_at=now, burn_reason="superseded"))
    await db.execute(delete(RemoteDevicePairingSession).where(
        RemoteDevicePairingSession.setup_id == setup.id, RemoteDevicePairingSession.expires_at < now - timedelta(hours=1),
    ))
    # the one-way mark (under the computer's row lock): from now on the old six-digit offer is refused for this computer
    await db.execute(update(DesktopSetup).where(DesktopSetup.id == setup.id, DesktopSetup.pairing_v2_at.is_(None)).values(pairing_v2_at=now))
    row = RemoteDevicePairingSession(id=uuid.uuid4(), setup_id=setup.id, offer_id=body.offer_id, expires_at=body.expires_at)
    db.add(row)
    try:
        await db.flush()
    except IntegrityError:
        raise DesktopRelayError(409, "offer_used", "this pairing offer was already registered") from None
    return row


async def post_nonce(db: AsyncSession, setup: DesktopSetup, offer_id: uuid.UUID, body: SessionNonce) -> None:
    """The computer's n_m and its signature — only after a commitment, once (the same again is fine; another is refused and the offer is not touched: it is the computer's own mistake)."""
    row = _live(await _lock(db, setup.id, offer_id))
    if row.commitment is None:
        raise DesktopRelayError(409, "no_commit", "there is no commitment to answer")
    if row.n_m is not None:
        if (row.n_m, row.nonce_sig) == (body.n_m, body.sig):
            return
        raise DesktopRelayError(409, "nonce_used", "this commitment was already answered")
    row.n_m, row.nonce_sig, row.nonced_at = body.n_m, body.sig, _now()
    await db.flush()


async def post_confirmed(db: AsyncSession, setup: DesktopSetup, offer_id: uuid.UUID, body: SessionConfirmed) -> None:
    """story 4972 (wiring 4a): the computer's signed receipt «I confirmed THIS offer» — only for the offer of THIS setup (its device token: another setup's token finds «no such offer»), only after the phone revealed,
    once (the same value again is fine; another is refused and nothing is overwritten). The server does not check the signature: the phone does, with the computer's key the QR carried.
    The window it is taken in is the offer's end + RECEIPT_GRACE (the phone's provisional pin waits the same time): a person who pressed [같아요] just before the QR's end and whose computer needed a moment to keep the phone still gets
    the receipt through. A burned offer takes none."""
    row = await _lock(db, setup.id, offer_id)
    if row is None:
        raise DesktopRelayError(404, "offer_not_found", "no such pairing offer")
    if row.burned_at is not None:
        raise DesktopRelayError(409, BURNED, "this pairing offer was ended")
    if row.expires_at + RECEIPT_GRACE <= _now():
        raise DesktopRelayError(410, "offer_expired", "the pairing offer has expired")
    if row.reveal is None:
        raise DesktopRelayError(409, "no_reveal", "there is no reveal to confirm")
    if row.confirmed_sig is not None:
        if row.confirmed_sig == body.sig:
            return
        raise DesktopRelayError(409, "already_confirmed", "this pairing offer was already confirmed")
    row.confirmed_sig, row.confirmed_at = body.sig, _now()
    await db.flush()


async def close_by_host(db: AsyncSession, setup: DesktopSetup, offer_id: uuid.UUID) -> None:
    """The computer's person pressed [달라요] (or the window closed on its side): the offer ends. Idempotent."""
    row = await _lock(db, setup.id, offer_id)
    if row is None:
        raise DesktopRelayError(404, "offer_not_found", "no such pairing offer")
    if row.burned_at is None:
        row.burned_at, row.burn_reason = _now(), "host_closed"
        await db.flush()


async def frames_to_send(db: AsyncSession, setup_id: uuid.UUID) -> list[tuple[str, dict]]:
    """What the computer is told, on every connection until the offer's window ends (the daemon keeps what it has: a frame again is harmless): a commitment (until the computer has answered it) and a reveal.
    Nothing is added by a frame: the computer checks the commitment against its own session and pins nothing before its person's [같아요]."""
    now = _now()
    rows = (await db.execute(
        select(RemoteDevicePairingSession).where(
            RemoteDevicePairingSession.setup_id == setup_id, RemoteDevicePairingSession.expires_at > now, RemoteDevicePairingSession.burned_at.is_(None),
            RemoteDevicePairingSession.commitment.is_not(None),
        ).order_by(RemoteDevicePairingSession.created_at)
    )).scalars().all()
    out: list[tuple[str, dict]] = []
    # an offer ended by the OTHER side (a second commitment · a second reveal · a key that is not the committed one · the phone's [달라요]) is told to the computer: it must not keep showing a number — and keep its [같아요] alive — for a pairing
    # the server has ended (the computer's own closing and its own newer QR are its own acts: not told back)
    for r in (await db.execute(
        select(RemoteDevicePairingSession).where(
            RemoteDevicePairingSession.setup_id == setup_id, RemoteDevicePairingSession.expires_at > now, RemoteDevicePairingSession.burned_at.is_not(None),
            RemoteDevicePairingSession.burn_reason.in_(("second_commit", "second_reveal", "key_mismatch", "phone_declined")),
        ).order_by(RemoteDevicePairingSession.created_at)
    )).scalars().all():
        out.append((f"burned:{r.offer_id}", {"offer_id": str(r.offer_id), "reason": r.burn_reason}))
    for r in rows:
        if r.n_m is None:
            out.append((f"commit:{r.offer_id}", {"offer_id": str(r.offer_id), "phone_key_id": str(r.phone_key_id), "commit": r.commitment}))
        if r.reveal is not None:
            out.append((f"reveal:{r.offer_id}", {"offer_id": str(r.offer_id), "phone_key_id": str(r.phone_key_id), **r.reveal}))
    return out


# ── the phone (a person's session) ──────────────────────────────────────────────────────────────────────────────────────────


async def _setup_for(db: AsyncSession, *, member_id: uuid.UUID, org_id: uuid.UUID, setup_id: uuid.UUID) -> DesktopSetup:
    setup = (await db.execute(
        select(DesktopSetup).where(DesktopSetup.id == setup_id, DesktopSetup.org_id == org_id, DesktopSetup.revoked_at.is_(None), DesktopSetup.exchanged_at.is_not(None))
    )).scalar_one_or_none()
    if setup is None:  # one answer for «not there · another org's · disconnected · not exchanged» (as the offer's)
        await _log_setup_not_found(db, member_id=member_id, org_id=org_id, setup_id=setup_id)
        raise DesktopRelayError(404, "setup_not_found", "no such computer")
    return setup


async def commit(db: AsyncSession, *, member_id: uuid.UUID, org_id: uuid.UUID, offer_id: uuid.UUID, body: SessionCommit) -> None:
    """The phone's commitment C_p. A member of the computer's organization only, with a key of their own; the FIRST one only: a second one — the same person's other key, another person, other bytes — ends the offer
    (a commitment from someone who is not the phone at the QR cannot be told from one that is; one is all there is, so a second means the QR was seen by a hand that was not alone). The same commitment again from the
    same person and key is the same answer (a retry)."""
    from app.services import remote_control

    phone = (await db.execute(
        select(RemoteDevice).where(RemoteDevice.id == body.phone_key_id, RemoteDevice.member_id == member_id, RemoteDevice.revoked_at.is_(None))
    )).scalar_one_or_none()
    if phone is None:
        raise DesktopRelayError(404, "phone_key_not_found", "no such phone key of yours")
    setup = await _setup_for(db, member_id=member_id, org_id=org_id, setup_id=body.setup_id)
    if not await remote_control.is_enabled(db, org_id):
        raise DesktopRelayError(409, remote_control.OFF_CODE, "remote control is off for this organization")
    row = _live(await _lock(db, setup.id, offer_id))
    if row.commitment is not None:
        if (row.committed_by, row.phone_key_id, row.commitment) == (member_id, phone.id, body.commit):
            return
        raise await _burn(db, row, "second_commit")
    if setup.id not in await _reachable(db, {setup.id}, _now()):
        raise DesktopRelayError(409, "device_unreachable", "that computer has not been heard from")
    row.commitment, row.committed_by, row.phone_key_id, row.committed_at = body.commit, member_id, phone.id, _now()
    await db.flush()
    _wake_device_after_commit(db, setup.id)


async def _mine(db: AsyncSession, *, member_id: uuid.UUID, org_id: uuid.UUID, setup_id: uuid.UUID, offer_id: uuid.UUID) -> RemoteDevicePairingSession:
    """the session as the phone that committed sees it — anyone else gets the same «not found»"""
    row = (await db.execute(
        select(RemoteDevicePairingSession).join(DesktopSetup, DesktopSetup.id == RemoteDevicePairingSession.setup_id)
        .where(RemoteDevicePairingSession.setup_id == setup_id, RemoteDevicePairingSession.offer_id == offer_id,
               RemoteDevicePairingSession.committed_by == member_id, DesktopSetup.org_id == org_id).with_for_update(of=RemoteDevicePairingSession)  # the session row only: the lock order stays «computer row, then its sessions» (a registration takes them in that order)
    )).scalar_one_or_none()
    if row is None:
        raise DesktopRelayError(404, "offer_not_found", "no such pairing offer of yours")
    return row


async def state(db: AsyncSession, *, member_id: uuid.UUID, org_id: uuid.UUID, setup_id: uuid.UUID, offer_id: uuid.UUID) -> dict:
    """What the phone that committed waits for: the computer's nonce (its value and signature). `burned` / `expired` end the wait. `confirmed_sig` (story 4972 · 4a): the computer's signed receipt once it
    wrote one — also after the window ran out (the phone may read it a moment late: its own end is a little after the QR's) — and never on a burned offer (nothing is carried on a dead offer)."""
    row = await _mine(db, member_id=member_id, org_id=org_id, setup_id=setup_id, offer_id=offer_id)
    if row.burned_at is not None:
        return {"state": "burned", "n_m": None, "sig": None, "confirmed_sig": None}
    receipt = row.confirmed_sig
    if row.expires_at <= _now():
        return {"state": "expired", "n_m": None, "sig": None, "confirmed_sig": receipt}
    if row.n_m is None:
        return {"state": "committed", "n_m": None, "sig": None, "confirmed_sig": None}
    return {"state": "revealed" if row.reveal is not None else "nonce", "n_m": row.n_m, "sig": row.nonce_sig, "confirmed_sig": receipt}


async def reveal(db: AsyncSession, *, member_id: uuid.UUID, org_id: uuid.UUID, offer_id: uuid.UUID, body: SessionReveal) -> None:
    """The phone's reveal — only after the computer's nonce, only by the phone that committed, once. Its public key must be the one it registered (the key the commitment named). Another reveal for the same offer ends it."""
    row = await _mine(db, member_id=member_id, org_id=org_id, setup_id=body.setup_id, offer_id=offer_id)
    _live(row)
    if row.n_m is None:
        raise DesktopRelayError(409, "no_nonce", "the computer has not answered the commitment yet")
    phone = (await db.execute(select(RemoteDevice).where(RemoteDevice.id == row.phone_key_id, RemoteDevice.revoked_at.is_(None)))).scalar_one_or_none()
    if phone is None:
        raise DesktopRelayError(404, "phone_key_not_found", "no such phone key of yours")
    payload = {"phone_spki": body.phone_spki, "phone_box_pub": body.phone_box_pub, "n_p": body.n_p, "label": body.label, "binding_sig": body.binding_sig}
    if row.reveal is not None:
        if row.reveal == payload:
            return
        raise await _burn(db, row, "second_reveal")
    if body.phone_spki != phone.public_key:  # not the key this offer was committed for
        raise await _burn(db, row, "key_mismatch")
    row.reveal, row.revealed_at = payload, _now()
    await db.flush()
    _wake_device_after_commit(db, row.setup_id)


async def close_by_phone(db: AsyncSession, *, member_id: uuid.UUID, org_id: uuid.UUID, setup_id: uuid.UUID, offer_id: uuid.UUID) -> None:
    """The phone's person pressed [달라요]: the offer ends. Idempotent."""
    row = await _mine(db, member_id=member_id, org_id=org_id, setup_id=setup_id, offer_id=offer_id)
    if row.burned_at is None:
        row.burned_at, row.burn_reason = _now(), "phone_declined"
        await db.flush()
        _wake_device_after_commit(db, row.setup_id)
