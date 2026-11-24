"""story 4983 (P5 · phone ↔ host project files) — layer 3, the server's part of a files request (a folder LIST, or — P6 — the OPENING of one file): a person's sealed request goes to ONE computer, the computer's sealed
answer comes back, the server holds both unread.

The contract is `contracts/file-browse-vectors.json` of the mobile repository (`envelope`): kind `file_list` or `file_read` (the phone's, header `session_key` = `file:<project id>`, `command_id` = the press's own key)
and kind `file_result` (the computer's, the same `command_id`). The kind of the COMMAND is the kind the envelope's own header says (both are judged by shape, the same limits apply to both, and the two share one
open request per computer and one ask per person per second). The server cannot open either: it sees envelopes — sizes, times, ids — never a name, a path or a word of what a folder holds. What it keeps: one row per request in
`desktop_file_reads`, for at most FILE_TTL (10 minutes from the ask), deleted the moment its person reads it.

  who may ask ......... the person who paired that computer (`may_read` — the same single rule as the changed-files list, never an org role), who can open the PROJECT, with a phone of theirs paired with that computer
  what the command has . {project_id, envelope} — no session, no path (the computer maps the project id to a folder of its own)
  the envelope ........ judged by SHAPE only (`check_envelope`) and by its HEADER (this computer · this project · this press's key · a time near now · a lifetime): a copy of another press's envelope is refused
  limits .............. one open files request per physical computer and one per person per second (the same advisory-lock order as the changed-files list: the machine, then the person), a queued request older
                        than 30 s is rejected and never delivered
  what is logged ...... ids and counts only: never an envelope, never a name
It is built on the helpers of `desktop_changes` (who may, the lock order, the stale rule) and `desktop_commands` (who can open a project, the envelope time rules): not written again here.
"""
from __future__ import annotations

import logging
import uuid
from datetime import datetime, timedelta, timezone

from pydantic import BaseModel, ConfigDict, Field, field_validator
from sqlalchemy import delete, func, select, update
from sqlalchemy.ext.asyncio import AsyncSession

from app.models.desktop_relay import DesktopCommand, DesktopFileChunk, DesktopFileRead
from app.models.desktop_setup import DesktopSetup
from app.services.desktop_changes import OPEN_COMMAND_STATES, lines_of_machine, may_read, take_limit_locks
from app.services.desktop_relay import DesktopRelayError
from app.services.envelope_shape import check_envelope

logger = logging.getLogger(__name__)

FILE_TTL = timedelta(minutes=10)  # contract `envelope.result.ttl_ms`: an answer waits this long to be read, from the ask
PER_PERSON_INTERVAL = timedelta(seconds=1)  # a person taps through folders: one ask a second, not the three seconds of a whole-session read
POLL_INTERVAL = timedelta(milliseconds=500)  # one look at a pending request per half second
ANSWER_BODY_MAX = 400 * 1024  # an answer envelope as JSON text: the sealed body is at most 256 KiB + the tag (≈350 KiB as base64url) + the header — a full-size legal answer passes; over this is refused before it is parsed
ASK_BODY_MAX = 16 * 1024  # a files request as JSON text: the padded frame is at most 4 KiB + the tag (≈5.5 KiB as base64url) + the header — over this is refused before it is parsed
FILE_ASK_KINDS = ("file_list", "file_read", "file_download")  # the kinds of a files request: the envelope's own header says which (story 4983 P6 · story 4988 P8: a download)
CHUNKS_MAX = 57  # contract `download.limits.chunks_max`: ceil(8 MiB / 144 KiB) — a download is at most this many chunks (the migration's CHECKs say the same number)
CHUNKS_AHEAD_MAX = 4  # contract `download.limits.chunks_ahead_max`: the computer may be at most this many chunks ahead of the phone (what the server holds unread, ≈ 1 MiB sealed)
KINDS = (*FILE_ASK_KINDS, "file_result")


def _now() -> datetime:
    return datetime.now(timezone.utc)


def session_key_of(project_id: uuid.UUID | str) -> str:
    """the header `session_key` of a files envelope (contract: `file:<project id>`)"""
    return f"file:{project_id}"


# ── ① a person asks ───────────────────────────────────────────────────────────────────────────────────────────────────────


class ListRequest(BaseModel):
    """What a person's phone posts for a folder list: the press's own key, the phone's key id (the signature is inside the envelope, not beside it) and the SEALED request — nothing readable."""
    model_config = ConfigDict(extra="forbid")

    project_id: uuid.UUID
    idempotency_key: str = Field(min_length=1, max_length=100)
    phone_key_id: uuid.UUID
    envelope: dict

    @field_validator("envelope")
    @classmethod
    def _shape(cls, env: dict) -> dict:
        try:
            kind = env.get("kind") if isinstance(env, dict) else None
            return check_envelope(env, kind=kind if kind in FILE_ASK_KINDS else "file_list")  # a kind that is not a files request is refused by the shape check below (never echoed)
        except ValueError as exc:  # our own message names no field of the caller's
            raise ValueError(str(exc)) from None


def parse_ask(raw: bytes) -> ListRequest:
    """the body of a person's ask, judged by size BEFORE it is parsed and without ever putting what it holds into an error"""
    from pydantic import ValidationError

    if len(raw) > ASK_BODY_MAX:
        raise DesktopRelayError(413, "files_request_too_large", "the request is larger than the server takes")
    try:
        return ListRequest.model_validate_json(raw)
    except ValidationError as exc:
        raise DesktopRelayError(422, "invalid_files_request", exc.errors(include_url=False, include_input=False, include_context=False)[0]["msg"]) from exc


def _fresh(env: dict, now_ms: int) -> bool:
    """a time near now, a lifetime no longer than the longest an envelope may have, and not already over (the one rule for a request and for an answer)"""
    from app.services.desktop_commands import ENVELOPE_LIFETIME_MAX_MS, ENVELOPE_TS_SKEW_MS

    return abs(env["ts"] - now_ms) <= ENVELOPE_TS_SKEW_MS and env["ts"] <= env["expires_at"] <= env["ts"] + ENVELOPE_LIFETIME_MAX_MS and env["expires_at"] > now_ms


def _check_header(env: dict, *, setup: DesktopSetup, project_id: uuid.UUID, key: str) -> None:
    """the header the phone sealed must be about THIS press: this computer · this project · this press's own key · a time near now · a lifetime (the server cannot read the body, but it can see that it is not a copy of another's)"""
    now_ms = int(_now().timestamp() * 1000)
    if env["setup_id"] != str(setup.id) or env["session_key"] != session_key_of(project_id) or env["command_id"] != key or not _fresh(env, now_ms):
        raise DesktopRelayError(422, "envelope_header_mismatch", "the envelope's header is not this press's")


async def create_ask(db: AsyncSession, *, member_id: uuid.UUID, user_id: uuid.UUID, org_id: uuid.UUID, setup_id: uuid.UUID, body: ListRequest) -> tuple[uuid.UUID, datetime]:
    """→ (the command's id, when the answer's wait ends). The command's kind is the envelope's (`file_list` · `file_read`). The same press key again gives back the first command. The caller commits."""
    from app.services import remote_control
    from app.services.agent_permissions import _reachable, paired_phone
    from app.services.desktop_commands import org_role
    from app.services.desktop_relay import enqueue_command
    from app.services.project_auth import require_project_access

    setup = (await db.execute(select(DesktopSetup).where(DesktopSetup.id == setup_id, DesktopSetup.org_id == org_id))).scalar_one_or_none()
    denied = DesktopRelayError(403, "not_allowed_to_read_files", "only the person who paired this computer can look at its files")
    if setup is None or not may_read(setup, user_id) or await org_role(db, org_id, user_id) is None:
        raise denied  # one answer for «no such computer» and «not yours»
    await require_project_access(db, user_id, body.project_id, org_id, not_found_detail={"code": "project_not_found", "message": "no such project"})  # the one judge of project access (404, never «forbidden»)
    kind = body.envelope["kind"]
    # the press again (the same key): the first command comes back, whatever the computer or the switch say now — a second command would put the question to the computer twice
    existing = (await db.execute(
        select(DesktopCommand).where(DesktopCommand.setup_id == setup.id, DesktopCommand.idempotency_key == f"files:{member_id}:{body.idempotency_key}")
    )).scalar_one_or_none()
    if existing is not None:
        if existing.kind != kind:  # one press, one question: the same key for another kind is a mistake, not a repeat
            raise DesktopRelayError(409, "files_key_reused", "that press key was used for another kind of request")
        row = (await db.execute(select(DesktopFileRead).where(DesktopFileRead.command_id == existing.id, DesktopFileRead.viewer_id == user_id))).scalar_one_or_none()
        if row is None or row.expires_at <= _now():
            raise DesktopRelayError(404, "files_read_not_found", "no such request")
        return existing.id, row.expires_at
    _check_header(body.envelope, setup=setup, project_id=body.project_id, key=body.idempotency_key)
    if not await remote_control.is_enabled(db, org_id):
        raise DesktopRelayError(409, remote_control.OFF_CODE, "remote control is off for this organization")
    now = _now()
    if setup.id not in await _reachable(db, {setup.id}, now):
        raise DesktopRelayError(409, "device_unreachable", "that computer has not been heard from")
    if await paired_phone(db, member_id=member_id, phone_id=body.phone_key_id, setup_id=setup.id) is None:
        raise DesktopRelayError(409, "phone_not_paired", "this phone is not paired with that computer")
    # the computer's row is locked, then who may is asked AGAIN under the lock (a disconnect or a re-pairing that committed in between), then the limits are counted under the two advisory locks in ONE order
    locked = (await db.execute(select(DesktopSetup).where(DesktopSetup.id == setup.id).with_for_update().execution_options(populate_existing=True))).scalar_one_or_none()
    if not may_read(locked, user_id):
        raise denied
    # the phone's pairing is asked AGAIN and HELD (a share lock until the commit): a pairing removal or a key revocation that comes meanwhile waits for this ask (the clock's rule, story #4733)
    if await paired_phone(db, member_id=member_id, phone_id=body.phone_key_id, setup_id=setup.id, lock=True) is None:
        raise DesktopRelayError(409, "phone_not_paired", "this phone is not paired with that computer")
    await purge_expired(db, now=now)
    await take_limit_locks(db, setup, user_id, road="files")
    last = (await db.execute(select(func.max(DesktopCommand.created_at)).where(DesktopCommand.kind.in_(FILE_ASK_KINDS), DesktopCommand.requested_by == member_id))).scalar_one()
    if last is not None and now - last < PER_PERSON_INTERVAL:
        raise DesktopRelayError(429, "files_too_fast", "wait a moment before asking again", detail={"retry_after": 1})
    lines = lines_of_machine(setup)
    # story 4988: a person's earlier DOWNLOAD that ENDED with chunks nobody read (the phone was closed meanwhile) is replaced by this ask — what the server keeps for a person who asks again and again is one such leftover, never ten minutes of
    # unread chunks per press. (A download that is still open is not touched: the computer's own slot below says «busy».)
    ended = select(DesktopCommand.id).where(DesktopCommand.kind == "file_download", DesktopCommand.state.in_(("done", "failed", "rejected")))
    await db.execute(delete(DesktopFileRead).where(DesktopFileRead.setup_id.in_(lines), DesktopFileRead.viewer_id == user_id, DesktopFileRead.command_id.in_(ended)))
    busy = (await db.execute(
        select(func.count()).select_from(DesktopFileRead).join(DesktopCommand, DesktopCommand.id == DesktopFileRead.command_id)
        .where(DesktopFileRead.setup_id.in_(lines), DesktopFileRead.payload.is_(None), DesktopCommand.state.in_(OPEN_COMMAND_STATES))
    )).scalar_one()
    if busy:
        raise DesktopRelayError(409, "files_busy", "that computer is already looking at its files")
    cmd = await enqueue_command(
        db, setup=setup, kind=kind, payload={"project_id": str(body.project_id), "envelope": body.envelope},
        idempotency_key=f"files:{member_id}:{body.idempotency_key}", requested_by=member_id,
    )
    expires_at = now + FILE_TTL
    db.add(DesktopFileRead(command_id=cmd.id, setup_id=setup.id, viewer_id=user_id, project_id=body.project_id, press_key=body.idempotency_key, expires_at=expires_at))
    await db.flush()
    logger.info("desktop files asked: viewer=%s setup=%s command=%s", user_id, setup.id, cmd.id)  # ids only
    return cmd.id, expires_at


# ── ② the computer answers ────────────────────────────────────────────────────────────────────────────────────────────────


class Answer(BaseModel):
    """the computer's PUT body: the sealed answer, nothing else"""
    model_config = ConfigDict(extra="forbid")

    envelope: dict

    @field_validator("envelope")
    @classmethod
    def _shape(cls, env: dict) -> dict:
        try:
            return check_envelope(env, kind="file_result")
        except ValueError as exc:
            raise ValueError(str(exc)) from None


def parse_answer(raw: bytes) -> Answer:
    """the body of a computer's answer, judged without ever putting what it holds into an error"""
    from pydantic import ValidationError

    if len(raw) > ANSWER_BODY_MAX:
        raise DesktopRelayError(413, "files_too_large", "the answer is larger than the server takes")
    try:
        return Answer.model_validate_json(raw)
    except ValidationError as exc:
        raise DesktopRelayError(422, "invalid_files_answer", exc.errors(include_url=False, include_input=False, include_context=False)[0]["msg"]) from exc


async def write_answer(db: AsyncSession, setup: DesktopSetup, command_id: uuid.UUID, raw: bytes) -> int:
    """The computer's sealed answer for one request — written ONCE, only into a row of THIS computer whose command is still open and whose viewer still pairs it, and only if its header is about THIS
    request (this computer · this project · the press's own key). → the envelope's size in bytes (a size class, nothing else)."""
    answer = parse_answer(raw)
    env = answer.envelope
    # the ONE lock order of the changed-files list: the command row first, then the read row
    cmd = (await db.execute(
        select(DesktopCommand).where(DesktopCommand.id == command_id, DesktopCommand.setup_id == setup.id, DesktopCommand.kind.in_(FILE_ASK_KINDS)).with_for_update()
    )).scalar_one_or_none()
    await purge_expired(db)
    row = (await db.execute(
        select(DesktopFileRead).where(DesktopFileRead.command_id == command_id, DesktopFileRead.setup_id == setup.id).with_for_update()
    )).scalar_one_or_none()
    if row is None or cmd is None:
        raise DesktopRelayError(404, "files_read_not_found", "no such request on this device")
    if cmd.kind == "file_download":  # a download is answered in chunks (`write_chunk`): the one-answer road is not its road
        raise DesktopRelayError(409, "files_use_chunks", "a download is answered in chunks")
    if row.expires_at <= _now():
        await db.execute(delete(DesktopFileRead).where(DesktopFileRead.command_id == command_id))
        raise DesktopRelayError(404, "files_read_not_found", "no such request on this device")
    if row.payload is not None:
        raise DesktopRelayError(409, "files_already_answered", "this request has its answer already")
    if not may_read(setup, row.viewer_id):
        await db.execute(delete(DesktopFileRead).where(DesktopFileRead.command_id == command_id))
        raise DesktopRelayError(409, "files_viewer_gone", "the person who asked no longer pairs this computer")
    if cmd.state not in ("delivered", "acked"):
        raise DesktopRelayError(409, "files_command_closed", "that command is not open")
    now_ms = int(_now().timestamp() * 1000)
    if env["setup_id"] != str(setup.id) or env["session_key"] != session_key_of(row.project_id) or env["command_id"] != row.press_key or not _fresh(env, now_ms):
        raise DesktopRelayError(422, "envelope_header_mismatch", "the envelope's header is not this request's")
    row.payload, row.written_at = {"envelope": env}, _now()
    await db.flush()
    return len(raw)


# ── ③ the person reads ────────────────────────────────────────────────────────────────────────────────────────────────────


async def read_answer(db: AsyncSession, *, user_id: uuid.UUID, org_id: uuid.UUID, setup_id: uuid.UUID, command_id: uuid.UUID) -> dict:
    """The sealed answer (once) or where the request stands. A row that is not THIS person's, not of THIS computer, expired or already read is «not found» — one answer for every reason. Reading deletes
    the row in the same statement that returns it. The caller commits."""
    from app.services import remote_control
    from app.services.desktop_commands import org_role
    from app.services.project_auth import has_project_access

    not_found = DesktopRelayError(404, "files_read_not_found", "no such request")
    now = _now()
    row = (await db.execute(select(DesktopFileRead).where(DesktopFileRead.command_id == command_id, DesktopFileRead.viewer_id == user_id, DesktopFileRead.setup_id == setup_id))).scalar_one_or_none()
    if row is None:
        raise not_found
    if row.expires_at <= now:
        await db.execute(delete(DesktopFileRead).where(DesktopFileRead.command_id == command_id))
        raise not_found
    if row.polled_at is not None and now - row.polled_at < POLL_INTERVAL:  # before any lock: a tight poll costs the person a 429, not the computer's command row a queue
        raise DesktopRelayError(429, "files_polled_too_fast", "ask again in a moment", detail={"retry_after": 1})
    cmd = (await db.execute(select(DesktopCommand).where(DesktopCommand.id == command_id, DesktopCommand.setup_id == setup_id, DesktopCommand.kind.in_(FILE_ASK_KINDS)).with_for_update())).scalar_one_or_none()
    setup = (await db.execute(select(DesktopSetup).where(DesktopSetup.id == setup_id, DesktopSetup.org_id == org_id))).scalar_one_or_none()
    if cmd is None or setup is None or cmd.kind == "file_download":  # (a download is read chunk by chunk: `read_chunk`)
        raise not_found
    row = (await db.execute(  # the row afresh, under the command's lock (the gap is judged again: two looks that arrived together cannot both pass it)
        select(DesktopFileRead).where(DesktopFileRead.command_id == command_id).with_for_update().execution_options(populate_existing=True)
    )).scalar_one_or_none()
    if row is None:
        raise not_found
    now = _now()  # read again: the look may have waited for the lock
    if row.expires_at <= now:  # …past the row's end: judged again
        await db.execute(delete(DesktopFileRead).where(DesktopFileRead.command_id == command_id))
        raise not_found
    if row.polled_at is not None and now - row.polled_at < POLL_INTERVAL:
        raise DesktopRelayError(429, "files_polled_too_fast", "ask again in a moment", detail={"retry_after": 1})
    # the answer is of a PROJECT's folder: whoever lost the project since the ask gets nothing (and the row goes)
    if not (may_read(setup, user_id) and await org_role(db, org_id, user_id) is not None and await remote_control.is_enabled(db, org_id)
            and await has_project_access(db, user_id, row.project_id, org_id)):
        await db.execute(delete(DesktopFileRead).where(DesktopFileRead.command_id == command_id))  # the pairing, the line or the seat is gone since the ask: nothing stays
        raise not_found
    if row.payload is None:
        if cmd.state in ("done", "failed", "rejected"):  # the computer ended without an answer: that is the answer (its closed code), and the row has nothing left to hold
            await db.execute(delete(DesktopFileRead).where(DesktopFileRead.command_id == command_id))
        else:
            await db.execute(update(DesktopFileRead).where(DesktopFileRead.command_id == command_id).values(polled_at=now))
        return {"state": cmd.state, "code": cmd.result_code, "envelope": None}
    if cmd.state not in ("delivered", "acked", "done"):
        await db.execute(delete(DesktopFileRead).where(DesktopFileRead.command_id == command_id))
        return {"state": cmd.state, "code": cmd.result_code, "envelope": None}
    taken = (await db.execute(
        delete(DesktopFileRead).where(DesktopFileRead.command_id == command_id, DesktopFileRead.viewer_id == user_id, DesktopFileRead.payload.is_not(None)).returning(DesktopFileRead.payload)
    )).scalar_one_or_none()
    if taken is None:
        raise not_found
    logger.info("desktop files read: viewer=%s setup=%s command=%s", user_id, setup.id, command_id)  # ids only
    return {"state": "done", "code": cmd.result_code, "envelope": taken["envelope"]}


# ── ④ a download: the computer's chunks, the person's reading of them ───────────────────────────────────────────────────────────────────────────────────────────────────


async def write_chunk(db: AsyncSession, setup: DesktopSetup, command_id: uuid.UUID, i: int, raw: bytes) -> int:
    """One SEALED chunk of a download (the contract's `download`): put by the computer into the request's row of THIS computer, IN ORDER (chunk i only when i chunks are already there) and never more than CHUNKS_AHEAD_MAX ahead of
    what the phone has read (`files_chunks_ahead`: the computer waits and puts it again). Judged as an answer is — by shape and by its header (this computer · this project · the press's own key · a time near now) — and never read.
    → the envelope's size in bytes (a size class, nothing else)."""
    answer = parse_answer(raw)
    env = answer.envelope
    cmd = (await db.execute(
        select(DesktopCommand).where(DesktopCommand.id == command_id, DesktopCommand.setup_id == setup.id, DesktopCommand.kind == "file_download").with_for_update()
    )).scalar_one_or_none()
    await purge_expired(db)
    row = (await db.execute(
        select(DesktopFileRead).where(DesktopFileRead.command_id == command_id, DesktopFileRead.setup_id == setup.id).with_for_update()
    )).scalar_one_or_none()
    if row is None or cmd is None:
        raise DesktopRelayError(404, "files_read_not_found", "no such request on this device")
    if row.expires_at <= _now():
        await db.execute(delete(DesktopFileRead).where(DesktopFileRead.command_id == command_id))
        raise DesktopRelayError(404, "files_read_not_found", "no such request on this device")
    if not may_read(setup, row.viewer_id):
        await db.execute(delete(DesktopFileRead).where(DesktopFileRead.command_id == command_id))
        raise DesktopRelayError(409, "files_viewer_gone", "the person who asked no longer pairs this computer")
    if cmd.state not in ("delivered", "acked"):
        raise DesktopRelayError(409, "files_command_closed", "that command is not open")
    now_ms = int(_now().timestamp() * 1000)
    if env["setup_id"] != str(setup.id) or env["session_key"] != session_key_of(row.project_id) or env["command_id"] != row.press_key or not _fresh(env, now_ms):
        raise DesktopRelayError(422, "envelope_header_mismatch", "the envelope's header is not this request's")
    if i != row.chunks_written:
        raise DesktopRelayError(409, "files_chunk_out_of_order", "chunks are put in order, once each")
    if row.chunks_written - row.chunks_read >= CHUNKS_AHEAD_MAX:
        raise DesktopRelayError(409, "files_chunks_ahead", "the phone has not read the chunks already here", detail={"retry_after": 1})
    db.add(DesktopFileChunk(command_id=command_id, i=i, payload={"envelope": env}))
    row.chunks_written += 1
    await db.flush()
    return len(raw)


async def _has_live_phone(db: AsyncSession, member_id: uuid.UUID, setup_id: uuid.UUID) -> bool:
    """Does this person have a LIVE phone paired with this computer? The phone's key and the pairing rows are held with a SHARE LOCK until the transaction ends (the same lock `paired_phone(lock=True)` takes for an ask): a pairing removal (which locks the
    pairing row FOR UPDATE) or a key revocation that is on its way waits for this read — or has committed before it, and then this finds nothing — so a chunk is never handed over after a pairing that was removed has committed."""
    from app.models.agent_permission import RemoteDevice, RemoteDevicePairing

    stmt = (
        select(RemoteDevice.id).join(RemoteDevicePairing, RemoteDevicePairing.remote_device_id == RemoteDevice.id)
        .where(RemoteDevicePairing.setup_id == setup_id, RemoteDevicePairing.removed_at.is_(None), RemoteDevice.revoked_at.is_(None), RemoteDevice.member_id == member_id)
        .limit(1).with_for_update(read=True, of=(RemoteDevice, RemoteDevicePairing))
    )
    return (await db.execute(stmt)).first() is not None


async def read_chunk(db: AsyncSession, *, user_id: uuid.UUID, member_id: uuid.UUID, org_id: uuid.UUID, setup_id: uuid.UUID, command_id: uuid.UUID, i: int) -> dict:
    """Chunk `i` of a download (the person's), IN ORDER: once. Reading deletes the chunk in the same statement that returns it. Not there yet: where the request stands (the person asks again); the request ended and the chunk never came:
    that is the answer (the phone's `incomplete`) and the row goes. A row that is not THIS person's · not of THIS computer · expired · not a download · a person who lost the pairing, the seat or the project: «not found» — one answer for every reason."""
    from app.services import remote_control
    from app.services.desktop_commands import org_role
    from app.services.project_auth import has_project_access

    not_found = DesktopRelayError(404, "files_read_not_found", "no such request")
    now = _now()  # (the place `i` is bounded by the route's own path rule — 0 … CHUNKS_MAX-1 — and by the table's CHECK: no third check here)
    row = (await db.execute(select(DesktopFileRead).where(DesktopFileRead.command_id == command_id, DesktopFileRead.viewer_id == user_id, DesktopFileRead.setup_id == setup_id))).scalar_one_or_none()
    if row is None:
        raise not_found
    cmd = (await db.execute(select(DesktopCommand).where(DesktopCommand.id == command_id, DesktopCommand.setup_id == setup_id, DesktopCommand.kind == "file_download").with_for_update())).scalar_one_or_none()
    setup = (await db.execute(select(DesktopSetup).where(DesktopSetup.id == setup_id, DesktopSetup.org_id == org_id))).scalar_one_or_none()
    if cmd is None or setup is None:
        raise not_found
    row = (await db.execute(
        select(DesktopFileRead).where(DesktopFileRead.command_id == command_id).with_for_update().execution_options(populate_existing=True)
    )).scalar_one_or_none()
    if row is None:
        raise not_found
    now = _now()
    if row.expires_at <= now:
        await db.execute(delete(DesktopFileRead).where(DesktopFileRead.command_id == command_id))
        raise not_found
    # the person must still have a LIVE PHONE paired with this computer (a chunk is sealed to a phone's key: a pairing that was removed since the ask leaves nobody to read it) as well as the computer's pairing, their seat, remote control and the project
    if not (may_read(setup, user_id) and await _has_live_phone(db, member_id, setup_id) and await org_role(db, org_id, user_id) is not None and await remote_control.is_enabled(db, org_id)
            and await has_project_access(db, user_id, row.project_id, org_id)):
        await db.execute(delete(DesktopFileRead).where(DesktopFileRead.command_id == command_id))  # the pairing, the phone, the line or the seat is gone since the ask: nothing stays
        raise not_found
    if i != row.chunks_read:
        raise DesktopRelayError(409, "files_chunk_out_of_order", "chunks are read in order, once each")
    taken = (await db.execute(
        delete(DesktopFileChunk).where(DesktopFileChunk.command_id == command_id, DesktopFileChunk.i == i).returning(DesktopFileChunk.payload)
    )).scalar_one_or_none()
    if taken is not None:
        row.chunks_read += 1
        await db.flush()
        logger.info("desktop files chunk read: viewer=%s setup=%s command=%s i=%s", user_id, setup.id, command_id, i)  # ids only
        return {"state": "ready", "code": cmd.result_code, "envelope": taken["envelope"]}
    if cmd.state in ("done", "failed", "rejected"):  # the computer ended and chunk i never came: that is the answer, and the row has nothing left to hold
        await db.execute(delete(DesktopFileRead).where(DesktopFileRead.command_id == command_id))
        return {"state": cmd.state, "code": cmd.result_code, "envelope": None}
    if row.polled_at is not None and now - row.polled_at < POLL_INTERVAL:  # (a look that finds nothing costs the person a 429; a look that finds a chunk never does)
        raise DesktopRelayError(429, "files_polled_too_fast", "ask again in a moment", detail={"retry_after": 1})
    await db.execute(update(DesktopFileRead).where(DesktopFileRead.command_id == command_id).values(polled_at=now))
    return {"state": cmd.state, "code": cmd.result_code, "envelope": None}


async def finish_download(db: AsyncSession, *, user_id: uuid.UUID, setup_id: uuid.UUID, command_id: uuid.UUID) -> bool:
    """The person is done with a request (the last chunk was read) or gives it up: its row and every chunk still in it go NOW (the chunks by the foreign key). Only the asker's own row; any other id deletes nothing. → whether a row went. The caller commits."""
    gone = (await db.execute(
        delete(DesktopFileRead).where(
            DesktopFileRead.command_id == command_id, DesktopFileRead.viewer_id == user_id, DesktopFileRead.setup_id == setup_id,
            DesktopFileRead.command_id.in_(select(DesktopCommand.id).where(DesktopCommand.kind == "file_download")),  # (a list's or an open's answer is not this route's to delete)
        ).returning(DesktopFileRead.command_id)
    )).scalar_one_or_none()
    return gone is not None


# ── the queue's own ───────────────────────────────────────────────────────────────────────────────────────────────────────


async def purge_expired(db: AsyncSession, *, now: datetime | None = None) -> int:
    """Every row past its end goes (the cron's job, and every new ask's and every answer's first step). A row someone else holds is skipped, never waited for: the lock order is «command row, then read row»."""
    ids = list((await db.execute(select(DesktopFileRead.command_id).where(DesktopFileRead.expires_at <= (now or _now())).with_for_update(skip_locked=True))).scalars().all())
    if ids:
        await db.execute(delete(DesktopFileRead).where(DesktopFileRead.command_id.in_(ids)))
    return len(ids)


async def forget(db: AsyncSession, setup_ids: list[uuid.UUID], *, lock: bool = True) -> None:
    """The computers' requests go (a disconnect · an account's closure · a replaced line · remote control turned off): no answer stays for a computer that cannot be reached. The same lock rule as the changed-files list."""
    if setup_ids:
        if lock:
            await db.execute(select(DesktopSetup.id).where(DesktopSetup.id.in_(setup_ids)).order_by(DesktopSetup.id).with_for_update())
        await db.execute(delete(DesktopFileRead).where(DesktopFileRead.setup_id.in_(setup_ids)))
