"""story #4951 (①a · Kadir lens A · E · F · G · H · I) — the LIST of changed files of one session's folder, from a person's own computer to that same person's web / phone view.

What travels: file NAMES, a status word and line counts — never a file's content, never a diff (v1 · PO 11-14). What the server keeps: one row per read in
`desktop_changes_reads`, for at most 120 seconds, deleted the moment its viewer reads it.

  who may read ........ the person who paired that computer (`desktop_setups.confirmed_by`) — and only them (PO 11-14: no org role, no phone signature). Judged twice: when the
                        read is asked for and again when the list is read; the row is bound to (command · viewer · computer · the agent's session) so another person, another computer or
                        another agent's id cannot read it by knowing the command id (Kadir E).
  what the command has . {session_key} — no folder, no path (the computer finds its own folder in its own table).
  how long it lives ... asked + 120 s; consumed once; swept at expiry (cron + every new read); gone with its command, its computer's disconnect, the pairing person's closure
                        and remote control turned off (`forget`) (Kadir A · I).
  limits .............. one open read per computer · one read per person per 3 s · a queued command older than 30 s is rejected, never delivered · the server cuts the list
                        itself (200 files · 240 characters a name · 512 KB a body) whatever the computer sent (Kadir F).
  names ............... control and bidirectional-override characters out; a sensitive NAME (.env · keys · credentials …) is hidden again here even if the computer sent it (a second
                        line behind the computer's own — the same list as the computer's; a renamed file counts on its old AND its new name) (Kadir D · H).
  what is logged ...... counts and ids only: never a name, never the list (Kadir A).
"""
from __future__ import annotations

import logging
import unicodedata
import uuid
from datetime import datetime, timedelta, timezone
from typing import Literal

from pydantic import BaseModel, ConfigDict, Field, ValidationError
from sqlalchemy import delete, func, select, text, update
from sqlalchemy.ext.asyncio import AsyncSession

from app.models.desktop_relay import DesktopChangesAudit, DesktopChangesRead, DesktopCommand, DesktopSession
from app.models.desktop_setup import DesktopSetup
from app.services.desktop_relay import DesktopRelayError

logger = logging.getLogger(__name__)

READ_TTL = timedelta(seconds=120)
COMMAND_EXPIRY = timedelta(seconds=30)
PER_PERSON_INTERVAL = timedelta(seconds=3)
POLL_INTERVAL = timedelta(seconds=1)  # one look at a pending read per second (Kadir 5817 lens #4): every look takes the command row's lock
AUDIT_RETENTION = timedelta(days=90)  # an audit line (who · which computer · how many) lives 90 days, then the sweep takes it; the account purge takes a person's lines at once (lens #5)
LIST_MAX = 200
REPORT_FILES_MAX = 1000  # what a computer may SEND (the server keeps LIST_MAX of them and says there is more)
NAME_MAX = 240
BODY_MAX = 512 * 1024
LINES_MAX = 100_000_000

STATUS_WORDS = ("added", "modified", "deleted", "renamed", "untracked", "conflicted", "typechange")
OPEN_COMMAND_STATES = ("queued", "delivered", "acked")


def _now() -> datetime:
    return datetime.now(timezone.utc)


# ── names ─────────────────────────────────────────────────────────────────────────────────────────────────────────────────

# the bidirectional controls a name could use to read as something else (U+202A–202E, U+2066–2069, U+200E, U+200F) · the line / paragraph separators
_BIDI = {chr(c) for c in (*range(0x202A, 0x202F), *range(0x2066, 0x206A), 0x200E, 0x200F, 0x061C, 0x2028, 0x2029)}


def _shown(text: str) -> str:
    """A name without what must never be drawn: control characters (Cc), every invisible format character (Cf: zero-width space / joiner, soft hyphen, BOM, bidirectional marks), line separators.
    NOT cut: the sensitive-name rule is judged on this (the schema already holds it to 4096), and only what is SHOWN is cut (Kadir 5817 lens #2 · #3)."""
    return "".join(ch for ch in text if ch not in _BIDI and unicodedata.category(ch) not in ("Cc", "Cf"))


def clean_name(text: str) -> str:
    """What may be shown of a file name: `_shown`, then cut at NAME_MAX code points."""
    return _shown(text)[:NAME_MAX]


# Names whose very existence is not shown (Kadir lens D ⑤). Matched on EVERY path segment, case-insensitively, after trailing dots and spaces are dropped — and on the old name of a
# rename as well as the new: `.env` renamed to `notes.txt` is still the secret.
_SENSITIVE_EXACT = frozenset((
    ".npmrc", ".netrc", ".pgpass", ".git-credentials", ".pypirc", ".htpasswd", "kubeconfig", "credentials", "credentials.json",
    "id_rsa", "id_dsa", "id_ecdsa", "id_ed25519", ".dockercfg", ".claude.json",
))
# `.claude.json`: the Claude CLI's account file and its backups (story 4983 P6) — the `.claude/` folder is the user's own and is not hidden
_SENSITIVE_PREFIX = ("id_rsa", "id_dsa", "id_ecdsa", "id_ed25519", ".env", "service-account", ".claude.json.")
_SENSITIVE_SUFFIX = (
    ".pem", ".key", ".p12", ".p8", ".pfx", ".jks", ".keystore", ".gpg", ".asc", ".kdbx", ".tfstate", ".tfstate.backup", ".tfvars", ".tfvars.json", ".ovpn",
    ".keychain", ".keychain-db", ".token",
)
_SENSITIVE_CONTAINS = ("credentials", "secret")
_SENSITIVE_DIRS = frozenset((".aws", ".ssh", ".gnupg", ".kube"))


# the blank look-alikes (braille blank · Hangul fillers) and the variation selectors draw nothing: a name spelled with one is the name without it (the host's table drops the same)
_BLANKS = frozenset("\u2800\u3164\uffa0\u115f\u1160\u17b4\u17b5\u034f")


def _is_variation_selector(ch: str) -> bool:
    cp = ord(ch)
    return 0xFE00 <= cp <= 0xFE0F or 0xE0100 <= cp <= 0xE01EF or 0x180B <= cp <= 0x180D or cp == 0x180F


def _canon(text: str) -> str:
    """What a name IS for the rule, not how it is drawn: compatibility forms folded (NFKC: a full-width slash is a slash, a no-break space a space), every control and every invisible
    format character (zero-width space / joiner, soft hyphen, bidirectional marks …: categories Cc and Cf) dropped, case folded. Used for MATCHING only — the shown name is `clean_name`'s."""
    folded = unicodedata.normalize("NFKC", text)
    return "".join(ch for ch in folded if unicodedata.category(ch) not in ("Cc", "Cf") and ch not in _BLANKS and not _is_variation_selector(ch)).casefold()


def _strip_tail(seg: str) -> str:
    """Trailing dots and spaces of ANY kind (a leading dot is part of the name: `.env`)."""
    while seg and (seg[-1] == "." or seg[-1].isspace()):
        seg = seg[:-1]
    return seg


def _segment_sensitive(raw: str, *, last: bool) -> bool:
    seg = _strip_tail(_canon(raw))
    if not seg:
        return False
    if seg in _SENSITIVE_DIRS and not last:
        return True
    if seg in _SENSITIVE_EXACT or seg.startswith(_SENSITIVE_PREFIX) or seg.endswith(_SENSITIVE_SUFFIX):
        return True
    return any(word in seg for word in _SENSITIVE_CONTAINS)


def is_sensitive_path(path: str | None) -> bool:
    if not path:
        return False
    parts = [p for p in _canon(path).replace("\\", "/").split("/") if p not in ("", ".")]
    if not parts:
        return False
    for i, part in enumerate(parts):
        if _segment_sensitive(part, last=i == len(parts) - 1):
            return True
    # `.docker/config.json` — the file is only secret inside that folder
    folded = [_strip_tail(p) for p in parts]
    return any(a == ".docker" and b == "config.json" for a, b in zip(folded, folded[1:]))


# ── what the computer sends ───────────────────────────────────────────────────────────────────────────────────────────────


class ChangedFileReport(BaseModel):
    model_config = ConfigDict(extra="forbid")

    status: Literal["added", "modified", "deleted", "renamed", "untracked", "conflicted", "typechange"]
    name: str = Field(max_length=4096)
    old_name: str | None = Field(default=None, max_length=4096)
    adds: int | None = Field(default=None, ge=0, le=LINES_MAX, strict=True)
    dels: int | None = Field(default=None, ge=0, le=LINES_MAX, strict=True)
    binary: bool = False
    hidden: bool = False  # the computer already hid it (a sensitive name): `name` is empty then


class ChangesReport(BaseModel):
    model_config = ConfigDict(extra="forbid")

    files: list[ChangedFileReport] = Field(max_length=REPORT_FILES_MAX)
    more: bool = False  # the computer's own «there were more than I sent»


def parse_report(raw: bytes) -> ChangesReport:
    """The body of a computer's list, judged without ever putting what it holds into an error: a refusal says WHICH rule, not the input."""
    if len(raw) > BODY_MAX:
        raise DesktopRelayError(413, "changes_too_large", "the list is larger than the server takes")
    try:
        return ChangesReport.model_validate_json(raw)
    except ValidationError as exc:
        raise DesktopRelayError(422, "invalid_changes", exc.errors(include_url=False, include_input=False, include_context=False)[0]["msg"]) from exc


def shaped(report: ChangesReport) -> dict:
    """The stored list: at most LIST_MAX rows, every name cleaned and cut, every sensitive name hidden (name and old name both), counts kept only for a shown row."""
    rows: list[dict] = []
    for f in report.files[:LIST_MAX]:
        full, old_full = _shown(f.name), _shown(f.old_name) if f.old_name else None  # judged on the whole name, cut only for showing
        name, old = full[:NAME_MAX], old_full[:NAME_MAX] if old_full else None
        hidden = f.hidden or is_sensitive_path(full) or is_sensitive_path(old_full)
        if hidden:
            rows.append({"status": f.status, "name": None, "old_name": None, "adds": None, "dels": None, "binary": False, "hidden": True})
        else:
            rows.append({"status": f.status, "name": name, "old_name": old, "adds": f.adds, "dels": f.dels, "binary": f.binary, "hidden": False})
    return {"files": rows, "more": report.more or len(report.files) > LIST_MAX, "total": len(report.files)}


# ── who ───────────────────────────────────────────────────────────────────────────────────────────────────────────────────


def may_read(setup: DesktopSetup | None, user_id: uuid.UUID) -> bool:
    """The one rule: the person who paired this computer, on a line that is still connected (never an org role)."""
    return setup is not None and setup.revoked_at is None and setup.confirmed_by is not None and setup.confirmed_by == user_id


async def _session_of_agent(db: AsyncSession, *, org_id: uuid.UUID, agent_id: uuid.UUID, session_key: str) -> tuple[DesktopSession, DesktopSetup]:
    from app.services.desktop_commands import _agent, _agent_setups

    await _agent(db, org_id, agent_id)
    setups = {s.id: s for s in await _agent_setups(db, org_id, agent_id)}
    session = (await db.execute(
        select(DesktopSession).where(DesktopSession.setup_id.in_(list(setups) or [uuid.uuid4()]), DesktopSession.session_key == session_key,
                                     DesktopSession.agent_member_id == agent_id)
    )).scalars().first()
    if session is None:
        raise DesktopRelayError(404, "session_not_found", "no such session of this agent")
    return session, setups[session.setup_id]


async def purge_expired(db: AsyncSession, *, now: datetime | None = None) -> int:
    """Every row past its end goes (the cron's job, and every new read's and every list write's first step). A row someone else holds is skipped, never waited for (the next sweep takes it):
    the lock order of this module is «command row, then read row», and a sweep must not be a second order (Kadir r2 #1)."""
    ids = list((await db.execute(
        select(DesktopChangesRead.command_id).where(DesktopChangesRead.expires_at <= (now or _now())).with_for_update(skip_locked=True)
    )).scalars().all())
    if ids:
        await db.execute(delete(DesktopChangesRead).where(DesktopChangesRead.command_id.in_(ids)))
    return len(ids)


async def purge_audit(db: AsyncSession, *, now: datetime | None = None) -> int:
    """The audit lines older than AUDIT_RETENTION go (the cron's job, after the expired rows)."""
    gone = await db.execute(delete(DesktopChangesAudit).where(DesktopChangesAudit.created_at < (now or _now()) - AUDIT_RETENTION))
    return gone.rowcount or 0


async def forget(db: AsyncSession, setup_ids: list[uuid.UUID], *, lock: bool = True) -> None:
    """The computers' reads go (a disconnect · an account's closure · a replaced line · remote control turned off): no list stays for a computer that cannot be reached.
    The same lock rule as the clock view's `forget`."""
    if setup_ids:
        if lock:
            await db.execute(select(DesktopSetup.id).where(DesktopSetup.id.in_(setup_ids)).order_by(DesktopSetup.id).with_for_update())
        await db.execute(delete(DesktopChangesRead).where(DesktopChangesRead.setup_id.in_(setup_ids)))


# ── ① a person asks ───────────────────────────────────────────────────────────────────────────────────────────────────────


class ReadRequest(BaseModel):
    model_config = ConfigDict(extra="forbid")

    session_key: str = Field(pattern=r"^[A-Za-z0-9_-]{1,64}$")


async def take_limit_locks(db: AsyncSession, setup: DesktopSetup, user_id: uuid.UUID, *, road: str) -> None:
    """The ONE lock order of every «one at a time» limit of a read road (story 4983: the files road calls this, it does not write it again): the physical computer's advisory key, THEN the person's, taken in this order
    and never the other, so two asks at once — even for different lines of the same computer, or from one person to two computers — cannot both pass (Kadir 4951 r1 #5 · #6). `road` names the road (`changes`, `files`):
    a road's limits are its own."""
    machine = f"{setup.org_id}:{setup.machine_key}" if setup.machine_key else str(setup.id)
    await db.execute(text("SELECT pg_advisory_xact_lock(hashtext(:k))"), {"k": f"{road}-machine:{machine}"})
    await db.execute(text("SELECT pg_advisory_xact_lock(hashtext(:k))"), {"k": f"{road}-person:{user_id}"})


def lines_of_machine(setup: DesktopSetup):
    """the lines (setups) that are the same physical computer — a list of ids or a subquery the «open reads» count runs over"""
    if not setup.machine_key:
        return [setup.id]
    return select(DesktopSetup.id).where(DesktopSetup.org_id == setup.org_id, DesktopSetup.machine_key == setup.machine_key, DesktopSetup.revoked_at.is_(None))


async def create_read(db: AsyncSession, *, member_id: uuid.UUID, user_id: uuid.UUID, org_id: uuid.UUID, agent_id: uuid.UUID, body: ReadRequest) -> tuple[uuid.UUID, datetime]:
    """→ (the command's id, when the read ends). The caller commits."""
    from app.services import remote_control
    from app.services.agent_permissions import _reachable
    from app.services.desktop_commands import can_view, org_role
    from app.services.desktop_relay import enqueue_command

    session, setup = await _session_of_agent(db, org_id=org_id, agent_id=agent_id, session_key=body.session_key)
    if await org_role(db, org_id, user_id) is None or not may_read(setup, user_id) or not await can_view(db, user_id=user_id, org_id=org_id, agent_id=agent_id):
        raise DesktopRelayError(403, "not_allowed_to_read_changes", "only the person who paired this computer can read its changes")
    if not await remote_control.is_enabled(db, org_id):
        raise DesktopRelayError(409, remote_control.OFF_CODE, "remote control is off for this organization")
    now = _now()
    if setup.id not in await _reachable(db, {setup.id}, now):
        raise DesktopRelayError(409, "device_unreachable", "that computer has not been heard from")
    # the computer's row is locked, then who may is asked AGAIN under the lock (a disconnect or a re-pairing that committed in between), then the limits are counted under it
    locked = (await db.execute(select(DesktopSetup).where(DesktopSetup.id == setup.id).with_for_update().execution_options(populate_existing=True))).scalar_one_or_none()
    if not may_read(locked, user_id):
        raise DesktopRelayError(403, "not_allowed_to_read_changes", "only the person who paired this computer can read its changes")
    await purge_expired(db, now=now)
    # the limits are counted under two advisory locks taken in ONE order (the physical computer, then the person), so two asks at once — even for different lines of the same
    # computer, or from one person to two computers — cannot both pass (Kadir 4951 r1 #5 · #6)
    await take_limit_locks(db, setup, user_id, road="changes")
    # the person's pause reads their last ASK (the command rows stay after a list is read — the read row does not): reading a list does not reset it
    last = (await db.execute(
        select(func.max(DesktopCommand.created_at)).where(DesktopCommand.kind == "read_changes", DesktopCommand.requested_by == member_id)
    )).scalar_one()
    if last is not None and now - last < PER_PERSON_INTERVAL:
        raise DesktopRelayError(429, "changes_too_fast", "wait a moment before asking again", detail={"retry_after": 3})
    lines = lines_of_machine(setup)
    busy = (await db.execute(
        select(func.count()).select_from(DesktopChangesRead)
        .join(DesktopCommand, DesktopCommand.id == DesktopChangesRead.command_id)
        .where(DesktopChangesRead.setup_id.in_(lines), DesktopChangesRead.payload.is_(None), DesktopCommand.state.in_(OPEN_COMMAND_STATES))
    )).scalar_one()
    if busy:
        raise DesktopRelayError(409, "changes_busy", "that computer is already reading its changes")
    cmd = await enqueue_command(
        db, setup=setup, kind="read_changes", payload={"session_key": session.session_key}, idempotency_key=f"changes:{uuid.uuid4()}", requested_by=member_id,
    )
    expires_at = now + READ_TTL
    db.add(DesktopChangesRead(command_id=cmd.id, setup_id=setup.id, viewer_id=user_id, agent_member_id=agent_id, expires_at=expires_at))
    await db.flush()
    logger.info("desktop changes read asked: viewer=%s setup=%s command=%s", user_id, setup.id, cmd.id)  # ids only
    return cmd.id, expires_at


# ── ② the computer answers ────────────────────────────────────────────────────────────────────────────────────────────────


async def write_result(db: AsyncSession, setup: DesktopSetup, command_id: uuid.UUID, raw: bytes) -> int:
    """The computer's list for one read — written ONCE, only into a row of THIS computer whose command is still open and whose viewer is still its pairing person. → the file count."""
    report = parse_report(raw)
    # the ONE lock order of this module: the command row first, then the read row (a disconnect or a remote-control-off rejects the commands and THEN deletes the rows — Kadir r2 #1).
    # The command is locked while the list is stored too: a stale-command rejection (`reject_stale_commands`) that wants it waits, so «open» is still true when the list lands (r1 #4)
    cmd = (await db.execute(
        select(DesktopCommand).where(DesktopCommand.id == command_id, DesktopCommand.setup_id == setup.id, DesktopCommand.kind == "read_changes").with_for_update()
    )).scalar_one_or_none()
    await purge_expired(db)  # whoever writes sweeps (rows nobody holds): no list waits past its end for the cron's next minute
    row = (await db.execute(
        select(DesktopChangesRead).where(DesktopChangesRead.command_id == command_id, DesktopChangesRead.setup_id == setup.id).with_for_update()
    )).scalar_one_or_none()
    if row is None or cmd is None:
        raise DesktopRelayError(404, "changes_read_not_found", "no such read on this device")
    if row.expires_at <= _now():
        await db.execute(delete(DesktopChangesRead).where(DesktopChangesRead.command_id == command_id))
        raise DesktopRelayError(404, "changes_read_not_found", "no such read on this device")
    if row.payload is not None:
        raise DesktopRelayError(409, "changes_already_written", "this read has its list already")
    if not may_read(setup, row.viewer_id):  # the computer was re-paired or disconnected since the question
        await db.execute(delete(DesktopChangesRead).where(DesktopChangesRead.command_id == command_id))
        raise DesktopRelayError(409, "changes_viewer_gone", "the person who asked no longer pairs this computer")
    if cmd.state not in ("delivered", "acked"):
        raise DesktopRelayError(409, "changes_command_closed", "that command is not open")
    # the session key is the command's only handle on the folder: it must still be THIS agent's session on this computer (a later report can hand the key to another agent — Kadir r1 #1)
    # …and the session row is share-locked until this transaction ends, so a report that hands the key to another agent waits instead of slipping in between the check and the store (r2 #4)
    still = (await db.execute(
        select(DesktopSession.id).where(DesktopSession.setup_id == setup.id, DesktopSession.session_key == cmd.session_key, DesktopSession.agent_member_id == row.agent_member_id)
        .with_for_update(read=True)
    )).first()
    if still is None:
        await db.execute(delete(DesktopChangesRead).where(DesktopChangesRead.command_id == command_id))
        raise DesktopRelayError(409, "changes_session_gone", "that session is no longer this agent's on that computer")
    stored = shaped(report)
    row.payload, row.written_at = stored, _now()
    await db.flush()
    return len(stored["files"])


# ── ③ the person reads ────────────────────────────────────────────────────────────────────────────────────────────────────


async def read_result(db: AsyncSession, *, user_id: uuid.UUID, org_id: uuid.UUID, agent_id: uuid.UUID, command_id: uuid.UUID) -> dict:
    """The list (once) or where the read stands. A row that is not THIS person's, not of THIS agent's session, expired or already read is «not found» — one answer for every
    reason, so an id says nothing. Reading deletes the row in the same statement that returns it. The caller commits."""
    from app.services import remote_control
    from app.services.desktop_commands import can_view, org_role

    not_found = DesktopRelayError(404, "changes_read_not_found", "no such read")
    now = _now()
    row = (await db.execute(
        select(DesktopChangesRead).where(DesktopChangesRead.command_id == command_id, DesktopChangesRead.viewer_id == user_id)
    )).scalar_one_or_none()
    if row is None or row.agent_member_id != agent_id:  # not this person's, or not the agent it was asked for (a later owner of the session key cannot take it)
        raise not_found
    if row.expires_at <= now:
        await db.execute(delete(DesktopChangesRead).where(DesktopChangesRead.command_id == command_id))
        raise not_found
    if row.polled_at is not None and now - row.polled_at < POLL_INTERVAL:  # before any lock is asked for: a tight poll costs the person a 429, not the computer's command row a queue
        raise DesktopRelayError(429, "changes_polled_too_fast", "ask again in a second", detail={"retry_after": 1})
    cmd = (await db.execute(select(DesktopCommand).where(DesktopCommand.id == command_id, DesktopCommand.setup_id == row.setup_id, DesktopCommand.kind == "read_changes").with_for_update())).scalar_one_or_none()  # command row first (the module's one lock order); held until the row is deleted, so a failure / rejection cannot slip in between the state check and the delete (r2 #2)
    setup = (await db.execute(select(DesktopSetup).where(DesktopSetup.id == row.setup_id, DesktopSetup.org_id == org_id))).scalar_one_or_none()
    session = None
    if cmd is not None and setup is not None:
        session = (await db.execute(
            select(DesktopSession.id).where(DesktopSession.setup_id == setup.id, DesktopSession.session_key == cmd.session_key, DesktopSession.agent_member_id == agent_id)
            .with_for_update(read=True)  # share-locked until commit: a report that hands the key to another agent waits (r2 #4)
        )).first()
    if session is None:  # another agent's id (or another organization's): not this read — nothing is deleted by a wrong id
        raise not_found
    allowed = (
        may_read(setup, user_id) and await org_role(db, org_id, user_id) is not None and await remote_control.is_enabled(db, org_id)
        and await can_view(db, user_id=user_id, org_id=org_id, agent_id=agent_id)
    )
    if not allowed:  # the pairing, the line or the seat is gone since the question: nothing stays
        await db.execute(delete(DesktopChangesRead).where(DesktopChangesRead.command_id == command_id))
        raise not_found
    if row.payload is None:
        if cmd.state in ("done", "failed", "rejected"):  # the computer ended without a list: that is the answer, and the row has nothing left to hold
            await db.execute(delete(DesktopChangesRead).where(DesktopChangesRead.command_id == command_id))
        else:
            await db.execute(update(DesktopChangesRead).where(DesktopChangesRead.command_id == command_id).values(polled_at=now))  # after the command row's lock: the module's one order
        return {"state": cmd.state, "code": cmd.result_code, "files": None, "more": False, "total": 0}
    if cmd.state not in ("delivered", "acked", "done"):  # a list whose command ended failed / rejected (a stale rejection that came after it was stored): not given, and not kept
        await db.execute(delete(DesktopChangesRead).where(DesktopChangesRead.command_id == command_id))
        return {"state": cmd.state, "code": cmd.result_code, "files": None, "more": False, "total": 0}
    taken = (await db.execute(
        delete(DesktopChangesRead).where(DesktopChangesRead.command_id == command_id, DesktopChangesRead.viewer_id == user_id, DesktopChangesRead.payload.is_not(None))
        .returning(DesktopChangesRead.payload)
    )).scalar_one_or_none()
    if taken is None:  # the other reader of the same id got it first
        raise not_found
    files = taken.get("files") or []
    db.add(DesktopChangesAudit(org_id=org_id, viewer_id=user_id, setup_id=setup.id, command_id=command_id, file_count=len(files)))  # who · which computer · how many — no name, no content
    logger.info("desktop changes read: viewer=%s setup=%s command=%s files=%d", user_id, setup.id, command_id, len(files))  # counts and ids only
    return {"state": "done", "code": cmd.result_code, "files": files, "more": bool(taken.get("more")), "total": int(taken.get("total") or len(files))}


# ── the queue's own ───────────────────────────────────────────────────────────────────────────────────────────────────────


async def reject_stale_commands(db: AsyncSession, commands: list[DesktopCommand], *, now: datetime | None = None) -> list[DesktopCommand]:
    """A `read_changes` that waited longer than COMMAND_EXPIRY is not sent: it ends `rejected · expired` here (the person's next ask is a new one). → the commands that may go."""
    now = now or _now()
    keep: list[DesktopCommand] = []
    for c in commands:
        if c.kind in ("read_changes", "file_list", "file_read") and c.created_at is not None and now - c.created_at > COMMAND_EXPIRY:  # (story 4983: a files request waits no longer than a changed-files read)
            c.state, c.result_code, c.finished_at = "rejected", "expired", now
        else:
            keep.append(c)
    return keep
