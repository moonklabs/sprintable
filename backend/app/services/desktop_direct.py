"""story 4993 (P2 · same-network direct) — the server's part of an ASK FOR A DIRECT DOOR: a paired phone's sealed ask goes to ONE computer, the computer's sealed answer (an offer with an address, a port and a one-time ticket — or a closed refusal) comes
back, the server holds both unread.

The contract is `contracts/direct-negotiation.json` (the same bytes as the mobile repository's): kind `direct_open` (the phone's, header `session_key` = `direct`, `command_id` = the press's own key) and kind `direct_offer` (the computer's, the same
`command_id`). The server cannot open either: it sees envelopes — sizes, times, ids — never an address, a port, a ticket or a key. What it keeps: one row per ask in `desktop_direct_asks`, for at most DIRECT_TTL (60 seconds from the ask — the door itself
lives 20), deleted the moment its person reads it. This is the files road (`desktop_files`) with the project taken out: the same rules, the same locks, the same «not found for every reason».

  who may ask ......... the person who paired that computer (`may_read` — never an org role), with a phone of theirs paired with it
  what the command has . {envelope} — no session, no address
  the envelope ........ judged by SHAPE only (`check_envelope`) and by its HEADER (this computer · this press's key · a time within 30 seconds of now · a lifetime): a copy of another press's envelope is refused
  limits .............. one ask per person per second · one waiting ask per person · a queued ask older than 30 s is rejected and never delivered (the door rules on the computer's side — a few asks a minute per phone, one window per phone —
                        are the computer's own)
  what is logged ...... ids and counts only: never an envelope
It is built on the helpers of `desktop_changes` (who may, the lock order, the stale rule) and `desktop_files` (the same answer reading rules): not written again here.
"""
from __future__ import annotations

import logging
import uuid
from datetime import datetime, timedelta, timezone

from pydantic import BaseModel, ConfigDict, Field, field_validator
from sqlalchemy import delete, func, select, update
from sqlalchemy.dialects.postgresql import insert as pg_insert
from sqlalchemy.ext.asyncio import AsyncSession

from app.models.desktop_relay import DesktopCommand, DesktopDirectAsk, DesktopDirectCount
from app.models.desktop_setup import DesktopSetup
from app.services.desktop_changes import OPEN_COMMAND_STATES, may_read, take_limit_locks
from app.services.desktop_relay import DesktopRelayError
from app.services.envelope_shape import check_envelope

logger = logging.getLogger(__name__)

DIRECT_TTL = timedelta(seconds=60)  # an answer waits this long to be read, from the ask: the computer's door lives 20 seconds — a later answer is a dead one
PER_PERSON_INTERVAL = timedelta(seconds=1)  # one ask a second per person
POLL_INTERVAL = timedelta(milliseconds=500)  # one look at a pending ask per half second
ASK_SKEW_MS = 30_000  # the ask's own time (inside the signed envelope) must be within this of now — the same 30 s the computer's door judges
ANSWER_BODY_MAX = 8 * 1024  # an answer envelope as JSON text: the sealed body is at most 1 KiB + the tag (≈1.4 KiB as base64url) + the header and its wraps — over this is refused before it is parsed
ASK_BODY_MAX = 8 * 1024  # an ask as JSON text: the same
DIRECT_SESSION_KEY = "direct"  # the header `session_key` of both kinds (contract `constants.session_key`)
ASK_KIND = "direct_open"
ANSWER_KIND = "direct_offer"


def _now() -> datetime:
    return datetime.now(timezone.utc)


# ── ① a person asks ───────────────────────────────────────────────────────────────────────────────────────────────────────


class OpenRequest(BaseModel):
    """What a person's phone posts for a door: the press's own key, the phone's key id (the signature is inside the envelope, not beside it) and the SEALED ask — nothing readable."""
    model_config = ConfigDict(extra="forbid")

    idempotency_key: str = Field(min_length=1, max_length=100)
    phone_key_id: uuid.UUID
    envelope: dict

    @field_validator("envelope")
    @classmethod
    def _shape(cls, env: dict) -> dict:
        try:
            return check_envelope(env, kind=ASK_KIND)
        except ValueError as exc:  # our own message names no field of the caller's
            raise ValueError(str(exc)) from None


def parse_ask(raw: bytes) -> OpenRequest:
    """the body of a person's ask, judged by size BEFORE it is parsed and without ever putting what it holds into an error"""
    from pydantic import ValidationError

    if len(raw) > ASK_BODY_MAX:
        raise DesktopRelayError(413, "direct_request_too_large", "the request is larger than the server takes")
    try:
        return OpenRequest.model_validate_json(raw)
    except ValidationError as exc:
        raise DesktopRelayError(422, "invalid_direct_request", exc.errors(include_url=False, include_input=False, include_context=False)[0]["msg"]) from exc


def _lifetime_ok(env: dict, now_ms: int) -> bool:
    from app.services.desktop_commands import ENVELOPE_LIFETIME_MAX_MS

    return env["ts"] <= env["expires_at"] <= env["ts"] + ENVELOPE_LIFETIME_MAX_MS and env["expires_at"] > now_ms


def _fresh_ask(env: dict, now_ms: int) -> bool:
    """the ask's own time is within 30 s of now (a door is asked for NOW: an older ask is a replay of a moment that has passed), a lifetime no longer than the longest an envelope may have, and not already over"""
    return abs(env["ts"] - now_ms) <= ASK_SKEW_MS and _lifetime_ok(env, now_ms)


def _fresh_answer(env: dict, now_ms: int) -> bool:
    from app.services.desktop_commands import ENVELOPE_TS_SKEW_MS

    return abs(env["ts"] - now_ms) <= ENVELOPE_TS_SKEW_MS and _lifetime_ok(env, now_ms)


async def _first_of_the_press(db: AsyncSession, setup: DesktopSetup, key: str, user_id: uuid.UUID) -> tuple[uuid.UUID, datetime] | None:
    """→ (the first command's id, when its answer's wait ends) when this press key has been asked already, else None"""
    existing = (await db.execute(select(DesktopCommand).where(DesktopCommand.setup_id == setup.id, DesktopCommand.idempotency_key == key))).scalar_one_or_none()
    if existing is None:
        return None
    if existing.kind != ASK_KIND:  # one press, one question: the same key for another kind is a mistake, not a repeat
        raise DesktopRelayError(409, "direct_key_reused", "that press key was used for another kind of request")
    row = (await db.execute(select(DesktopDirectAsk).where(DesktopDirectAsk.command_id == existing.id, DesktopDirectAsk.viewer_id == user_id))).scalar_one_or_none()
    if row is None or row.expires_at <= _now():
        raise DesktopRelayError(404, "direct_ask_not_found", "no such ask")
    return existing.id, row.expires_at


async def create_ask(db: AsyncSession, *, member_id: uuid.UUID, user_id: uuid.UUID, org_id: uuid.UUID, setup_id: uuid.UUID, body: OpenRequest) -> tuple[uuid.UUID, datetime]:
    """→ (the command's id, when the answer's wait ends). The same press key again gives back the first command. The caller commits."""
    from app.services import remote_control
    from app.services.agent_permissions import _reachable, paired_phone
    from app.services.desktop_commands import org_role
    from app.services.desktop_relay import enqueue_command

    setup = (await db.execute(select(DesktopSetup).where(DesktopSetup.id == setup_id, DesktopSetup.org_id == org_id))).scalar_one_or_none()
    denied = DesktopRelayError(403, "not_allowed_to_open_direct", "only the person who paired this computer can ask for a direct connection to it")
    if setup is None or not may_read(setup, user_id) or await org_role(db, org_id, user_id) is None:
        raise denied  # one answer for «no such computer» and «not yours»
    key = f"direct:{member_id}:{body.idempotency_key}"
    # the press again (the same key): the first command comes back, whatever the computer or the switch say now — a second command would put the question to the computer twice. It is asked AGAIN under the limit locks below: two
    # presses of the same key that arrive together both miss the first look, and the second one must get the first one's answer, not a «too fast»
    again = await _first_of_the_press(db, setup, key, user_id)
    if again is not None:
        return again
    env = body.envelope
    now_ms = int(_now().timestamp() * 1000)
    if env["setup_id"] != str(setup.id) or env["session_key"] != DIRECT_SESSION_KEY or env["command_id"] != body.idempotency_key or not _fresh_ask(env, now_ms):
        raise DesktopRelayError(422, "envelope_header_mismatch", "the envelope's header is not this press's")
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
    await take_limit_locks(db, setup, user_id, road="direct")
    again = await _first_of_the_press(db, setup, key, user_id)
    if again is not None:
        return again
    last = (await db.execute(select(func.max(DesktopCommand.created_at)).where(DesktopCommand.kind == ASK_KIND, DesktopCommand.requested_by == member_id))).scalar_one()
    if last is not None and now - last < PER_PERSON_INTERVAL:
        raise DesktopRelayError(429, "direct_too_fast", "wait a moment before asking again", detail={"retry_after": 1})
    waiting = (await db.execute(
        select(func.count()).select_from(DesktopDirectAsk).join(DesktopCommand, DesktopCommand.id == DesktopDirectAsk.command_id)
        .where(DesktopDirectAsk.viewer_id == user_id, DesktopDirectAsk.payload.is_(None), DesktopDirectAsk.expires_at > now, DesktopCommand.state.in_(OPEN_COMMAND_STATES))
    )).scalar_one()
    if waiting:
        raise DesktopRelayError(409, "direct_busy", "an ask of yours is still waiting")
    cmd = await enqueue_command(db, setup=setup, kind=ASK_KIND, payload={"envelope": env}, idempotency_key=key, requested_by=member_id)
    expires_at = now + DIRECT_TTL
    db.add(DesktopDirectAsk(command_id=cmd.id, setup_id=setup.id, viewer_id=user_id, press_key=body.idempotency_key, expires_at=expires_at))
    await db.flush()
    logger.info("desktop direct asked: viewer=%s setup=%s command=%s", user_id, setup.id, cmd.id)  # ids only
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
            return check_envelope(env, kind=ANSWER_KIND)
        except ValueError as exc:
            raise ValueError(str(exc)) from None


def parse_answer(raw: bytes) -> Answer:
    """the body of a computer's answer, judged without ever putting what it holds into an error"""
    from pydantic import ValidationError

    if len(raw) > ANSWER_BODY_MAX:
        raise DesktopRelayError(413, "direct_too_large", "the answer is larger than the server takes")
    try:
        return Answer.model_validate_json(raw)
    except ValidationError as exc:
        raise DesktopRelayError(422, "invalid_direct_answer", exc.errors(include_url=False, include_input=False, include_context=False)[0]["msg"]) from exc


async def write_answer(db: AsyncSession, setup: DesktopSetup, command_id: uuid.UUID, raw: bytes) -> int:
    """The computer's sealed answer for one ask — written ONCE, only into a row of THIS computer whose command is still open and whose viewer still pairs it, and only if its header is about THIS ask (this computer · the press's own key). → the
    envelope's size in bytes (a size class, nothing else)."""
    answer = parse_answer(raw)
    env = answer.envelope
    # the ONE lock order of the files road: the command row first, then the ask row
    cmd = (await db.execute(
        select(DesktopCommand).where(DesktopCommand.id == command_id, DesktopCommand.setup_id == setup.id, DesktopCommand.kind == ASK_KIND).with_for_update()
    )).scalar_one_or_none()
    await purge_expired(db)
    row = (await db.execute(
        select(DesktopDirectAsk).where(DesktopDirectAsk.command_id == command_id, DesktopDirectAsk.setup_id == setup.id).with_for_update()
    )).scalar_one_or_none()
    if row is None or cmd is None:
        raise DesktopRelayError(404, "direct_ask_not_found", "no such ask on this device")
    if row.expires_at <= _now():
        await db.execute(delete(DesktopDirectAsk).where(DesktopDirectAsk.command_id == command_id))
        raise DesktopRelayError(404, "direct_ask_not_found", "no such ask on this device")
    if row.payload is not None:
        raise DesktopRelayError(409, "direct_already_answered", "this ask has its answer already")
    setup = (await db.execute(select(DesktopSetup).where(DesktopSetup.id == setup.id).execution_options(populate_existing=True))).scalar_one()  # the pairing as it stands NOW, not as the device's sign-in loaded it a moment ago (no lock: a lock here would meet the re-pairing's own delete of these rows in the other order)
    if not may_read(setup, row.viewer_id):
        await db.execute(delete(DesktopDirectAsk).where(DesktopDirectAsk.command_id == command_id))
        raise DesktopRelayError(409, "direct_viewer_gone", "the person who asked no longer pairs this computer")
    if cmd.state not in ("delivered", "acked"):
        raise DesktopRelayError(409, "direct_command_closed", "that command is not open")
    now_ms = int(_now().timestamp() * 1000)
    if env["setup_id"] != str(setup.id) or env["session_key"] != DIRECT_SESSION_KEY or env["command_id"] != row.press_key or not _fresh_answer(env, now_ms):
        raise DesktopRelayError(422, "envelope_header_mismatch", "the envelope's header is not this ask's")
    row.payload, row.written_at = {"envelope": env}, _now()
    await db.flush()
    return len(raw)


# ── ③ the person reads ────────────────────────────────────────────────────────────────────────────────────────────────────


async def read_answer(db: AsyncSession, *, user_id: uuid.UUID, org_id: uuid.UUID, setup_id: uuid.UUID, command_id: uuid.UUID) -> dict:
    """The sealed answer (once) or where the ask stands. A row that is not THIS person's, not of THIS computer, expired or already read is «not found» — one answer for every reason. Reading deletes the row in the same statement that returns it.
    The caller commits."""
    from app.services import remote_control
    from app.services.desktop_commands import org_role

    not_found = DesktopRelayError(404, "direct_ask_not_found", "no such ask")
    now = _now()
    row = (await db.execute(select(DesktopDirectAsk).where(DesktopDirectAsk.command_id == command_id, DesktopDirectAsk.viewer_id == user_id, DesktopDirectAsk.setup_id == setup_id))).scalar_one_or_none()
    if row is None:
        raise not_found
    if row.expires_at <= now:
        await db.execute(delete(DesktopDirectAsk).where(DesktopDirectAsk.command_id == command_id))
        raise not_found
    if row.polled_at is not None and now - row.polled_at < POLL_INTERVAL:  # before any lock: a tight poll costs the person a 429, not the computer's command row a queue
        raise DesktopRelayError(429, "direct_polled_too_fast", "ask again in a moment", detail={"retry_after": 1})
    cmd = (await db.execute(select(DesktopCommand).where(DesktopCommand.id == command_id, DesktopCommand.setup_id == setup_id, DesktopCommand.kind == ASK_KIND).with_for_update())).scalar_one_or_none()
    setup = (await db.execute(select(DesktopSetup).where(DesktopSetup.id == setup_id, DesktopSetup.org_id == org_id))).scalar_one_or_none()
    if cmd is None or setup is None:
        raise not_found
    row = (await db.execute(  # the row afresh, under the command's lock (the gap is judged again: two looks that arrived together cannot both pass it)
        select(DesktopDirectAsk).where(DesktopDirectAsk.command_id == command_id).with_for_update().execution_options(populate_existing=True)
    )).scalar_one_or_none()
    if row is None:
        raise not_found
    now = _now()  # read again: the look may have waited for the lock
    if row.expires_at <= now:
        await db.execute(delete(DesktopDirectAsk).where(DesktopDirectAsk.command_id == command_id))
        raise not_found
    if row.polled_at is not None and now - row.polled_at < POLL_INTERVAL:
        raise DesktopRelayError(429, "direct_polled_too_fast", "ask again in a moment", detail={"retry_after": 1})
    if not (may_read(setup, user_id) and await org_role(db, org_id, user_id) is not None and await remote_control.is_enabled(db, org_id)):
        await db.execute(delete(DesktopDirectAsk).where(DesktopDirectAsk.command_id == command_id))  # the pairing, the line or the seat is gone since the ask: nothing stays
        raise not_found
    if row.payload is None:
        if cmd.state in ("done", "failed", "rejected"):  # the computer ended without an answer: that is the answer (its closed code), and the row has nothing left to hold
            await db.execute(delete(DesktopDirectAsk).where(DesktopDirectAsk.command_id == command_id))
        else:
            await db.execute(update(DesktopDirectAsk).where(DesktopDirectAsk.command_id == command_id).values(polled_at=now))
        return {"state": cmd.state, "code": cmd.result_code, "envelope": None}
    if cmd.state not in ("delivered", "acked", "done"):
        await db.execute(delete(DesktopDirectAsk).where(DesktopDirectAsk.command_id == command_id))
        return {"state": cmd.state, "code": cmd.result_code, "envelope": None}
    taken = (await db.execute(
        delete(DesktopDirectAsk).where(DesktopDirectAsk.command_id == command_id, DesktopDirectAsk.viewer_id == user_id, DesktopDirectAsk.payload.is_not(None)).returning(DesktopDirectAsk.payload)
    )).scalar_one_or_none()
    if taken is None:
        raise not_found
    logger.info("desktop direct read: viewer=%s setup=%s command=%s", user_id, setup.id, command_id)  # ids only
    return {"state": "done", "code": cmd.result_code, "envelope": taken["envelope"]}


async def finish_ask(db: AsyncSession, *, user_id: uuid.UUID, setup_id: uuid.UUID, command_id: uuid.UUID) -> bool:
    """The person gives the ask up (the screen closed): the row goes now. Only the asker's own row — any other id deletes nothing, and says so the same way."""
    gone = (await db.execute(
        delete(DesktopDirectAsk).where(DesktopDirectAsk.command_id == command_id, DesktopDirectAsk.viewer_id == user_id, DesktopDirectAsk.setup_id == setup_id).returning(DesktopDirectAsk.command_id)
    )).scalar_one_or_none()
    return gone is not None


async def purge_expired(db: AsyncSession, *, now: datetime | None = None) -> int:
    """Every row past its end goes (the cron's job, and every new ask's and every answer's first step). A row someone else holds is skipped, never waited for: the lock order is «command row, then ask row»."""
    ids = list((await db.execute(select(DesktopDirectAsk.command_id).where(DesktopDirectAsk.expires_at <= (now or _now())).with_for_update(skip_locked=True))).scalars().all())
    if ids:
        await db.execute(delete(DesktopDirectAsk).where(DesktopDirectAsk.command_id.in_(ids)))
    return len(ids)


async def forget(db: AsyncSession, setup_ids: list[uuid.UUID], *, lock: bool = True) -> None:
    """The computers' asks go (a disconnect · an account's closure · a replaced line · remote control turned off): no answer stays for a computer that cannot be reached. The same lock rule as the files road."""
    if setup_ids:
        if lock:
            await db.execute(select(DesktopSetup.id).where(DesktopSetup.id.in_(setup_ids)).order_by(DesktopSetup.id).with_for_update())
        await db.execute(delete(DesktopDirectAsk).where(DesktopDirectAsk.setup_id.in_(setup_ids)))


# ── ④ how many (story 4993 P3b) ───────────────────────────────────────────────────────────────────────────────────────────

COUNT_MAX = 1_000_000_000  # a total past this is not a count a person's computer makes
COUNT_EPOCHS_PER_COMPUTER = 20  # the newest runs of the host kept per computer
COUNT_KEEP = timedelta(days=30)  # a run not reported for this long goes


class CountReport(BaseModel):
    """What a computer says of its direct road: nothing but two numbers and the name of the run they are counted over (a random word the host makes at start)"""
    model_config = ConfigDict(extra="forbid")

    epoch: str = Field(pattern=r"^[A-Za-z0-9_-]{8,64}$")
    commands: int = Field(strict=True, ge=0, le=COUNT_MAX)  # a number — never the text «1» or true
    doors: int = Field(strict=True, ge=0, le=COUNT_MAX)


COUNT_BODY_MAX = 512  # a report is a few dozen bytes; over this it is refused before it is parsed


def parse_count(raw: bytes) -> CountReport:
    """the body of a computer's report, judged by size BEFORE it is parsed and without ever putting what it holds into an error"""
    from pydantic import ValidationError

    if len(raw) > COUNT_BODY_MAX:
        raise DesktopRelayError(413, "direct_count_too_large", "the report is larger than the server takes")
    try:
        return CountReport.model_validate_json(raw)
    except ValidationError as exc:
        raise DesktopRelayError(422, "invalid_direct_count", exc.errors(include_url=False, include_input=False, include_context=False)[0]["msg"]) from exc


async def apply_count(db: AsyncSession, setup: DesktopSetup, body: CountReport) -> None:
    """The computer's running totals for one run: kept as the GREATER of what is there and what came (a report again changes nothing; an older, lower one never lowers the total). A computer keeps at most
    COUNT_EPOCHS_PER_COMPUTER runs — the least recently reported go first. The caller commits."""
    # one report at a time per computer: two reports of NEW runs that arrive together would each see only their own row, prune nothing, and commit past the bound (the lock is held to the commit)
    await db.execute(select(func.pg_advisory_xact_lock(func.hashtextextended(f"direct-count:{setup.id}", 0))))
    stmt = pg_insert(DesktopDirectCount).values(setup_id=setup.id, epoch=body.epoch, commands=body.commands, doors=body.doors)
    await db.execute(stmt.on_conflict_do_update(
        index_elements=[DesktopDirectCount.setup_id, DesktopDirectCount.epoch],
        set_={"commands": func.greatest(DesktopDirectCount.commands, stmt.excluded.commands), "doors": func.greatest(DesktopDirectCount.doors, stmt.excluded.doors), "updated_at": func.now()},
    ))
    keep = select(DesktopDirectCount.epoch).where(DesktopDirectCount.setup_id == setup.id).order_by(DesktopDirectCount.updated_at.desc(), DesktopDirectCount.epoch).limit(COUNT_EPOCHS_PER_COMPUTER)
    await db.execute(delete(DesktopDirectCount).where(DesktopDirectCount.setup_id == setup.id, DesktopDirectCount.epoch.not_in(keep)))


async def purge_counts(db: AsyncSession, *, now: datetime | None = None) -> int:
    """Every run not reported for COUNT_KEEP goes (the minute job)"""
    out = await db.execute(delete(DesktopDirectCount).where(DesktopDirectCount.updated_at <= (now or _now()) - COUNT_KEEP).returning(DesktopDirectCount.setup_id))
    return len(out.all())
