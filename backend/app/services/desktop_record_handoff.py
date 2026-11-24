"""story 4978 (C2) — the record-key HANDOFF relay: a SEALED `record_handoff` envelope carried between two paired devices, from the one that holds the record key R to the one that has just been paired (a computer → a new phone, or a phone → a new computer).

What travels: an envelope the server cannot open (R is inside it, wrapped to ONE receiver; the body is always the same width, so not even how many key generations travel). The server never holds a key, checks no signature and reads no word: it judges the
SHAPE and the size (`envelope_shape.check_record_handoff`), that the request is for a pair of THIS organization, and nothing else; the receiver checks everything that needs a key (the signature, the pinned sender, the receiver fingerprint, the time, the replay mark).

  addressing ......... the pair it travels on — (computer `setup_id`, phone `remote_device_id`) — and a direction (`host_to_phone` · `phone_to_host`). The phone is always named by ITS OWN device id (the key the person registered); a phone that is not its caller's (another
                       person's, another organization's, revoked) is «not found» — never told apart.
  who puts ........... the computer (its device token) into a phone of its own organization; or a person's phone (its owner's session) into a computer of the same organization. A phone whose pairing with that computer was REMOVED gets nothing (409 `phone_not_paired`) —
                       a pair removed takes this with it, and a revoked key cannot take R.
  who reads .......... the receiver only: the phone (its owner's session · its own device id) the rows addressed to that phone; the computer (its device token) the rows addressed to it. Read does NOT delete; the receiver's «received» does — «the server holds only
                       ciphertext briefly and deletes it on receipt». A read judges the pair AGAIN (a removed pairing's rows are deleted and not served): the put-time check is a courtesy, the read is the door.
  how long it lives .. put + 15 minutes (the envelope's own window is at most 10); gone at once when received; swept at expiry (cron + every put and read); gone with its computer's disconnect · remote control turned off · the pairing removed · the phone's key revoked.
  what the sender may ask  `waiting`: the rows IT put that nobody has received yet — ids and ends with the server's own clock (`now`), never an envelope. A row that is gone BEFORE its end was received; one that ran out was not. The put's own
                       answer names the row's end too (the server's clock) — so the sender never compares its own clock with a time the server wrote.
  limits ............. at most 8 unread per (pair · direction) — more is 409 `handoff_queue_full` (the sender tries again after the receiver has taken some); one envelope (`command_id`) is one row WHILE IT IS HERE: its retry is the same row (200, not 201). Once it is received the row is gone and a
                       retry of it is a new row (201): the delivery is AT LEAST ONCE — the receiver's replay guard refuses the second copy (the envelope is one-time), and the server keeps no tombstone (it would keep the envelope's trace past «deletes on receipt»); the body is read to at most 32 KiB.
  who may travel .... a pair on the server that is not removed — or, while the computer has not listed the pair yet, one person who owns both ends (the computer's confirming person is the phone's owner). The organization's «remote control» is on (judged under a share lock of the organization row).
  what is logged ..... ids and counts only: never an envelope, never a size of a body beyond «too large».
"""
from __future__ import annotations

import json
import logging
import uuid
from datetime import datetime, timedelta, timezone

from sqlalchemy import delete, func, select
from sqlalchemy.exc import IntegrityError
from sqlalchemy.ext.asyncio import AsyncSession

from app.models.agent_permission import RemoteDevice, RemoteDevicePairing
from app.models.desktop_relay import DesktopRecordHandoff
from app.models.desktop_setup import DesktopSetup
from app.models.member import Member
from app.models.organization import Organization
from app.services.desktop_relay import DesktopRelayError
from app.services.envelope_shape import check_record_handoff

logger = logging.getLogger(__name__)

HANDOFF_TTL = timedelta(minutes=15)
QUEUE_MAX = 8  # unread per (pair · direction)
LIST_MAX = 24  # one read returns at most this many (oldest first)
WAITING_MAX = 1024  # a `waiting` answer names at most this many rows (a computer: 16 pairings × 8; a phone: 8 per computer it is paired with) — and says `complete: false` when there were more, so a row that is simply not named is never read as «received»
BODY_MAX = 32 * 1024  # the JSON text of `{"envelope": …}`: the 14,608-byte body is ≈19.5 KB as base64url + the header
HOST_TO_PHONE = "host_to_phone"
PHONE_TO_HOST = "phone_to_host"


def _now() -> datetime:
    return datetime.now(timezone.utc)


def parse_body(raw: bytes, *, setup_id: uuid.UUID) -> tuple[dict, str]:
    """`{"envelope": <a record_handoff envelope>}` and nothing else → (the envelope unchanged, its `command_id`). Any other shape is 422 `invalid_record_handoff` — the message is ours, never a word of the caller's."""
    if len(raw) > BODY_MAX:
        raise DesktopRelayError(413, "record_handoff_too_large", "the envelope is larger than the server takes")
    try:
        body = json.loads(raw)
    except (ValueError, RecursionError):
        raise DesktopRelayError(422, "invalid_record_handoff", "the body is not the agreed shape") from None
    if not isinstance(body, dict) or set(body) != {"envelope"}:
        raise DesktopRelayError(422, "invalid_record_handoff", "the body is not the agreed shape")
    try:
        env = check_record_handoff(body["envelope"], setup_id=str(setup_id))
    except ValueError as exc:
        raise DesktopRelayError(422, "invalid_record_handoff", str(exc)) from None
    return env, env["command_id"]


async def _phone_of(db: AsyncSession, *, member_id: uuid.UUID | None, org_id: uuid.UUID, phone_id: uuid.UUID) -> RemoteDevice:
    """The phone key `phone_id` of this organization, not revoked — and, when a person asks, THAT person's own. Locked FOR UPDATE: puts of one phone are one line (the cap below is then exact), and a revocation waits for it (the same row it takes)."""
    stmt = select(RemoteDevice).where(RemoteDevice.id == phone_id, RemoteDevice.org_id == org_id, RemoteDevice.revoked_at.is_(None))
    if member_id is not None:
        stmt = stmt.where(RemoteDevice.member_id == member_id)
    phone = (await db.execute(stmt.with_for_update())).scalar_one_or_none()
    if phone is None:
        raise DesktopRelayError(404, "phone_not_found", "no such phone")
    return phone


async def _may_travel(db: AsyncSession, *, setup_id: uuid.UUID, phone_id: uuid.UUID) -> bool:
    """May a handoff travel between THIS computer and THIS phone? The computer is live (not disconnected — judged under a SHARE lock of its row, which a disconnect takes FOR UPDATE before it deletes the rows), the phone key is live and of the same
    organization, and either the pair is on the server and not removed, or — while the computer has not listed the pair yet (it lists it after its person pressed «same»: a pair in the making) — ONE active person owns both ends: the person who confirmed the
    computer is the member who owns the phone's key. A stranger's phone, a phone nobody paired and a member who is gone may not put an envelope on a computer or take one meant for it. The pairing row is share-locked too (the removals take it FOR UPDATE)."""
    setup = (await db.execute(
        select(DesktopSetup.confirmed_by, DesktopSetup.org_id).where(DesktopSetup.id == setup_id, DesktopSetup.revoked_at.is_(None)).with_for_update(read=True)
    )).first()
    if setup is None:
        return False
    phone = (await db.execute(
        select(RemoteDevice.org_id, RemoteDevice.revoked_at, Member.user_id, Member.is_active)
        .join(Member, Member.id == RemoteDevice.member_id).where(RemoteDevice.id == phone_id)
    )).first()
    if phone is None or phone.revoked_at is not None or phone.org_id != setup.org_id:
        return False
    pair = (await db.execute(
        select(RemoteDevicePairing).where(RemoteDevicePairing.remote_device_id == phone_id, RemoteDevicePairing.setup_id == setup_id).with_for_update(read=True)
    )).scalar_one_or_none()
    if pair is not None:
        return pair.removed_at is None
    return setup.confirmed_by is not None and phone.user_id == setup.confirmed_by and bool(phone.is_active)


async def _require_remote_control(db: AsyncSession, org_id: uuid.UUID) -> None:
    """The organization's «remote control» is on — judged under a SHARE lock of the organization row (the switch's own write takes it FOR UPDATE and then deletes the rows: a put that passed this is committed before the switch deletes, one after it sees it off)."""
    from app.services import remote_control

    await db.execute(select(Organization.id).where(Organization.id == org_id).with_for_update(read=True))
    if not await remote_control.is_enabled(db, org_id):
        raise DesktopRelayError(409, remote_control.OFF_CODE, "remote control is off for this organization")


async def _put(db: AsyncSession, *, setup_id: uuid.UUID, phone_id: uuid.UUID, direction: str, env: dict, command_id: str) -> tuple[uuid.UUID, bool, datetime]:
    await purge_expired(db)
    existing = (await db.execute(
        select(DesktopRecordHandoff.id, DesktopRecordHandoff.expires_at).where(
            DesktopRecordHandoff.setup_id == setup_id, DesktopRecordHandoff.remote_device_id == phone_id,
            DesktopRecordHandoff.direction == direction, DesktopRecordHandoff.command_id == command_id,
        )
    )).first()
    if existing is not None:
        return existing[0], False, existing[1]  # the sender's retry of the same envelope: no second row
    held = (await db.execute(
        select(func.count()).select_from(DesktopRecordHandoff).where(
            DesktopRecordHandoff.setup_id == setup_id, DesktopRecordHandoff.remote_device_id == phone_id, DesktopRecordHandoff.direction == direction,
        )
    )).scalar_one()
    if held >= QUEUE_MAX:
        raise DesktopRelayError(409, "handoff_queue_full", "the receiver has not taken the envelopes already here", detail={"retry_after": 5})
    row = DesktopRecordHandoff(
        id=uuid.uuid4(), setup_id=setup_id, remote_device_id=phone_id, direction=direction, command_id=command_id, envelope=env, expires_at=_now() + HANDOFF_TTL,
    )
    try:
        async with db.begin_nested():
            db.add(row)
            await db.flush()
    except IntegrityError:  # two puts of the same envelope at once (the unique key): the other one is the row
        again = (await db.execute(
            select(DesktopRecordHandoff.id, DesktopRecordHandoff.expires_at).where(
                DesktopRecordHandoff.setup_id == setup_id, DesktopRecordHandoff.remote_device_id == phone_id,
                DesktopRecordHandoff.direction == direction, DesktopRecordHandoff.command_id == command_id,
            )
        )).first()
        if again is None:
            raise
        return again[0], False, again[1]
    return row.id, True, row.expires_at


# ── the computer's side (its device token) ─────────────────────────────────────────────────────────────────────────────────


async def host_put(db: AsyncSession, setup: DesktopSetup, phone_id: uuid.UUID, raw: bytes) -> tuple[uuid.UUID, bool, datetime]:
    """The computer puts a handoff for one of the phones of its organization → (row id, new?, the row's end — the SERVER's clock)."""
    env, command_id = parse_body(raw, setup_id=setup.id)
    await _require_remote_control(db, setup.org_id)
    await _phone_of(db, member_id=None, org_id=setup.org_id, phone_id=phone_id)
    if not await _may_travel(db, setup_id=setup.id, phone_id=phone_id):
        raise DesktopRelayError(409, "phone_not_paired", "that phone is not paired with this computer (or its pairing was removed)", detail={"retry_after": 2})
    return await _put(db, setup_id=setup.id, phone_id=phone_id, direction=HOST_TO_PHONE, env=env, command_id=command_id)


async def host_list(db: AsyncSession, setup: DesktopSetup) -> list[dict]:
    """What phones have put for this computer (oldest first) — the rows of a phone whose key was revoked or whose pairing was removed are deleted, not served."""
    await _require_remote_control(db, setup.org_id)
    # LOCK ORDER (every road of this file and of the removals that call `forget_pairs`): the phone's key row, then the pairing row, THEN the handoff rows — a read takes no lock on the handoff rows (it only reads them, and deletes by id after the others) and sweeps last,
    # so a removal (which holds the key and the pairing and then deletes rows) and a read can never wait for each other's rows
    # FAIR: the oldest row of every phone first, then the second of every phone… — a person with three phones filling their queues cannot push another phone's row out of the list
    rank = func.row_number().over(partition_by=DesktopRecordHandoff.remote_device_id, order_by=(DesktopRecordHandoff.created_at, DesktopRecordHandoff.id)).label("rank")
    ranked = (
        select(DesktopRecordHandoff.id.label("id"), rank)
        .where(DesktopRecordHandoff.setup_id == setup.id, DesktopRecordHandoff.direction == PHONE_TO_HOST, DesktopRecordHandoff.expires_at > _now()).subquery()
    )
    ids = [r[0] for r in (await db.execute(select(ranked.c.id).order_by(ranked.c.rank, ranked.c.id).limit(LIST_MAX))).all()]
    rows = (await db.execute(
        select(DesktopRecordHandoff).where(DesktopRecordHandoff.id.in_(ids)).order_by(DesktopRecordHandoff.created_at, DesktopRecordHandoff.id)
    )).scalars().all() if ids else []
    out = []
    for row in rows:
        phone = (await db.execute(select(RemoteDevice).where(RemoteDevice.id == row.remote_device_id, RemoteDevice.org_id == setup.org_id).with_for_update(read=True))).scalar_one_or_none()
        if phone is None or phone.revoked_at is not None or not await _may_travel(db, setup_id=setup.id, phone_id=row.remote_device_id):
            await db.execute(delete(DesktopRecordHandoff).where(DesktopRecordHandoff.id == row.id))
            continue
        out.append({"id": str(row.id), "phone_key_id": str(row.remote_device_id), "envelope": row.envelope, "created_at": row.created_at.isoformat()})
    await purge_expired(db)
    return out


async def host_waiting(db: AsyncSession, setup: DesktopSetup) -> dict:
    """What THIS computer put for phones that nobody has received yet — ids and ends only (`items`), with the server's own clock (`now`): a row that is gone before its end was RECEIVED, one that ran out was not. Never an envelope.
    The sender's own view (its own rows, no pair judged again: it only says «still there»); reads take no row lock and sweep last (the lock order of the file)."""
    now = _now()
    rows = (await db.execute(
        select(DesktopRecordHandoff.id, DesktopRecordHandoff.remote_device_id, DesktopRecordHandoff.expires_at).where(
            DesktopRecordHandoff.setup_id == setup.id, DesktopRecordHandoff.direction == HOST_TO_PHONE, DesktopRecordHandoff.expires_at > now,
        ).order_by(DesktopRecordHandoff.created_at, DesktopRecordHandoff.id).limit(WAITING_MAX + 1)
    )).all()
    await purge_expired(db)
    return {"now": now.isoformat(), "complete": len(rows) <= WAITING_MAX, "items": [{"id": str(r[0]), "phone_key_id": str(r[1]), "expires_at": r[2].isoformat()} for r in rows[:WAITING_MAX]]}


async def host_received(db: AsyncSession, setup: DesktopSetup, handoff_id: uuid.UUID) -> bool:
    """The computer has it: the row goes (only a row addressed to THIS computer; another's id deletes nothing)."""
    row = (await db.execute(
        select(DesktopRecordHandoff).where(DesktopRecordHandoff.id == handoff_id, DesktopRecordHandoff.setup_id == setup.id, DesktopRecordHandoff.direction == PHONE_TO_HOST)
    )).scalar_one_or_none()
    if row is None:
        return False
    # the pair is judged again (a row a removed pairing left is not «received» — it goes, and is reported as gone): the phone's key row and the pairing row first, the handoff row last
    phone = (await db.execute(select(RemoteDevice).where(RemoteDevice.id == row.remote_device_id, RemoteDevice.org_id == setup.org_id).with_for_update(read=True))).scalar_one_or_none()
    live = phone is not None and phone.revoked_at is None and await _may_travel(db, setup_id=setup.id, phone_id=row.remote_device_id)
    gone = (await db.execute(delete(DesktopRecordHandoff).where(DesktopRecordHandoff.id == handoff_id).returning(DesktopRecordHandoff.id))).scalar_one_or_none()
    return live and gone is not None and row.expires_at > _now()


# ── the phone's side (its owner's session) ─────────────────────────────────────────────────────────────────────────────────


async def phone_put(db: AsyncSession, *, member_id: uuid.UUID, org_id: uuid.UUID, setup_id: uuid.UUID, phone_id: uuid.UUID, raw: bytes) -> tuple[uuid.UUID, bool, datetime]:
    """A person's phone puts a handoff for a computer of the same organization → (row id, new?, the row's end — the SERVER's clock)."""
    env, command_id = parse_body(raw, setup_id=setup_id)
    await _require_remote_control(db, org_id)
    await _phone_of(db, member_id=member_id, org_id=org_id, phone_id=phone_id)
    setup = (await db.execute(
        select(DesktopSetup.id).where(DesktopSetup.id == setup_id, DesktopSetup.org_id == org_id, DesktopSetup.revoked_at.is_(None))
    )).scalar_one_or_none()
    if setup is None:
        raise DesktopRelayError(404, "setup_not_found", "no such computer")
    if not await _may_travel(db, setup_id=setup_id, phone_id=phone_id):
        raise DesktopRelayError(409, "phone_not_paired", "this phone is not paired with that computer (or its pairing was removed)", detail={"retry_after": 2})
    return await _put(db, setup_id=setup_id, phone_id=phone_id, direction=PHONE_TO_HOST, env=env, command_id=command_id)


async def phone_list(db: AsyncSession, *, member_id: uuid.UUID, org_id: uuid.UUID, phone_id: uuid.UUID) -> list[dict]:
    """What computers have put for this phone (oldest first); the rows of a pairing removed since are deleted, not served."""
    await _require_remote_control(db, org_id)
    await _phone_of(db, member_id=member_id, org_id=org_id, phone_id=phone_id)
    rows = (await db.execute(
        select(DesktopRecordHandoff).where(DesktopRecordHandoff.remote_device_id == phone_id, DesktopRecordHandoff.direction == HOST_TO_PHONE, DesktopRecordHandoff.expires_at > _now())
        .order_by(DesktopRecordHandoff.created_at, DesktopRecordHandoff.id).limit(LIST_MAX)
    )).scalars().all()
    out = []
    for row in rows:
        if not await _may_travel(db, setup_id=row.setup_id, phone_id=phone_id):
            await db.execute(delete(DesktopRecordHandoff).where(DesktopRecordHandoff.id == row.id))
            continue
        out.append({"id": str(row.id), "setup_id": str(row.setup_id), "envelope": row.envelope, "created_at": row.created_at.isoformat()})
    await purge_expired(db)
    return out


async def phone_waiting(db: AsyncSession, *, member_id: uuid.UUID, org_id: uuid.UUID, phone_id: uuid.UUID) -> dict:
    """What THIS phone put for computers that nobody has received yet — ids and ends only, with the server's own clock (see `host_waiting`). Only the phone's own person; another's phone is «not found»."""
    await _require_remote_control(db, org_id)
    await _phone_of(db, member_id=member_id, org_id=org_id, phone_id=phone_id)
    now = _now()
    rows = (await db.execute(
        select(DesktopRecordHandoff.id, DesktopRecordHandoff.setup_id, DesktopRecordHandoff.expires_at).where(
            DesktopRecordHandoff.remote_device_id == phone_id, DesktopRecordHandoff.direction == PHONE_TO_HOST, DesktopRecordHandoff.expires_at > now,
        ).order_by(DesktopRecordHandoff.created_at, DesktopRecordHandoff.id).limit(WAITING_MAX + 1)
    )).all()
    await purge_expired(db)
    return {"now": now.isoformat(), "complete": len(rows) <= WAITING_MAX, "items": [{"id": str(r[0]), "setup_id": str(r[1]), "expires_at": r[2].isoformat()} for r in rows[:WAITING_MAX]]}


async def phone_received(db: AsyncSession, *, member_id: uuid.UUID, org_id: uuid.UUID, phone_id: uuid.UUID, handoff_id: uuid.UUID) -> bool:
    """The phone has it: the row goes (only a row addressed to THIS phone of THIS person)."""
    await _phone_of(db, member_id=member_id, org_id=org_id, phone_id=phone_id)
    row = (await db.execute(
        select(DesktopRecordHandoff).where(
            DesktopRecordHandoff.id == handoff_id, DesktopRecordHandoff.remote_device_id == phone_id, DesktopRecordHandoff.direction == HOST_TO_PHONE,
        )
    )).scalar_one_or_none()
    if row is None:
        return False
    live = await _may_travel(db, setup_id=row.setup_id, phone_id=phone_id)  # the pair is judged again: a removed pair's row goes, and is reported as gone
    gone = (await db.execute(delete(DesktopRecordHandoff).where(DesktopRecordHandoff.id == handoff_id).returning(DesktopRecordHandoff.id))).scalar_one_or_none()
    return live and gone is not None and row.expires_at > _now()


# ── the queue's own ────────────────────────────────────────────────────────────────────────────────────────────────────────


async def purge_expired(db: AsyncSession, *, now: datetime | None = None) -> int:
    """Every row past its end goes (the cron's job, and every put's and read's first step). A row someone else holds is skipped, never waited for."""
    ids = list((await db.execute(select(DesktopRecordHandoff.id).where(DesktopRecordHandoff.expires_at <= (now or _now())).with_for_update(skip_locked=True))).scalars().all())
    if ids:
        await db.execute(delete(DesktopRecordHandoff).where(DesktopRecordHandoff.id.in_(ids)))
    return len(ids)


async def forget(db: AsyncSession, setup_ids: list[uuid.UUID], *, lock: bool = True) -> None:
    """The computers' handoffs go (a disconnect · an account's closure · a replaced line · remote control turned off): nothing stays for a computer that cannot be reached. The same lock rule as the files relay."""
    if setup_ids:
        if lock:
            await db.execute(select(DesktopSetup.id).where(DesktopSetup.id.in_(setup_ids)).order_by(DesktopSetup.id).with_for_update())
        await db.execute(delete(DesktopRecordHandoff).where(DesktopRecordHandoff.setup_id.in_(setup_ids)))


async def forget_phones(db: AsyncSession, phone_ids) -> None:
    """Phone keys were revoked (an account reclaimed): what is addressed to them or was put by them goes, on whatever computer — `phone_ids` is a column select of their ids."""
    await db.execute(delete(DesktopRecordHandoff).where(DesktopRecordHandoff.remote_device_id.in_(phone_ids)))


async def forget_pairs(db: AsyncSession, pairs: list[tuple[uuid.UUID, uuid.UUID]]) -> None:
    """A pairing was removed (one pair · a phone off a whole computer · a phone key revoked): what travels on exactly those pairs goes, both directions — a removed phone must not take R."""
    for setup_id, phone_id in pairs:
        await db.execute(delete(DesktopRecordHandoff).where(DesktopRecordHandoff.setup_id == setup_id, DesktopRecordHandoff.remote_device_id == phone_id))
