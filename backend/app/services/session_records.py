"""story 4977 B2 — the person's history as SEALED records the server cannot open (design ② §4-1b · alembic 0493).

What the server does: keeps a record envelope as it came (checked for SHAPE and size only — `check_record_envelope`), by (conversation, record id); gives it back, in order, to the person's own phone that is
STILL paired with the computer; and deletes it when the person says so. What it never does: open, search, index, notify, announce or list a record anywhere else; delete one by itself (no TTL — the person's
record stays until THEY delete it: the 11-16 decision); trust a header word (the readers verify the signature on every read).

Who may: the one person who paired the computer (`may_read`), who can read the conversation (judged in the router), and — for a phone's write or read — with a phone of theirs that is paired with the computer
THIS moment (`paired_phone` under a share lock, as the clock and the files do): a phone taken off the computer is refused at once (409 `phone_not_paired`) — the cut of «제거한 폰의 기록 읽기». The computer's own
write is by its device token. A refusal never carries what it was given (no field name · no value; the body is read and judged here, and logs hold ids only).
"""
from __future__ import annotations

import logging
import uuid
from datetime import timedelta

from pydantic import BaseModel, ConfigDict, ValidationError, field_validator
from sqlalchemy import and_, delete, false, func, or_, select, text, update
from sqlalchemy.exc import IntegrityError
from sqlalchemy.ext.asyncio import AsyncSession

from app.models.conversation import Conversation
from app.models.conversation import ConversationParticipant
from app.models.desktop_setup import DesktopSetup
from app.models.project import OrgMember
from app.models.session_record import SessionRecord
from app.services.desktop_relay import DesktopRelayError
from app.services.envelope_shape import check_record_envelope

logger = logging.getLogger(__name__)

BODY_MAX = 48 * 1024  # a record envelope is at most 32 KiB of body (a base64url text of ~44 KiB) + its header
PAGE_DEFAULT = 50
PAGE_MAX = 100
MAX_RECORDS_PER_SETUP = 100_000  # what one computer line may keep (a few KiB each: a bound on what a device can fill the database with — the person deletes to make room)
TOMBSTONE_KEEP = timedelta(days=7)  # a tombstone (no content) only has to outlast a delayed or replayed write; the minute sweep lets go of it after this
MAX_RECORDS_PER_OWNER = 200_000  # and what one person may keep over all their computers (a reinstall or a second computer does not reset it)


class _WriteBase(BaseModel):
    model_config = ConfigDict(extra="forbid")

    envelope: dict

    @field_validator("envelope")
    @classmethod
    def _shape(cls, env: dict) -> dict:
        try:
            return check_record_envelope(env)
        except ValueError as exc:
            raise ValueError(str(exc)) from None


class HostWrite(_WriteBase):
    """the computer's PUT body"""


class PhoneWrite(_WriteBase):
    """a phone's PUT body: which of the person's phones (the server asks that it is paired with this computer) and the sealed record"""

    phone_key_id: uuid.UUID


def _parse(model, raw: bytes):
    if len(raw) > BODY_MAX:
        raise DesktopRelayError(413, "record_too_large", "the record is larger than the server takes")
    try:
        return model.model_validate_json(raw)
    except ValidationError as exc:  # never `input` · never `ctx`: only our own message about the shape
        raise DesktopRelayError(422, "invalid_record", exc.errors(include_url=False, include_input=False, include_context=False)[0]["msg"]) from exc


def parse_host_write(raw: bytes) -> HostWrite:
    return _parse(HostWrite, raw)


def parse_phone_write(raw: bytes) -> PhoneWrite:
    return _parse(PhoneWrite, raw)


def scope_of(setup: DesktopSetup):
    """the live records of THIS computer of THIS person: the person's own, written on this setup line or — when the setup has a machine key — on any setup of the same machine (a
    reinstall makes a new setup row of the same computer). The records are the PERSON's own (`owner_id` = the setup's `confirmed_by`): another person's are never in it, whatever the machine; a deleted one (a tombstone)
    is in no list."""
    if setup.confirmed_by is None:
        return false()
    mine = SessionRecord.setup_id == setup.id
    if setup.machine_key:
        same_machine = select(DesktopSetup.id).where(DesktopSetup.org_id == setup.org_id, DesktopSetup.machine_key == setup.machine_key)
        mine = or_(mine, SessionRecord.setup_id.in_(same_machine))
    return and_(SessionRecord.org_id == setup.org_id, SessionRecord.owner_id == setup.confirmed_by, SessionRecord.deleted_at.is_(None), mine)


def _header_is_ours(env: dict, setup: DesktopSetup) -> None:
    """the header the writer sealed must be about THIS computer: the server cannot read the body, but it can see that the header is not another computer's"""
    if env["setup_id"] != str(setup.id):
        raise DesktopRelayError(422, "envelope_header_mismatch", "the envelope's header is not this computer's")


async def write(db: AsyncSession, setup: DesktopSetup, env: dict, *, person_must_be_in_room: bool = False) -> dict:
    """Keep one record. The same record id again (of the same person): the SAME envelope is a repeat (nothing changes); another envelope from the SAME writer with a later (epoch, counter), for a record of this
    computer of this person, replaces it (an edit · a resend — it moves to the end of the line, it stays on the computer it was written on); a record the person DELETED stays deleted (409 `record_deleted`);
    anything else is refused (409 `record_exists` · `record_stale`). `person_must_be_in_room`: the computer's own write (no person's session judged the room) — the room must be one the computer's PERSON is a
    participant of (a person's phone write was judged against the room by the router). → {"id", "seq", "replaced"}. The caller commits."""
    _header_is_ours(env, setup)
    # the computer's row is share-locked until the commit and judged AFTER the lock (the computer's own write has no phone gate to do it): a disconnect that comes meanwhile waits for this write, one that
    # committed before is seen — a revoked computer writes nothing
    locked = (await db.execute(select(DesktopSetup).where(DesktopSetup.id == setup.id).with_for_update(read=True).execution_options(populate_existing=True))).scalar_one_or_none()
    if locked is None or locked.revoked_at is not None or locked.confirmed_by is None:
        raise DesktopRelayError(403, "device_revoked", "this computer is no longer connected")
    setup = locked
    rec = env["rec"]
    conversation_id = uuid.UUID(rec["conversation_id"])
    found = (await db.execute(select(Conversation.id).where(Conversation.id == conversation_id, Conversation.org_id == setup.org_id))).scalar_one_or_none()
    if found is None:
        raise DesktopRelayError(404, "record_conversation_not_found", "no such conversation")
    if person_must_be_in_room:
        member = select(OrgMember.id).where(OrgMember.org_id == setup.org_id, OrgMember.user_id == setup.confirmed_by, OrgMember.deleted_at.is_(None))
        in_room = (await db.execute(select(ConversationParticipant.id).where(ConversationParticipant.conversation_id == conversation_id, ConversationParticipant.member_id.in_(member)))).first()
        if in_room is None:
            raise DesktopRelayError(404, "record_conversation_not_found", "no such conversation")  # the same answer as for a room that does not exist
    size = len(env["ct"])  # the sealed body's text length: a size class, nothing else
    values = dict(kind=env["kind"], rec_gen=rec["rec_gen"], writer=env["from"], epoch=env["epoch"], ctr=env["ctr"], byte_size=size, envelope=env)
    where = (SessionRecord.conversation_id == conversation_id, SessionRecord.owner_id == setup.confirmed_by, SessionRecord.record_id == rec["record_id"])
    for attempt in range(2):
        row = (await db.execute(select(SessionRecord).where(*where).with_for_update().execution_options(populate_existing=True))).scalar_one_or_none()
        if row is None:
            # the limits are counted under a lock of this person's own: two writes at once cannot both see room for one
            await db.execute(text("SELECT pg_advisory_xact_lock(hashtextextended(:k, 0))"), {"k": f"session_records:{setup.confirmed_by}"})
            kept = (await db.execute(select(func.count()).select_from(SessionRecord).where(SessionRecord.setup_id == setup.id, SessionRecord.deleted_at.is_(None)))).scalar_one()
            kept_owner = (await db.execute(select(func.count()).select_from(SessionRecord).where(SessionRecord.owner_id == setup.confirmed_by, SessionRecord.deleted_at.is_(None)))).scalar_one()
            if kept >= MAX_RECORDS_PER_SETUP or kept_owner >= MAX_RECORDS_PER_OWNER:
                raise DesktopRelayError(409, "records_full", "this computer keeps as many records as it may — delete some to make room")
            try:
                async with db.begin_nested():
                    row = SessionRecord(id=uuid.uuid4(), org_id=setup.org_id, setup_id=setup.id, owner_id=setup.confirmed_by, conversation_id=conversation_id, record_id=rec["record_id"], **values)
                    db.add(row)
                    await db.flush()
            except IntegrityError:  # another write of the same id got in between: judge against it
                if attempt == 0:
                    continue
                raise DesktopRelayError(409, "record_exists", "that record id is already used") from None
            await db.refresh(row)
            logger.info("session record kept: setup=%s conversation=%s", setup.id, conversation_id)  # ids only
            return {"id": str(row.id), "seq": row.seq, "replaced": False}
        break
    if row.deleted_at is not None:
        raise DesktopRelayError(409, "record_deleted", "that record was deleted")
    if row.envelope == env:
        return {"id": str(row.id), "seq": row.seq, "replaced": False}
    inside = (await db.execute(select(SessionRecord.id).where(scope_of(setup), SessionRecord.id == row.id))).scalar_one_or_none()
    if inside is None or row.writer != env["from"] or row.kind != env["kind"]:  # a record of another computer is not this one's to replace
        raise DesktopRelayError(409, "record_exists", "that record id is already used")
    if (env["epoch"], env["ctr"]) <= (row.epoch, row.ctr):
        raise DesktopRelayError(409, "record_stale", "a record of that id with a later counter is already kept")
    seq = (await db.execute(text("SELECT nextval(pg_get_serial_sequence('session_records', 'seq'))"))).scalar_one()
    for k, v in values.items():  # never the computer it was written on (its limit) nor its owner
        setattr(row, k, v)
    row.seq = seq
    row.replaced_at = func.now()
    await db.flush()
    logger.info("session record replaced: setup=%s conversation=%s", setup.id, conversation_id)
    return {"id": str(row.id), "seq": seq, "replaced": True}


async def list_records(db: AsyncSession, setup: DesktopSetup, *, conversation_id: uuid.UUID, after: int, limit: int) -> dict:
    """the records of this computer in one conversation after `after` (a `seq`), oldest first — the envelopes exactly as they were kept. `next_after` = the last `seq` given (send it back to go on)."""
    limit = max(1, min(limit, PAGE_MAX))
    rows = (await db.execute(
        select(SessionRecord).where(scope_of(setup), SessionRecord.conversation_id == conversation_id, SessionRecord.seq > after).order_by(SessionRecord.seq).limit(limit)
    )).scalars().all()
    return {
        "records": [
            {"id": str(r.id), "seq": r.seq, "record_id": r.record_id, "kind": r.kind, "rec_gen": r.rec_gen, "created_at": r.created_at.isoformat(), "envelope": r.envelope} for r in rows
        ],
        "next_after": rows[-1].seq if rows else after,
    }


async def delete_records(db: AsyncSession, *, org_id: uuid.UUID, user_id: uuid.UUID, conversation_id: uuid.UUID, record_id: str | None) -> int:
    """the person deletes their own records of one conversation — one record, or all. What goes: the sealed envelope and its size (the row stays as a TOMBSTONE — ids and counters, no content — so a replayed
    envelope cannot bring the record back). Only the person's own (a disconnected computer's too: the history is theirs to remove); another person's or an unknown id deletes nothing and says so the same
    way. → how many went. The caller commits."""
    cond = [SessionRecord.org_id == org_id, SessionRecord.conversation_id == conversation_id, SessionRecord.owner_id == user_id, SessionRecord.deleted_at.is_(None)]
    if record_id is not None:
        cond.append(SessionRecord.record_id == record_id)
    res = await db.execute(update(SessionRecord).where(*cond).values(envelope={}, byte_size=1, deleted_at=func.now()))
    return res.rowcount or 0


async def purge_tombstones(db: AsyncSession, *, limit: int = 10_000) -> int:
    """the minute sweep: a tombstone older than TOMBSTONE_KEEP goes (bounded per run). A tombstone holds no sealed content — only the ids and counters that stop a replayed write; a LIVE record is never touched
    here (no TTL on a person's record). → how many went. The caller commits."""
    old = select(SessionRecord.id).where(SessionRecord.deleted_at.is_not(None), SessionRecord.deleted_at < func.now() - TOMBSTONE_KEEP).limit(limit)
    res = await db.execute(delete(SessionRecord).where(SessionRecord.id.in_(old), SessionRecord.deleted_at.is_not(None)))
    return res.rowcount or 0
