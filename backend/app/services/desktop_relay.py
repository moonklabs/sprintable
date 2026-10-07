"""story #4529 (E-DESKTOP-2 B-1) — the device relay's server side. Contract: doc «E-DESKTOP-2 B-1 — 기기 줄 계약 v1» (02d2cf71).

- A device token (`sdt_…`) is issued with the exchange, apart from the agent keys (an agent key never gets one — PO 05:19Z: while
  agent keys can leak through a CLI environment, minting a remote credential from one would undo the separation), valid on
  /api/v2/desktop/relay/* only, revoked with the device.
- The daemon reports its sessions (the only source — the server records, never guesses); `unknown` is shown, never stored, when
  the device has been silent longer than UNKNOWN_AFTER.
- Commands: four kinds, a per-kind payload schema with nothing extra, one row per idempotency key, numbered per device, the state
  moving forward only. The daemon reports a code, never output.
"""
from __future__ import annotations

import functools
import hashlib
import hmac
import logging
import secrets
import uuid
from datetime import datetime, timedelta, timezone
from typing import Literal

from pydantic import BaseModel, ConfigDict, Field, StrictBool, ValidationError, model_validator
from sqlalchemy import func, select, update
from sqlalchemy.ext.asyncio import AsyncSession
from sqlalchemy.orm import Session

from app.models.desktop_relay import (
    COMMAND_KINDS,
    COMMAND_STATE_ORDER,
    DesktopCommand,
    DesktopDeviceToken,
    DesktopSession,
    SESSION_LIMIT_STATES,
)
from app.core.datetime_query import OffsetDatetime
from app.models.desktop_setup import DesktopSetup

logger = logging.getLogger(__name__)

TOKEN_PREFIX = "sdt_"
UNKNOWN_AFTER = timedelta(seconds=90)  # PO 05:19Z — three missed 30-second heartbeats
SESSION_KEY_PATTERN = r"^[A-Za-z0-9_-]{1,64}$"
# story #4554 (PO 11:45Z) — the relay's edges, each a named number:
INT32_MAX = 2_147_483_647  # `desktop_sessions.last_report_seq` · `desktop_commands.device_seq` are int4 — a report past it → 422, never 500
SESSION_ROWS_PER_DEVICE = 200  # the most recent rows a device keeps (live and ended) — a new key past it drops the oldest ended row first
ENDED_SESSION_RETENTION = timedelta(days=7)  # an ended session is kept this long, then goes with the next report
SESSIONS_PAGE_DEFAULT = 50  # a person's read of a device's sessions: live first, newest first — `limit` (default · max)
SESSIONS_PAGE_MAX = 200
DISCONNECTED_CODE = "device_disconnected"  # the open commands of a disconnected device · the stream's access_revoked reason
PROMPT_MAX = 8000
# story #4534 (Kadir 06:21Z ④ · Yuna 06:29Z ②): an instruction into the running turn — code points, the same count on the phone's
# sheet, the web's sheet, the daemon and here (one line pasted at once stays under the CLI's fold — 800 measured, not folded)
INSTRUCT_NOW_MAX = 400


class DesktopRelayError(Exception):
    def __init__(self, status: int, code: str, message: str, *, detail: dict | None = None):
        super().__init__(message)
        self.status, self.code, self.message, self.detail = status, code, message, detail


def _hash(token: str) -> str:
    return hashlib.sha256(token.encode()).hexdigest()


def _now() -> datetime:
    return datetime.now(timezone.utc)


# ── the device token ─────────────────────────────────────────────────────────────────────────────────────────────────────────


async def issue_device_token(db: AsyncSession, setup_id: uuid.UUID) -> str:
    """One active token per device: any earlier one is revoked. The plaintext is returned once (the exchange response)."""
    now = _now()
    await db.execute(
        update(DesktopDeviceToken)
        .where(DesktopDeviceToken.setup_id == setup_id, DesktopDeviceToken.revoked_at.is_(None))
        .values(revoked_at=now)
    )
    token = TOKEN_PREFIX + secrets.token_urlsafe(32)
    db.add(DesktopDeviceToken(id=uuid.uuid4(), setup_id=setup_id, token_hash=_hash(token), issued_at=now))
    # story #4554 ③ (PO 11:45Z): a new token = a daemon that may start counting from 1 again (a reinstall · §1.1) — the device's
    # report baseline goes back to 0 with it, so its first report is not refused as stale for ever
    await db.execute(update(DesktopSession).where(DesktopSession.setup_id == setup_id).values(last_report_seq=0))
    await db.flush()
    return token


async def revoke_device_tokens(db: AsyncSession, setup_id: uuid.UUID, *, now: datetime | None = None) -> int:
    revoked = (await db.execute(
        update(DesktopDeviceToken)
        .where(DesktopDeviceToken.setup_id == setup_id, DesktopDeviceToken.revoked_at.is_(None))
        .values(revoked_at=now or _now())
        .returning(DesktopDeviceToken.id)
    )).scalars().all()
    return len(revoked)


async def device_for_token(db: AsyncSession, token: str | None) -> DesktopSetup | None:
    """The device a token belongs to — None for no token, another shape, an unknown or revoked token, or a disconnected device."""
    if not token or not token.startswith(TOKEN_PREFIX):
        return None
    row = (await db.execute(
        select(DesktopDeviceToken, DesktopSetup)
        .join(DesktopSetup, DesktopSetup.id == DesktopDeviceToken.setup_id)
        .where(DesktopDeviceToken.token_hash == _hash(token))
    )).first()
    if row is None:
        return None
    tok, setup = row
    if not hmac.compare_digest(tok.token_hash, _hash(token)):
        return None
    if tok.revoked_at is not None or setup.revoked_at is not None or setup.exchanged_at is None:
        return None
    return setup


async def touch_device(db: AsyncSession, setup_id: uuid.UUID) -> None:
    """The device was heard from now (connect · heartbeat · any report) — what `unknown` is measured from."""
    await db.execute(
        update(DesktopDeviceToken)
        .where(DesktopDeviceToken.setup_id == setup_id, DesktopDeviceToken.revoked_at.is_(None))
        .values(last_used_at=_now())
    )


async def device_still_valid(db: AsyncSession, setup_id: uuid.UUID) -> bool:
    """An open stream asks again: a disconnect (device revoked · its token revoked) ends it."""
    row = (await db.execute(
        select(DesktopSetup.revoked_at, func.count(DesktopDeviceToken.id))
        .select_from(DesktopSetup)
        .outerjoin(DesktopDeviceToken, (DesktopDeviceToken.setup_id == DesktopSetup.id) & DesktopDeviceToken.revoked_at.is_(None))
        .where(DesktopSetup.id == setup_id)
        .group_by(DesktopSetup.revoked_at)
    )).first()
    return row is not None and row[0] is None and row[1] > 0


# ── sessions ─────────────────────────────────────────────────────────────────────────────────────────────────────────────────


class SessionLimit(BaseModel):
    """story #4534 (contract v1.12): why a session waits when that is a usage limit — `at` when it resets / continues · `again` it
    hit the limit again after continuing · `self_resume` whether Claude may continue by itself (its login)."""

    model_config = ConfigDict(extra="forbid")

    at: OffsetDatetime | None = None
    again: bool | None = None
    self_resume: Literal["maybe", "no", "unknown"] | None = None
    # story #4560 (contract v2.1 §5 · PO 14:41Z): the daemon held off at the limit's end — the closed words only (another → 422)
    held: Literal["screen", "esc_not_taken"] | None = None


class SystemHold(BaseModel):
    """story #4599 (contract v1.13 · Kadir lens ③): why a `waiting_system` turn waits — the folder the macOS window asks about, when
    the daemon read it (tccd's service name → a closed list); absent when the window was seen by its owner alone. Never a path."""

    model_config = ConfigDict(extra="forbid")

    folder: Literal["documents", "desktop", "downloads", "network_volume", "icloud"] | None = None


class SessionReport(BaseModel):
    """One session's state — nothing else: no terminal bytes, no prompt text, no path, no key (extra fields → 422)."""

    model_config = ConfigDict(extra="forbid")

    agent_member_id: uuid.UUID
    runtime: Literal["claude", "codex"]
    # story #4534 (0437 · contract v1.12): the board's own words — never folded into «idle» (asked in the terminal · an error ·
    # paused at a usage limit)
    # story #4599 (0442 · contract v1.13): `waiting_system` — held by a macOS window on that computer (no limit rides on it)
    state: Literal["starting", "working", "idle", "waiting_permission", "waiting_input", "error", "paused_limit", "waiting_system", "stopped"]
    at: OffsetDatetime  # a time without its offset is refused (4330)
    limit: SessionLimit | None = None
    # story #4599: the window's folder — with `waiting_system` only (the validator below)
    system: SystemHold | None = None
    # story #4534 (0438 · PO 06:30Z): whether this session can take an instruction into the running turn — read by the daemon once
    # when the session starts. It only hides [지금 지시] on the web; the daemon decides again when an instruction comes (Kadir 06:31Z)
    instruct_now: StrictBool | None = None  # a boolean only — never «yes» · 1 read as true

    @model_validator(mode="after")
    def _limit_on_a_limit_word_only(self) -> "SessionReport":
        if self.limit is not None and self.state not in SESSION_LIMIT_STATES:
            raise ValueError("limit is carried with waiting_input · error · paused_limit only")
        if self.system is not None and self.state != "waiting_system":
            raise ValueError("system is carried with waiting_system only")
        return self


class SessionStateReport(SessionReport):
    report_seq: int = Field(ge=1)


class SnapshotSession(SessionReport):
    session_key: str = Field(pattern=SESSION_KEY_PATTERN)


class SessionSnapshot(BaseModel):
    model_config = ConfigDict(extra="forbid")

    report_seq: int = Field(ge=1)
    sessions: list[SnapshotSession] = Field(max_length=64)


def _setup_agents(setup: DesktopSetup) -> set[uuid.UUID]:
    return {uuid.UUID(str(m["member_id"])) for m in (setup.members or []) if m.get("kind") == "agent" and m.get("member_id")}


async def _lock_device_seq(db: AsyncSession, setup_id: uuid.UUID) -> int:
    """The device's latest report_seq, under the device row's lock (two reports at once are ordered, not interleaved)."""
    await db.execute(select(DesktopSetup.id).where(DesktopSetup.id == setup_id).with_for_update())
    return (await db.execute(
        select(func.coalesce(func.max(DesktopSession.last_report_seq), 0)).where(DesktopSession.setup_id == setup_id)
    )).scalar_one()


def _check_agent(setup: DesktopSetup, agent_member_id: uuid.UUID) -> None:
    if agent_member_id not in _setup_agents(setup):
        raise DesktopRelayError(422, "agent_not_on_device", "the agent is not one this device was set up with")


def _set_limit(row: DesktopSession, limit: SessionLimit | None) -> None:
    """story #4534: the row's limit is the report's — a report without one clears it (the limit is over)."""
    row.limited = True if limit else None
    row.limit_at = limit.at if limit else None
    row.limit_again = limit.again if limit else None
    row.limit_self_resume = limit.self_resume if limit else None
    row.limit_held = limit.held if limit else None


def _set_system(row: DesktopSession, report: SessionReport) -> None:
    """story #4599: the window's folder is the report's — any other word (the hold is over) clears it."""
    row.system_folder = report.system.folder if report.state == "waiting_system" and report.system else None


def system_view(row: DesktopSession) -> dict | None:
    """story #4599: a `waiting_system` row's why as a reader sees it — `{folder}` (null when not read); None on any other word."""
    if row.state != "waiting_system":
        return None
    return {"folder": row.system_folder}


# story #4534 (Kadir 4960 · PO 05:36Z): a reader built for the five words (a web bundle from before · a tab left open · the phone's web
# view) must never meet a word it does not know — `state` stays one of the five (the new words fold to idle, as the daemon used to
# send them) and the board's own word goes in `activity` beside it, read by the new web only.
# story #4599: a turn held by a macOS window is still a turn — a reader from before sees it working (what the daemon sent before)
LEGACY_STATE = {"waiting_input": "idle", "error": "idle", "paused_limit": "idle", "waiting_system": "working"}


def legacy_state(state: str) -> str:
    return LEGACY_STATE.get(state, state)


def limit_view(row: DesktopSession) -> dict | None:
    """story #4534: a row's limit as a reader sees it (only what is set) — None when the row carries none."""
    if not row.limited:
        return None
    out: dict = {}
    if row.limit_at is not None:
        out["at"] = row.limit_at.isoformat()
    if row.limit_again is not None:
        out["again"] = row.limit_again
    if row.limit_self_resume is not None:
        out["self_resume"] = row.limit_self_resume
    if row.limit_held is not None:  # story #4560: the device list and the DM header read it from here
        out["held"] = row.limit_held
    return out


def _check_seq_range(seq: int) -> None:
    """story #4554 ③: the columns are int4 — a number past them is refused as a number (422), not met as a DB error (500)."""
    if seq > INT32_MAX:
        raise DesktopRelayError(422, "report_seq_out_of_range", f"report_seq must be at most {INT32_MAX}")


async def _prune_expired(db: AsyncSession, setup_id: uuid.UUID, *, now: datetime) -> None:
    """story #4554 ① (PO 11:45Z): an ended session is kept ENDED_SESSION_RETENTION, then goes with the device's next report (no
    sweep job — the write path cleans its own device, under the device row's lock)."""
    from sqlalchemy import delete

    await db.execute(delete(DesktopSession).where(
        DesktopSession.setup_id == setup_id, DesktopSession.state == "stopped", DesktopSession.ended_at.is_not(None),
        DesktopSession.ended_at < now - ENDED_SESSION_RETENTION,
    ))


async def _make_room(db: AsyncSession, setup_id: uuid.UUID, *, new_rows: int) -> None:
    """story #4554 ①: if `new_rows` more rows would take the device past SESSION_ROWS_PER_DEVICE, the oldest ended rows go first;
    live rows are never dropped — when they alone fill the device, a new key is refused (422 `too_many_sessions`, nothing written)."""
    from sqlalchemy import delete

    total = (await db.execute(select(func.count()).select_from(DesktopSession).where(DesktopSession.setup_id == setup_id))).scalar_one()
    over = total + new_rows - SESSION_ROWS_PER_DEVICE
    if over <= 0:
        return
    oldest_ended = (await db.execute(
        select(DesktopSession.id).where(DesktopSession.setup_id == setup_id, DesktopSession.state == "stopped")
        .order_by(DesktopSession.ended_at.asc().nulls_first(), DesktopSession.created_at.asc()).limit(over)
    )).scalars().all()
    if oldest_ended:
        await db.execute(delete(DesktopSession).where(DesktopSession.id.in_(oldest_ended)))
    if len(oldest_ended) < over:
        raise DesktopRelayError(422, "too_many_sessions", f"a device keeps at most {SESSION_ROWS_PER_DEVICE} sessions")


async def record_session_state(db: AsyncSession, setup: DesktopSetup, session_key: str, report: SessionStateReport) -> DesktopSession:
    """A report older than (or equal to) the device's latest is refused — 409 (a reordered delivery never undoes a newer one)."""
    _check_agent(setup, report.agent_member_id)
    _check_seq_range(report.report_seq)
    latest = await _lock_device_seq(db, setup.id)
    if report.report_seq <= latest:
        raise DesktopRelayError(409, "stale_report", f"report_seq {report.report_seq} is not after {latest}")
    await _prune_expired(db, setup.id, now=_now())  # story #4554 ①
    row = (await db.execute(
        select(DesktopSession).where(DesktopSession.setup_id == setup.id, DesktopSession.session_key == session_key)
    )).scalar_one_or_none()
    if row is None:
        await _make_room(db, setup.id, new_rows=1)  # story #4554 ①
        row = DesktopSession(id=uuid.uuid4(), setup_id=setup.id, session_key=session_key)
        db.add(row)
    row.agent_member_id, row.runtime, row.state = report.agent_member_id, report.runtime, report.state
    row.last_report_seq, row.state_at = report.report_seq, report.at
    row.ended_at = report.at if report.state == "stopped" else None
    _set_limit(row, report.limit)
    _set_system(row, report)  # story #4599
    row.instruct_now = report.instruct_now  # story #4534: each report sets it — a report without it clears it (Kadir 06:31Z (c))
    await touch_device(db, setup.id)
    await db.flush()
    from app.services.desktop_commands import on_session_reported  # story #4534 — a [지금 지시]'s turn end

    await on_session_reported(db, setup, session_key, report.state, report.at)
    return row


async def replace_sessions(db: AsyncSession, setup: DesktopSetup, snapshot: SessionSnapshot) -> int:
    """The whole list (after a reconnect): the given sessions as reported; a session the device no longer lists is stopped.

    story #4554 ③ (PO 11:45Z): a snapshot is the daemon's whole truth, so it **resets the device's report baseline** — a lower
    `report_seq` is taken and becomes the new baseline (a daemon whose state file went back to 0 is not refused for ever); the
    single-state report keeps its strict «after the latest» rule."""
    for s in snapshot.sessions:
        _check_agent(setup, s.agent_member_id)
    _check_seq_range(snapshot.report_seq)
    keys = [s.session_key for s in snapshot.sessions]
    if len(set(keys)) != len(keys):
        raise DesktopRelayError(422, "duplicate_session_key", "a session key appears twice")
    await _lock_device_seq(db, setup.id)  # the device row's lock — two reports at once are ordered
    now = _now()
    await _prune_expired(db, setup.id, now=now)  # story #4554 ①
    existing = {r.session_key: r for r in (await db.execute(
        select(DesktopSession).where(DesktopSession.setup_id == setup.id)
    )).scalars().all()}
    await _make_room(db, setup.id, new_rows=sum(1 for s in snapshot.sessions if s.session_key not in existing))  # story #4554 ①
    kept = set((await db.execute(select(DesktopSession.id).where(DesktopSession.setup_id == setup.id))).scalars().all())
    existing = {k: r for k, r in existing.items() if r.id in kept}  # an ended row _make_room dropped is not written again
    for s in snapshot.sessions:
        row = existing.pop(s.session_key, None)
        if row is None:
            row = DesktopSession(id=uuid.uuid4(), setup_id=setup.id, session_key=s.session_key)
            db.add(row)
        row.agent_member_id, row.runtime, row.state, row.state_at = s.agent_member_id, s.runtime, s.state, s.at
        row.last_report_seq = snapshot.report_seq
        row.ended_at = s.at if s.state == "stopped" else None
        _set_limit(row, s.limit)
        _set_system(row, s)  # story #4599
        row.instruct_now = s.instruct_now
    for row in existing.values():
        row.last_report_seq = snapshot.report_seq
        if row.state != "stopped":
            row.state, row.state_at, row.ended_at = "stopped", now, now
            _set_limit(row, None)
            row.system_folder = None  # story #4599: a dropped session holds no window
            row.instruct_now = None
    await touch_device(db, setup.id)
    await db.flush()
    from app.services.desktop_commands import on_session_reported  # story #4534 — every line of a snapshot is a report too

    for s in snapshot.sessions:
        await on_session_reported(db, setup, s.session_key, s.state, s.at)
    for row in existing.values():
        await on_session_reported(db, setup, row.session_key, "stopped", now)
    return len(snapshot.sessions)


async def device_sessions_view(
    db: AsyncSession, setup_id: uuid.UUID, *, now: datetime | None = None, limit: int = SESSIONS_PAGE_DEFAULT,
) -> list[dict]:
    """The sessions as a person sees them: each one's reported state, or `unknown` for all when the device has been silent
    longer than UNKNOWN_AFTER (never «dead» — the device may come back and send its list).

    story #4554 ④: «heard from» counts the device's live token only — a disconnected device (its token revoked) is silent at once,
    not for the 90 seconds its last heartbeat would have covered. ①: live rows first, newest first, `limit` of them."""
    now = now or _now()
    last_heard = (await db.execute(
        select(func.max(DesktopDeviceToken.last_used_at))
        .where(DesktopDeviceToken.setup_id == setup_id, DesktopDeviceToken.revoked_at.is_(None))
    )).scalar_one_or_none()
    silent = last_heard is None or now - last_heard > UNKNOWN_AFTER
    rows = (await db.execute(
        select(DesktopSession).where(DesktopSession.setup_id == setup_id)
        .order_by((DesktopSession.state == "stopped").asc(), DesktopSession.state_at.desc(), DesktopSession.created_at.desc())
        .limit(max(1, min(limit, SESSIONS_PAGE_MAX)))
    )).scalars().all()
    return [{
        "session_key": r.session_key, "agent_member_id": str(r.agent_member_id), "runtime": r.runtime,
        "state": "unknown" if silent and r.state != "stopped" else legacy_state(r.state), "state_at": r.state_at.isoformat(),
        # story #4534: the board's own word (eight) and a usage limit's why — for the new web only
        "activity": "unknown" if silent and r.state != "stopped" else r.state,
        **({"limit": lv} if not silent and (lv := limit_view(r)) is not None else {}),
        # story #4599: a held turn's why (the window's folder) — for the new web only, and only while the device is heard
        **({"system": sv} if not silent and (sv := system_view(r)) is not None else {}),
        # story #4534 (PO 06:30Z): whether [지금 지시] can go into its turn — not said for a device not heard (Kadir 06:31Z (c))
        "instruct_now": None if silent else r.instruct_now,
    } for r in rows]


# ── commands ─────────────────────────────────────────────────────────────────────────────────────────────────────────────────


class _Payload(BaseModel):
    model_config = ConfigDict(extra="forbid")


class StartSessionPayload(_Payload):
    agent_member_id: uuid.UUID
    runtime: Literal["claude", "codex"]


class SendPromptPayload(_Payload):
    session_key: str = Field(pattern=SESSION_KEY_PATTERN)
    text: str = Field(min_length=1, max_length=PROMPT_MAX)
    # story #4534 (contract v1.9) — the conversation the agent answers in, and the phone's signed blob (its conversation_id
    # and text hash inside — the daemon wraps «this conversation» from the signed value only); carried as is
    conversation_id: uuid.UUID
    signed: str = Field(min_length=1, max_length=16384)


class AnswerApprovalPayload(_Payload):
    session_key: str = Field(pattern=SESSION_KEY_PATTERN)
    request_id: str = Field(min_length=1, max_length=128)
    decision: Literal["allow", "deny"]
    signed: str = Field(min_length=1, max_length=16384)  # the phone's signed blob, carried as is (B-2) — never made or changed here
    # story #4580 AC2 B: a network question's second answer — the host the person saw (the row's own value); the daemon checks it
    # against what it reported and what the phone signed
    stage: Literal["confirm"] | None = None
    host: str | None = Field(default=None, min_length=1, max_length=253)


class StopSessionPayload(_Payload):
    session_key: str = Field(pattern=SESSION_KEY_PATTERN)
    signed: str = Field(min_length=1, max_length=16384)  # story #4534 — every command a person makes is signed (contract v1.9.1)


class EndSessionPayload(_Payload):
    """story #4599 (contract v1.13.2 · PO 14:08Z): the whole session ended — the stop's shape, its own kind (the phone signs
    `kind: end_session`, so what was signed is what happens; the daemon never turns a stop into this)."""

    session_key: str = Field(pattern=SESSION_KEY_PATTERN)
    signed: str = Field(min_length=1, max_length=16384)


PAYLOAD_SCHEMAS: dict[str, type[_Payload]] = {
    "start_session": StartSessionPayload,
    "send_prompt": SendPromptPayload,
    "answer_approval": AnswerApprovalPayload,
    "stop_session": StopSessionPayload,
    "end_session": EndSessionPayload,
}
assert tuple(PAYLOAD_SCHEMAS) == COMMAND_KINDS, "every command kind has one payload schema"


def validate_payload(kind: str, payload: dict) -> _Payload:
    schema = PAYLOAD_SCHEMAS.get(kind)
    if schema is None:
        raise DesktopRelayError(422, "unknown_command_kind", f"{kind!r} is not a command kind")
    try:
        return schema.model_validate(payload)
    except ValidationError as exc:
        raise DesktopRelayError(422, "invalid_payload", exc.errors(include_url=False, include_input=False)[0]["msg"]) from exc


async def enqueue_command(
    db: AsyncSession, *, setup: DesktopSetup, kind: str, payload: dict, idempotency_key: str, requested_by: uuid.UUID,
) -> DesktopCommand:
    """The one way a command is made (the person-facing endpoints come with B-2 · B-3 · B-4). The same idempotency key again
    returns the first row; the device's next number is taken under its row's lock."""
    from app.services import remote_control

    # story #4535 — no command is made while the org's «원격 제어» is off (the B-2/B-3 endpoints come through here)
    if not await remote_control.is_enabled(db, setup.org_id):
        raise DesktopRelayError(409, remote_control.OFF_CODE, "remote control is off for this organization")
    parsed = validate_payload(kind, payload)
    if isinstance(parsed, StartSessionPayload):
        _check_agent(setup, parsed.agent_member_id)
    if not 1 <= len(idempotency_key) <= 128:
        raise DesktopRelayError(422, "invalid_idempotency_key", "an idempotency key of 1 to 128 characters")
    existing = (await db.execute(
        select(DesktopCommand).where(DesktopCommand.setup_id == setup.id, DesktopCommand.idempotency_key == idempotency_key)
    )).scalar_one_or_none()
    if existing is not None:
        return existing
    seq = (await db.execute(
        update(DesktopSetup).where(DesktopSetup.id == setup.id)
        .values(relay_command_seq=DesktopSetup.relay_command_seq + 1)
        .returning(DesktopSetup.relay_command_seq)
    )).scalar_one()
    body = parsed.model_dump(mode="json")
    if kind == "answer_approval":  # story #4580: a first answer carries no stage · host (the same bytes as before)
        body = {k: v for k, v in body.items() if not (k in ("stage", "host") and v is None)}
    cmd = DesktopCommand(
        id=uuid.uuid4(), setup_id=setup.id, device_seq=seq, kind=kind, session_key=body.get("session_key"), payload=body,
        idempotency_key=idempotency_key, requested_by=requested_by, state="queued",
        conversation_id=_uuid_or_none(body.get("conversation_id")),
    )
    db.add(cmd)
    await db.flush()
    _schedule_wake_after_commit(db, setup.id, seq)
    return cmd


def _uuid_or_none(value) -> uuid.UUID | None:
    return uuid.UUID(str(value)) if value else None


async def commands_to_send(db: AsyncSession, setup_id: uuid.UUID, after_seq: int) -> list[DesktopCommand]:
    """The device's commands after `after_seq` not yet acknowledged (at least once: a reconnect from an older id sends them
    again — the daemon drops a command_id it has seen). Queued ones become delivered."""
    rows = (await db.execute(
        select(DesktopCommand)
        .where(DesktopCommand.setup_id == setup_id, DesktopCommand.device_seq > after_seq,
               DesktopCommand.state.in_(("queued", "delivered")))
        .order_by(DesktopCommand.device_seq)
        .limit(100)
    )).scalars().all()
    now = _now()
    for r in rows:
        if r.state == "queued":
            r.state, r.delivered_at = "delivered", now
    await db.flush()
    return rows


class CommandResult(BaseModel):
    model_config = ConfigDict(extra="forbid")

    state: Literal["acked", "done", "failed", "rejected"]
    result_code: str | None = Field(default=None, pattern=r"^[a-z0-9_]{1,64}$")


async def record_command_result(db: AsyncSession, setup: DesktopSetup, command_id: uuid.UUID, result: CommandResult) -> DesktopCommand:
    cmd = (await db.execute(
        select(DesktopCommand).where(DesktopCommand.id == command_id, DesktopCommand.setup_id == setup.id).with_for_update()
    )).scalar_one_or_none()
    if cmd is None:
        raise DesktopRelayError(404, "command_not_found", "no such command on this device")
    if COMMAND_STATE_ORDER[result.state] <= COMMAND_STATE_ORDER[cmd.state]:
        raise DesktopRelayError(409, "state_not_forward", f"{cmd.state} → {result.state} does not move forward")
    now = _now()
    cmd.state, cmd.result_code = result.state, result.result_code
    if result.state == "acked":
        cmd.acked_at = now
    else:
        cmd.acked_at = cmd.acked_at or now
        cmd.finished_at = now
    if cmd.kind == "answer_approval":  # story #4533 — the daemon's verdict on a phone's signed answer moves the request
        from app.services.agent_permissions import on_answer_result

        # story #4580 (Kadir 02:08Z): the stage the command answered — a late result of the first answer never moves the second
        stage = "confirm" if (cmd.payload or {}).get("stage") == "confirm" else "ask"
        await on_answer_result(db, setup.id, (cmd.payload or {}).get("request_id"), result.state, result.result_code, stage=stage)
    # story #4534 — a stop done closes that session's waiting instructions (no turn-end notice); an instruction done writes its line;
    # story #4599 — an end of the session done closes them the same way
    if cmd.kind in ("stop_session", "send_prompt", "end_session"):
        from app.services.desktop_commands import on_command_done

        await on_command_done(db, cmd)
    await touch_device(db, setup.id)
    await db.flush()
    return cmd


# ── wake: the agent stream's own (PO 05:43Z) ─────────────────────────────────────────────────────────────────────────────
# The device stream's queue sits in the agent gateway's connection map under `desktop:<setup_id>` (never an agent's UUID), so
# `wake_agent` reaches it as it reaches an agent: this instance at once, every other instance through the same backplane
# (Redis or pg_notify) → its listener → `_push_to_agent`. The wake carries no command — the stream reads them from the DB.


def wake_key(setup_id: uuid.UUID) -> str:
    return f"desktop:{setup_id}"


async def reject_open_commands(db: AsyncSession, *, setup_id: uuid.UUID, result_code: str) -> int:
    """story #4554 ④ (PO 11:45Z · the same shape as remote_control.set_enabled's off): a disconnected device's open commands
    (`queued` · `delivered`) end as `rejected` with the reason — nothing waits for a device that will not come back."""
    now = _now()
    rejected = (await db.execute(
        update(DesktopCommand)
        .where(DesktopCommand.setup_id == setup_id, DesktopCommand.state.in_(("queued", "delivered")))
        .values(state="rejected", result_code=result_code, finished_at=now)
        .returning(DesktopCommand.id)
    )).scalars().all()
    return len(rejected)


def _fire_disconnected(setup_id: uuid.UUID) -> None:
    """story #4554 ④: the device's open stream is told now — it rechecks and ends with `access_revoked` at once, not at its next
    30-second check. Carried like a wake (this instance at once · other instances through the same backplane); the stream reads the
    mark, never the payload's words."""
    from app.routers.events import _push_to_agent

    try:
        _push_to_agent(wake_key(setup_id), {"__wake__": True, "seq": 0, DISCONNECTED_CODE: True})
    except Exception:  # noqa: BLE001 — the stream's 30-second recheck still ends it
        logger.warning("desktop relay disconnect signal failed setup=%s", setup_id, exc_info=True)


def schedule_disconnected_after_commit(db: AsyncSession, setup_id: uuid.UUID) -> None:
    """After the disconnect's commit only (before it, the stream's recheck would still find the device valid)."""
    if not isinstance(db.sync_session, Session):
        return
    from app.services.after_commit import schedule_after_commit

    schedule_after_commit(db, [functools.partial(_fire_disconnected, setup_id)])


def _fire_wake(setup_id: uuid.UUID, seq: int) -> None:
    from app.routers.agent_gateway import wake_agent

    try:
        wake_agent(wake_key(setup_id), seq)
    except Exception:  # noqa: BLE001 — a missed wake waits for the stream's backstop read, never loses the command
        logger.warning("desktop relay wake failed setup=%s", setup_id, exc_info=True)


def _schedule_wake_after_commit(db: AsyncSession, setup_id: uuid.UUID, seq: int) -> None:
    """After the command's commit only (before it, the stream's read would not see the row)."""
    if not isinstance(db.sync_session, Session):
        return
    from app.services.after_commit import schedule_after_commit

    schedule_after_commit(db, [functools.partial(_fire_wake, setup_id, seq)])
