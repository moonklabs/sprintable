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
import re
import secrets
import unicodedata
import uuid
from datetime import datetime, timedelta, timezone
from typing import Literal

from pydantic import BaseModel, ConfigDict, Field, StrictBool, ValidationError, field_validator, model_validator
from sqlalchemy import delete, func, or_, select, update
from sqlalchemy.ext.asyncio import AsyncSession
from sqlalchemy.orm import Session

from app.models.desktop_relay import (
    COMMAND_KINDS,
    COMMAND_STATE_ORDER,
    DesktopClockView,
    DesktopCommand,
    DesktopDeviceToken,
    DesktopSession,
    SESSION_LIMIT_STATES,
    SESSION_WIDENED_MODES,
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
# story #4554 2선 (Kadir 5002 ② · PO 04:03Z): a report's `at` is the device's clock — one past now + this is held down to now. Not
# refused: a state report's 422 is retried as is (desktop-host relay/client.ts), so a fast clock would freeze that device's board for
# good. A future `at` stored as is would also keep a stopped row past ENDED_SESSION_RETENTION for ever (2099 measured).
REPORT_CLOCK_SKEW = timedelta(minutes=5)
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
    # story #4714: the same for the startable report number — a daemon that starts again must not be ignored for ever by the number its predecessor reached
    await db.execute(update(DesktopSetup).where(DesktopSetup.id == setup_id).values(startable_seq=None))
    # story #4733: and for the clock view — a daemon that starts again must not be ignored for ever by its predecessor's number, nor show its predecessor's
    # view or claim an older app's `supported`; the view goes with the old token (the new daemon reports its own, and one `none` at start)
    await db.execute(update(DesktopSetup).where(DesktopSetup.id == setup_id).values(clock_view_seq=None, clock_seen_at=None))
    await db.execute(delete(DesktopClockView).where(DesktopClockView.setup_id == setup_id))
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
    """The device a token belongs to — None for no token, another shape, an unknown or revoked token, a disconnected device, a device whose confirming
    person's account is closed or deleted (story #4767), or whose confirming person was REMOVED from the device's organization (story #4769: the account
    lives on but the seat is gone — a computer belongs to a person in an organization, and a person who left it owns no computer there; this also covers the
    rows older removals and deletions left). A confirmer with no `org_members` row for (organization, person) at all is refused too (PO 4769, fail-closed: every
    confirmation path needs a live owner/admin seat and nothing hard-deletes one, so such a row cannot come from a live path and an open door there would stay quietly
    open the day someone adds a hard delete). Not judged: a setup with no confirmer recorded, and a confirmer with no `users` row (`confirmed_by` has no foreign key;
    the 4618 relay contract serves them)."""
    from app.models.project import OrgMember
    from app.models.user import User

    if not token or not token.startswith(TOKEN_PREFIX):
        return None
    row = (await db.execute(
        select(DesktopDeviceToken, DesktopSetup, User.is_active, User.deleted_at, OrgMember.id, OrgMember.deleted_at)
        .join(DesktopSetup, DesktopSetup.id == DesktopDeviceToken.setup_id)
        .outerjoin(User, User.id == DesktopSetup.confirmed_by)
        .outerjoin(OrgMember, (OrgMember.org_id == DesktopSetup.org_id) & (OrgMember.user_id == DesktopSetup.confirmed_by))
        .where(DesktopDeviceToken.token_hash == _hash(token))
    )).first()
    if row is None:
        return None
    tok, setup, person_active, person_deleted_at, seat_id, seat_deleted_at = row
    if not hmac.compare_digest(tok.token_hash, _hash(token)):
        return None
    if tok.revoked_at is not None or setup.revoked_at is not None or setup.exchanged_at is None:
        return None
    if person_active is False or person_deleted_at is not None:  # a closed account, a deleted one: the same refusal (no user row: person_active is None — not judged)
        return None
    if setup.confirmed_by is not None and (seat_id is None or seat_deleted_at is not None):  # removed from this organization, or no seat row at all (fail-closed)
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
    """An open stream asks again: a disconnect (device revoked · its token revoked · its confirming person's account gone — story #4767 — or removed from the
    organization — story #4769) ends it."""
    from app.models.project import OrgMember
    from app.models.user import User

    row = (await db.execute(
        select(
            DesktopSetup.revoked_at, func.count(DesktopDeviceToken.id), User.is_active, User.deleted_at, OrgMember.id, OrgMember.deleted_at, DesktopSetup.confirmed_by,
        )
        .select_from(DesktopSetup)
        .outerjoin(DesktopDeviceToken, (DesktopDeviceToken.setup_id == DesktopSetup.id) & DesktopDeviceToken.revoked_at.is_(None))
        .outerjoin(User, User.id == DesktopSetup.confirmed_by)
        .outerjoin(OrgMember, (OrgMember.org_id == DesktopSetup.org_id) & (OrgMember.user_id == DesktopSetup.confirmed_by))
        .where(DesktopSetup.id == setup_id)
        .group_by(DesktopSetup.revoked_at, User.is_active, User.deleted_at, OrgMember.id, OrgMember.deleted_at, DesktopSetup.confirmed_by)
    )).first()
    if row is None or row[0] is not None or row[1] <= 0 or row[2] is False or row[3] is not None:
        return False
    return row[6] is None or (row[4] is not None and row[5] is None)  # a recorded confirmer needs a live seat (fail-closed: no row at all is refused too)


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
    # story #4685 (PO 10-14 00:39Z · additive): this daemon looks at the limit again by itself (reset time unknown) — `true` or absent;
    # a `false` is not a word of the contract (422), so «not looking» is only ever the absence
    looks: Literal[True] | None = None


RUN_EFFORTS = ("low", "medium", "high", "xhigh", "max", "ultra")
# story #4686: a Claude model id as the run profile takes it — the one rule (services.agent_run_profile.CLAUDE_MODEL_NAME), which also
# admits the other runtime's names (a subset); the optional «[1m]» tail is kept as it is
_RUN_MODEL = re.compile(r"^[A-Za-z0-9][A-Za-z0-9._:/-]{0,63}(\[1m\])?$")
# story #4686 (Kadir 5073 · PO 10-14 02:0xZ — «an allow-list first, not a refusal list»): the account label is only what the daemon builds —
# after NFKC (a fullwidth «＠» is an «@»): ① a MASKED address — one or two address characters, «***», the host (`yo***@host.tld`) — or ② an
# organisation name (letters · digits · spaces · a few marks, ≤ 50, no «@» · «*» · «(»), then optionally « (Plan)» from a CLOSED set of words.
# Anything else (an address of any length, a token, a free sentence) is refused — so a new way of writing a secret does not need a new rule.
ACCOUNT_PLANS = ("Free", "Pro", "Max", "Team", "Enterprise")
_ACCOUNT_MASKED = r"[A-Za-z0-9.+_%-]{1,2}\*\*\*@[A-Za-z0-9](?:[A-Za-z0-9.-]{0,60}[A-Za-z0-9])?\.[A-Za-z]{2,}"
_ACCOUNT_ORG = r"[^\W_][\w .,&'\u2019\u00b7+/:-]{0,49}"
_ACCOUNT_LABEL = re.compile(rf"^(?:{_ACCOUNT_MASKED}|{_ACCOUNT_ORG})(?: \((?:{'|'.join(ACCOUNT_PLANS)})\))?$")
# the second layer: token shapes an organisation name could still spell (the allow-list admits letters and digits)
_ACCOUNT_SECRET_SHAPES = (
    re.compile(r"\bsk-[A-Za-z0-9-]{10,}"),
    re.compile(r"\bBearer\s", re.IGNORECASE),
    re.compile(r"\beyJ[A-Za-z0-9_-]{8,}"),
    re.compile(r"[A-Za-z0-9+/=_-]{32,}"),
    # a link (Kadir 5073 probe, PO 10-14): the name's marks «:» and «/» are for «R&D/Ops» — «://» makes it an address a reader could follow
    re.compile(r"://"),
)


class SessionRun(BaseModel):
    """story #4686 (PO 10-14 01:06Z · Yuna run-info-1014.md): what a session really runs on — shown on the board, the phone and the web.
    `model` the model that ran (the transcript's last real assistant line; else the profile's) · `model_set` whether the profile
    NAMED a model (false = the runtime's default ran — 10-13) · `effort` the thinking depth the profile gave (a closed word; absent =
    the default) · `account` the account's display label, Claude only, already masked by the daemon (never an e-mail written out)."""

    model_config = ConfigDict(extra="forbid")

    model: str | None = Field(default=None, max_length=70)
    model_set: StrictBool | None = None
    effort: Literal["low", "medium", "high", "xhigh", "max", "ultra"] | None = None
    account: str | None = Field(default=None, min_length=1, max_length=80)

    @model_validator(mode="after")
    def _closed_shapes(self) -> "SessionRun":
        if self.model is not None and not _RUN_MODEL.fullmatch(self.model):  # (fullmatch: a `$` also takes a trailing newline)
            raise ValueError("model is not a model id")
        if self.account is not None:
            if any(unicodedata.category(ch) in ("Cc", "Cf", "Zl", "Zp", "Co", "Cs") for ch in self.account) or self.account != self.account.strip():
                raise ValueError("account carries a control, invisible or edge-space character")
            # NFKC first: the shapes below are read on what the label MEANS (a fullwidth «＠» is an «@»), and that is what is kept
            account = unicodedata.normalize("NFKC", self.account)
            if len(account) > 80 or not _ACCOUNT_LABEL.fullmatch(account):
                raise ValueError("account is not a label the daemon makes (a masked address or an organisation name, then a plan word)")
            if any(shape.search(account) for shape in _ACCOUNT_SECRET_SHAPES):
                raise ValueError("account carries a token shape")
            self.account = account
        return self


class SystemHold(BaseModel):
    """story #4599 (contract v1.13 · Kadir lens ③): why a `waiting_system` turn waits — the folder the macOS window asks about, when
    the daemon read it (tccd's service name → a closed list); absent when the window was seen by its owner alone. Never a path."""

    model_config = ConfigDict(extra="forbid")

    folder: Literal["documents", "desktop", "downloads", "network_volume", "icloud"] | None = None


class SessionInbox(BaseModel):
    """story #4684 (0454 · Yuna ux1-copy §L ②③): why THIS computer's subscription for the agent is stopped — the app board's own closed words.
    A stopped session keeps none (accepted like `run`, never stored or shown — it receives nothing to explain); absent = receiving, or not said."""

    model_config = ConfigDict(extra="forbid")

    stream: Literal["stopped_other_receiver", "stopped_taken_over", "stopped_auth", "stopped_inbox_full"]


# story #4641 (design 4641 · 0449): a mode a person widened at the terminal — the same closed list as the model (a test holds them together)
WidenedMode = Literal["plan", "default", "acceptEdits", "auto", "dontAsk", "bypassPermissions"]
# a widening stamped further ahead of the server's clock than this is not believed: the three keys are dropped, never kept (a
# far-future `at` would pin the newer-wins rule for good)
WIDENED_MAX_AHEAD = timedelta(minutes=5)


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
    # story #4686: what it runs on — each report sets it (a report without it clears it, like `instruct_now`)
    run: SessionRun | None = None
    # story #4599: the window's folder — with `waiting_system` only (the validator below)
    system: SystemHold | None = None
    # story #4684: why this computer's subscription for the agent is stopped — each report sets it (a report without it clears it: it receives again)
    inbox: SessionInbox | None = None
    # story #4641: a widening a person made at the terminal — the three together or none; the daemon decides the order (from ≠ to only)
    permission_widened_at: OffsetDatetime | None = None
    permission_widened_from: WidenedMode | None = None
    permission_widened_to: WidenedMode | None = None
    # story #4534 (0438 · PO 06:30Z): whether this session can take an instruction into the running turn — read by the daemon once
    # when the session starts. It only hides [지금 지시] on the web; the daemon decides again when an instruction comes (Kadir 06:31Z)
    instruct_now: StrictBool | None = None  # a boolean only — never «yes» · 1 read as true

    @model_validator(mode="after")
    def _limit_on_a_limit_word_only(self) -> "SessionReport":
        if self.limit is not None and self.state not in SESSION_LIMIT_STATES:
            raise ValueError("limit is carried with waiting_input · error · paused_limit only")
        if self.system is not None and self.state != "waiting_system":
            raise ValueError("system is carried with waiting_system only")
        widened = (self.permission_widened_at, self.permission_widened_from, self.permission_widened_to)
        if any(v is not None for v in widened) and not all(v is not None for v in widened):
            raise ValueError("permission widening: the at, from and to come together or not at all")
        if self.permission_widened_from is not None and self.permission_widened_from == self.permission_widened_to:
            raise ValueError("permission widening: from and to are the same mode")
        return self


class SessionStateReport(SessionReport):
    report_seq: int = Field(ge=1)


class SnapshotSession(SessionReport):
    session_key: str = Field(pattern=SESSION_KEY_PATTERN)


class SessionSnapshot(BaseModel):
    model_config = ConfigDict(extra="forbid")

    report_seq: int = Field(ge=1)
    sessions: list[SnapshotSession] = Field(max_length=64)


STARTABLE_MAX = 128


class StartableItem(BaseModel):
    model_config = ConfigDict(extra="forbid")

    agent_member_id: uuid.UUID
    project_id: uuid.UUID


class StartableSnapshot(BaseModel):
    """story #4714: the computer's own list of the (agent, project) pairs it has a usable folder for — ids only (a path has no place in
    it: every body forbids extra fields). Replaces the whole list; the computer decides at the start, this is what the phone is shown."""
    model_config = ConfigDict(extra="forbid")

    startable: list[StartableItem] = Field(max_length=STARTABLE_MAX)
    # story #4714 (PO 10-18): the computer numbers its reports (one that only grows, even across a restart); the server keeps the highest it has applied
    # and ignores a lower one — a request the computer gave up but that reached the server late cannot cover a newer list. Absent = an older app: applied as before.
    seq: int | None = Field(default=None, ge=1, le=2**62, strict=True)
    # story #4734 (B): this computer's app knows the press of the WHOLE computer (the `computer` mark of a clock press) — a closed word, sent with every list; absent = an app from before.
    # The server keeps it in the setup's `capabilities` and tells the phone's list (`computer_press`), so a screen offers the one button only for a Mac that can take it.
    computer_press: StrictBool | None = None  # (the boolean true and nothing else: 1 · "true" · false are refused below)

    @field_validator("computer_press")
    @classmethod
    def _only_true(cls, v: bool | None) -> bool | None:
        if v is False:
            raise ValueError("computer_press is the word true, or absent")
        return v


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
    row.limit_looks = True if limit and limit.looks else None  # story #4685


def _set_run(row: DesktopSession, run: SessionRun | None) -> None:
    """story #4686: the row's run info is the report's — a report without it clears it (the reader then says nothing, never a stale value)."""
    row.run_model = run.model if run else None
    row.run_model_set = run.model_set if run else None
    row.run_effort = run.effort if run else None
    row.run_account = run.account if run else None


def _set_inbox(row: DesktopSession, inbox: SessionInbox | None) -> None:
    """story #4684: the row's receive stop is the report's — a report without it clears it (this computer receives again)."""
    row.inbox_stream = inbox.stream if inbox else None


def inbox_view(row: DesktopSession) -> dict | None:
    """story #4684: a row's receive stop as a reader sees it — None when the row says none."""
    return {"stream": row.inbox_stream} if row.inbox_stream is not None else None


def run_view(row: DesktopSession) -> dict | None:
    """story #4686: a row's run info as a reader sees it (only what is set) — None when the row says none."""
    out: dict = {}
    if row.run_model is not None:
        out["model"] = row.run_model
    if row.run_model_set is not None:
        out["model_set"] = row.run_model_set
    if row.run_effort is not None:
        out["effort"] = row.run_effort
    if row.run_account is not None:
        out["account"] = row.run_account
    return out or None


def _set_system(row: DesktopSession, report: SessionReport) -> None:
    """story #4599: the window's folder is the report's — any other word (the hold is over) clears it."""
    row.system_folder = report.system.folder if report.state == "waiting_system" and report.system else None


def _set_widened(row: DesktopSession, report: SessionReport, now: datetime, *, was_stopped: bool = False) -> None:
    """story #4641: the latest widening is the report's, by its `at` — a report without one keeps what is stored (its clock is the
    daemon's and only a newer `at` replaces); a fresh start holds none: a `starting` report, or a live report on a row that had
    ended (`was_stopped` — a new session under the same key, Kadir's lens ③); an `at` past the bound is dropped with a log line."""
    if report.state == "starting" or (was_stopped and report.state != "stopped"):
        row.permission_widened_at = row.permission_widened_from = row.permission_widened_to = None
        return
    if report.permission_widened_at is None:
        return
    if report.permission_widened_at > now + WIDENED_MAX_AHEAD:
        logger.info("relay.widened_ahead_dropped session=%s", row.session_key)
        return
    if row.permission_widened_at is not None and report.permission_widened_at <= row.permission_widened_at:
        return
    row.permission_widened_at = report.permission_widened_at
    row.permission_widened_from = report.permission_widened_from
    row.permission_widened_to = report.permission_widened_to


def widened_view(row: DesktopSession) -> dict:
    """story #4641: the widening as a reader sees it — the three keys, only while one is stored."""
    if row.permission_widened_at is None:
        return {}
    return {
        "permission_widened_at": row.permission_widened_at.isoformat(),
        "permission_widened_from": row.permission_widened_from,
        "permission_widened_to": row.permission_widened_to,
    }


def widened_fields(row: DesktopSession, silent: bool) -> dict:
    """story #4641: the reader's keys — only while the device is heard (a silent device's keys are not said, as the other facts)."""
    return {} if silent else widened_view(row)


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
    if row.limit_looks:  # story #4685: the phone and the web say «the app checks again» only when this is here
        out["looks"] = True
    return out


def _check_seq_range(seq: int) -> None:
    """story #4554 ③: the columns are int4 — a number past them is refused as a number (422), not met as a DB error (500)."""
    if seq > INT32_MAX:
        raise DesktopRelayError(422, "report_seq_out_of_range", f"report_seq must be at most {INT32_MAX}")


def _reported_at(at: datetime, now: datetime) -> datetime:
    """story #4554 2선: the device's `at`, or now when it is past now + REPORT_CLOCK_SKEW (see the constant)."""
    return now if at > now + REPORT_CLOCK_SKEW else at


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
        raise _stale(report.report_seq, latest)
    now = _now()
    await _prune_expired(db, setup.id, now=now)  # story #4554 ①
    at = _reported_at(report.at, now)  # story #4554 2선
    row = (await db.execute(
        select(DesktopSession).where(DesktopSession.setup_id == setup.id, DesktopSession.session_key == session_key)
    )).scalar_one_or_none()
    if row is None:
        await _make_room(db, setup.id, new_rows=1)  # story #4554 ①
        row = DesktopSession(id=uuid.uuid4(), setup_id=setup.id, session_key=session_key)
        db.add(row)
    was_stopped = row.state == "stopped"  # captured before the row takes the new word (the new session under the same key)
    row.agent_member_id, row.runtime, row.state = report.agent_member_id, report.runtime, report.state
    row.last_report_seq, row.state_at = report.report_seq, at
    row.ended_at = at if report.state == "stopped" else None
    was_limited = bool(row.limited)  # story #4685: read before this report overwrites it — the notice follows the move into / out of a limit
    _set_limit(row, report.limit)
    _set_run(row, report.run)  # story #4686
    _set_inbox(row, report.inbox if report.state != "stopped" else None)  # story #4684
    _set_system(row, report)  # story #4599
    _set_widened(row, report, _now(), was_stopped=was_stopped)  # story #4641
    row.instruct_now = report.instruct_now  # story #4534: each report sets it — a report without it clears it (Kadir 06:31Z (c))
    await touch_device(db, setup.id)
    await db.flush()
    from app.services.desktop_commands import on_session_reported  # story #4534 — a [지금 지시]'s turn end
    from app.services.desktop_limit_notice import after_report  # story #4685 — the person who connected the computer is told

    await on_session_reported(db, setup, session_key, report.state, at)
    await after_report(db, setup, row, was_limited=was_limited)
    return row


def _stale(seq: int, latest: int) -> DesktopRelayError:
    """story #4554 ③ (Kadir 4981 ①): the refusal names the device's latest number, so a daemon whose own count fell behind (a state
    file gone back to 0 · a reinstall that kept its token) takes `latest + 1` and sends its snapshot again — one round trip, and the
    order of reports is never undone."""
    return DesktopRelayError(409, "stale_report", f"report_seq {seq} is not after {latest}", detail={"latest": latest})


async def replace_sessions(db: AsyncSession, setup: DesktopSetup, snapshot: SessionSnapshot) -> int:
    """The whole list (after a reconnect): the given sessions as reported; a session the device no longer lists is stopped.

    story #4554 ③ · Kadir 4981 ①: a snapshot obeys the same «after the latest» rule as a single report — a late snapshot (an HTTP
    retry of an older PUT landing after a newer report · two daemon processes over a restart) never undoes newer state (seq 10
    working → seq 11 idle → late seq 9 working was stored as working). The baseline goes to 0 with a new device token only
    (issue_device_token — a reinstall loses the token with the state file, §12); a daemon behind the latest reads it from the 409."""
    for s in snapshot.sessions:
        _check_agent(setup, s.agent_member_id)
    _check_seq_range(snapshot.report_seq)
    keys = [s.session_key for s in snapshot.sessions]
    if len(set(keys)) != len(keys):
        raise DesktopRelayError(422, "duplicate_session_key", "a session key appears twice")
    latest = await _lock_device_seq(db, setup.id)  # the device row's lock — two reports at once are ordered
    if snapshot.report_seq <= latest:
        raise _stale(snapshot.report_seq, latest)
    now = _now()
    await _prune_expired(db, setup.id, now=now)  # story #4554 ①
    existing = {r.session_key: r for r in (await db.execute(
        select(DesktopSession).where(DesktopSession.setup_id == setup.id)
    )).scalars().all()}
    await _make_room(db, setup.id, new_rows=sum(1 for s in snapshot.sessions if s.session_key not in existing))  # story #4554 ①
    kept = set((await db.execute(select(DesktopSession.id).where(DesktopSession.setup_id == setup.id))).scalars().all())
    existing = {k: r for k, r in existing.items() if r.id in kept}  # an ended row _make_room dropped is not written again
    limit_moves: list[tuple[DesktopSession, bool]] = []  # story #4685: (row, was it limited before this snapshot) — the notice reads the move
    for s in snapshot.sessions:
        row = existing.pop(s.session_key, None)
        if row is None:
            row = DesktopSession(id=uuid.uuid4(), setup_id=setup.id, session_key=s.session_key)
            db.add(row)
        limit_moves.append((row, bool(row.limited)))
        was_stopped = row.state == "stopped"  # captured before the row takes the new word (a new session under the same key)
        at = _reported_at(s.at, now)  # story #4554 2선 · 4709
        row.agent_member_id, row.runtime, row.state, row.state_at = s.agent_member_id, s.runtime, s.state, at
        row.last_report_seq = snapshot.report_seq
        row.ended_at = at if s.state == "stopped" else None
        _set_limit(row, s.limit)
        _set_run(row, s.run)  # story #4686
        _set_inbox(row, s.inbox if s.state != "stopped" else None)  # story #4684
        _set_system(row, s)  # story #4599
        _set_widened(row, s, now, was_stopped=was_stopped)  # story #4641
        row.instruct_now = s.instruct_now
    for row in existing.values():
        row.last_report_seq = snapshot.report_seq
        if row.state != "stopped":
            limit_moves.append((row, bool(row.limited)))  # story #4685: a dropped session leaves its limit too
            row.state, row.state_at, row.ended_at = "stopped", now, now
            _set_limit(row, None)
            _set_run(row, None)  # story #4686: a dropped session says nothing of what it ran on
            _set_inbox(row, None)  # story #4684: a dropped session explains no receive stop
            row.system_folder = None  # story #4599: a dropped session holds no window
            row.instruct_now = None
    await touch_device(db, setup.id)
    await db.flush()
    from app.services.desktop_commands import on_session_reported  # story #4534 — every line of a snapshot is a report too

    for s in snapshot.sessions:
        await on_session_reported(db, setup, s.session_key, s.state, _reported_at(s.at, now))
    for row in existing.values():
        await on_session_reported(db, setup, row.session_key, "stopped", now)
    from app.services.desktop_limit_notice import after_report  # story #4685 — a snapshot's lines move sessions into / out of a limit too

    for row, was_limited in limit_moves:
        await after_report(db, setup, row, was_limited=was_limited)
    return len(snapshot.sessions)


async def accessible_startable(db: AsyncSession, setup: DesktopSetup, snapshot: StartableSnapshot) -> tuple[StartableSnapshot, list[uuid.UUID]]:
    """story #4714: narrow the computer's list to the pairs its own agents can really have: the agent is one this device was set up with
    AND the agent belongs to the project (its project profile) AND the project is a live project of this device's organization. A pair outside
    that is dropped, not refused: the computer works from its own files and a refusal would only make it send the same list again. An agent this
    device was NOT set up with is dropped the same way (it used to refuse the whole list with 422, which hid every other agent behind one stale
    one) — and named in the second value, so the computer can stop offering it. The phone's reads cut the list by who may open what; this keeps the
    stored list itself to what is possible."""
    from app.models.member import AgentProjectProfile
    from app.models.project import Project

    # the device row is locked and READ AGAIN first: the `setup` this request loaded may be older than a setup exchange that moved an agent to another computer
    # (a stale member list would accept that agent here); the same lock orders this report against such a move
    fresh = (await db.execute(
        select(DesktopSetup).where(DesktopSetup.id == setup.id).with_for_update().execution_options(populate_existing=True)
    )).scalar_one()
    mine = _setup_agents(fresh)
    dropped = sorted({i.agent_member_id for i in snapshot.startable if i.agent_member_id not in mine}, key=str)
    snapshot = snapshot.model_copy(update={"startable": [i for i in snapshot.startable if i.agent_member_id in mine]})
    agents = {i.agent_member_id for i in snapshot.startable}
    if not agents:
        return snapshot, dropped
    rows = (await db.execute(
        select(AgentProjectProfile.member_id, AgentProjectProfile.project_id)
        .join(Project, Project.id == AgentProjectProfile.project_id)
        .where(AgentProjectProfile.member_id.in_(agents), Project.org_id == setup.org_id, Project.deleted_at.is_(None))
    )).all()
    possible = {(m, p) for m, p in rows}
    return snapshot.model_copy(update={"startable": [i for i in snapshot.startable if (i.agent_member_id, i.project_id) in possible]}), dropped


COMPUTER_PRESS = "computer_press"


async def note_computer_press(db: AsyncSession, setup: DesktopSetup, knows: bool) -> None:
    """story #4734 (B): the computer says (with each startable list) whether its app takes the whole-computer press; kept in `capabilities` next to what the setup's app
    could take at its creation, and taken out again when a list comes without it (an app that went back). The other words of the list are left as they are."""
    have = [c for c in (setup.capabilities or []) if isinstance(c, str)]
    want = sorted({*have, COMPUTER_PRESS}) if knows else [c for c in have if c != COMPUTER_PRESS]
    if want == have and setup.capabilities is not None:
        return
    if not want and setup.capabilities is None:
        return
    await db.execute(update(DesktopSetup).where(DesktopSetup.id == setup.id).values(capabilities=want))
    await db.flush()


async def replace_startable(db: AsyncSession, setup: DesktopSetup, snapshot: StartableSnapshot) -> tuple[int, bool, int | None]:
    """story #4714: the computer's startable pairs, as it says them (already narrowed by `accessible_startable`). Stored as given, sorted and without
    repeats. A numbered report is applied by ONE statement that holds the guard itself (`startable_seq IS NULL OR startable_seq < seq`): a report at or
    below the highest applied is IGNORED (returns the stored count, applied False) — a late request cannot cover a newer list, lock or no lock.
    An unnumbered report (an older app) is applied and leaves the number alone. `seq` is bounded to 2**62 on purpose (well inside BIGINT).
    The third value is the number the server holds AFTER this report (NULL = no numbered report yet): the computer reads it when its report was ignored and goes on
    from there, instead of guessing how far behind it is (its clock may have gone back since a restart)."""
    pairs = sorted({(str(i.agent_member_id), str(i.project_id)) for i in snapshot.startable})
    values: dict = {"startable": [{"agent_member_id": a, "project_id": p} for a, p in pairs]}
    stmt = update(DesktopSetup).where(DesktopSetup.id == setup.id)
    if snapshot.seq is not None:
        values["startable_seq"] = snapshot.seq
        stmt = stmt.where(or_(DesktopSetup.startable_seq.is_(None), DesktopSetup.startable_seq < snapshot.seq))
    row = (await db.execute(stmt.values(**values).returning(DesktopSetup.startable_seq))).first()
    if row is None:
        kept, held = (await db.execute(select(DesktopSetup.startable, DesktopSetup.startable_seq).where(DesktopSetup.id == setup.id))).one()
        await touch_device(db, setup.id)  # an ignored report is still the computer speaking: it was heard
        await db.flush()
        return len(kept or []), False, held
    await touch_device(db, setup.id)
    await db.flush()
    return len(pairs), True, row[0]


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
        # story #4686: what it runs on (model · whether chosen · thinking depth · account) — only while the device is heard
        **({"run": rn} if not silent and r.state != "stopped" and (rn := run_view(r)) is not None else {}),
        # story #4684: why this computer receives no new work for the agent — only while the device is heard and the session lives
        **({"inbox": ib} if not silent and r.state != "stopped" and (ib := inbox_view(r)) is not None else {}),
        # story #4599: a held turn's why (the window's folder) — for the new web only, and only while the device is heard
        **({"system": sv} if not silent and (sv := system_view(r)) is not None else {}),
        # story #4641: a widening a person made at the terminal — the three keys, only while the device is heard
        **widened_fields(r, silent),
        # story #4534 (PO 06:30Z): whether [지금 지시] can go into its turn — not said for a device not heard (Kadir 06:31Z (c))
        "instruct_now": None if silent else r.instruct_now,
        # story #4543 (PO 21:12Z): when the session began and ended — the crew's daily ledger reads app coverage from these. Facts, not
        # the live state, so shown for a silent device too. created_at = the server's first row for the key; ended_at = the device's
        # `at` of its stopped report, or the server's time when a snapshot dropped the key; null while live (a stopped key reported
        # live again clears it)
        "created_at": r.created_at.isoformat(),
        "ended_at": r.ended_at.isoformat() if r.ended_at else None,
    } for r in rows]


# ── commands ─────────────────────────────────────────────────────────────────────────────────────────────────────────────────


class _Payload(BaseModel):
    model_config = ConfigDict(extra="forbid")


class StartSessionPayload(_Payload):
    """story #4714 (contract 02d2cf71 new version): a phone's signed start — the agent, the project (never a path, a mode, an argument or a
    runtime: the computer reads its own folder for the project and the agent's own profile), and the phone's signed blob carried as is.
    The old shape {agent_member_id, runtime} has no maker any more (the daemon refused it as `unsigned` since v1.9.1)."""

    agent_member_id: uuid.UUID
    project_id: uuid.UUID
    signed: str = Field(min_length=1, max_length=16384)


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


# story #4733 (0459 · S2): the actions of a phone's `clock` command. The kind is one word (DB CHECK); the choice is the payload's, so the next action
# (P2 · S5: `out_edit`, its own shape) widens this schema and nothing in the database.
CLOCK_ACTIONS = ("out_open", "out_submit", "out_cancel", "in", "out_edit")
CLOCK_SCOPE_MAX = 500  # the most agents one computer-wide press names (story #4734 B)
# story #4733 (S5 · P2): the fields of a phone's edit are the Mac's own three, with the Mac's own limit (ClockFlow.edit cuts a field at 2000 characters)
CLOCK_EDIT_FIELD_MAX = 2000
CLOCK_REV_MAX = 2**31 - 1


def plain_text(text: str) -> bool:
    """Plain text of a field: line breaks (\\n) are the person's own; every other control character (C0 — a tab and a carriage return included: the phone sends \\n —,
    DEL, the C1 controls, the Unicode line / paragraph separators) is refused, so what reaches the Mac is what the phone signed and shows. (The computer refuses
    the hidden format characters too — it holds the same cleaner as for an instruction — and answers `rejected`; the server does not carry that list.)"""
    return not any((ord(ch) < 32 and ch != "\n") or 0x7F <= ord(ch) <= 0x9F or ch in "\u2028\u2029" for ch in text)


class ClockEdit(_Payload):
    """story #4733 (S5 · P2): what a phone typed into a clock-out draft of ONE agent. `base_rev` = the row's revision the phone saw in the computer's report (the
    daemon refuses the edit when the row moved on since — `stale` — so a phone never writes over what it did not see). Only the fields the person touched are
    here (one to three; an absent field is left exactly as it is). The signature covers a hash of exactly these fields (the server never opens it)."""

    base_rev: int = Field(ge=0, le=CLOCK_REV_MAX, strict=True)
    done: str | None = Field(default=None, max_length=CLOCK_EDIT_FIELD_MAX)
    plan: str | None = Field(default=None, max_length=CLOCK_EDIT_FIELD_MAX)
    blockers: str | None = Field(default=None, max_length=CLOCK_EDIT_FIELD_MAX)

    @model_validator(mode="after")
    def _touched(self) -> ClockEdit:
        fields = [t for t in (self.done, self.plan, self.blockers) if t is not None]
        if not fields:
            raise ValueError("an edit touches at least one field")
        if not all(plain_text(t) for t in fields):
            raise ValueError("an edited field is plain text: line breaks only, no other control character")
        return self


class ClockPayload(_Payload):
    """A person's signed clock-out / clock-in of the whole computer — exactly {action, signed}: no text, no agent, no path, no session (the phone sends
    no free words, so there is nothing to inject). The signature covers kind `clock` + setup_id + action; the server carries it as is and opens nothing.
    The one exception is `out_edit` (S5 · P2): one agent's draft fields, typed on the phone — {action, signed, agent_member_id, edit}, the signature
    covering the agent, the revision it saw and a hash of exactly the fields sent."""

    action: Literal["out_open", "out_submit", "out_cancel", "in", "out_edit"]
    signed: str = Field(min_length=1, max_length=16384)
    # PO 10-20 00:23Z (AC1b): ONE agent of the computer instead of the whole computer — the signature then covers the agent too (kind + setup_id + action +
    # agent_member_id; none = a fixed empty value). Absent = the whole computer, exactly the payload as before (the key is left out of the stored payload).
    agent_member_id: uuid.UUID | None = None
    edit: ClockEdit | None = None
    # story #4734 (B): the WHOLE-COMPUTER press — `computer: true` rides inside the signed bytes too (the daemon builds what it expects from this very field, so a mark the phone did
    # not sign, or a signed mark the server dropped, is a `mismatch`); `scope` is the agents of THIS computer's setups the person may press one setup at a time — collected by the
    # server (the sole place of that judgement, as for a one-setup press) and filtered again by the daemon to its own profiles; `scope_total` = every agent the computer's live
    # setups hold («N개 중 K개»). All three are absent from every other press: the payload of a press without the mark is exactly as before.
    computer: Literal[True] | None = None
    scope: list[uuid.UUID] | None = Field(default=None, max_length=CLOCK_SCOPE_MAX)
    scope_total: int | None = Field(default=None, ge=0, le=100000, strict=True)

    @model_validator(mode="after")
    def _edit_only_for_edit(self) -> ClockPayload:
        if (self.action == "out_edit") != (self.edit is not None):
            raise ValueError("an edit rides with the action out_edit, and only with it")
        if self.action == "out_edit" and self.agent_member_id is None:
            raise ValueError("an edit names its agent")
        if (self.computer is not None) != (self.scope is not None) or (self.computer is not None) != (self.scope_total is not None):
            raise ValueError("the computer mark, its scope and its total come together")
        if self.computer is not None and (self.action == "out_edit" or self.agent_member_id is not None or self.edit is not None):
            raise ValueError("the computer mark is for the whole-computer actions only: no agent, no edit")
        if self.scope is not None and (len(set(self.scope)) != len(self.scope) or (self.scope_total or 0) < len(self.scope)):
            raise ValueError("a scope has no repeats and is no larger than its total")
        return self


PAYLOAD_SCHEMAS: dict[str, type[_Payload]] = {
    "start_session": StartSessionPayload,
    "send_prompt": SendPromptPayload,
    "answer_approval": AnswerApprovalPayload,
    "stop_session": StopSessionPayload,
    "end_session": EndSessionPayload,
    "clock": ClockPayload,
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
    if isinstance(parsed, ClockPayload) and parsed.agent_member_id is not None:
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
    if kind == "clock" and body.get("agent_member_id") is None:  # story #4733: the whole computer's press is exactly {action, signed}
        body.pop("agent_member_id", None)
    if kind == "clock" and body.get("computer") is None:  # story #4734 (B): a press without the mark carries none of its three keys (the same bytes as before)
        for k in ("computer", "scope", "scope_total"):
            body.pop(k, None)
    if kind == "clock":  # S5 · P2: no `edit` key for any other press; in an edit only the fields the person touched are stored (an absent one is "left as it is")
        if body.get("edit") is None:
            body.pop("edit", None)
        else:
            body["edit"] = {k: v for k, v in body["edit"].items() if v is not None}
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
    if cmd.kind == "clock" and result.state == "done":
        from app.services.desktop_clock import check_done_code

        check_done_code(result.result_code)  # story #4733: a finished clock command ends in one of the daemon's seven words, nothing else
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
    if cmd.kind == "clock":  # story #4733: a submitted / cancelled clock-out takes the draft lines off the server at once
        from app.services.desktop_clock import on_clock_result, scrub_clock_edits

        await on_clock_result(db, cmd)
        await db.flush()
        await scrub_clock_edits(db, setup_id=setup.id)  # S5 · P2: the typed fields of an edit that just ended leave the stored command
    await touch_device(db, setup.id)
    await db.flush()
    return cmd


# ── wake: the agent stream's own (PO 05:43Z) ─────────────────────────────────────────────────────────────────────────────
# The device stream's queue sits in the agent gateway's connection map under `desktop:<setup_id>` (never an agent's UUID), so
# `wake_agent` reaches it as it reaches an agent: this instance at once, every other instance through the same backplane
# (Redis or pg_notify) → its listener → `_push_to_agent`. The wake carries no command — the stream reads them from the DB.


def wake_key(setup_id: uuid.UUID) -> str:
    return f"desktop:{setup_id}"


async def reject_open_commands(db: AsyncSession, *, setup_ids: list[uuid.UUID], result_code: str) -> int:
    """story #4554 ④ (PO 11:45Z) · §2.1 off (remote_control.set_enabled): the devices' open commands (`queued` · `delivered`) end
    as `rejected` with the reason — nothing waits for a device that will not come back (or may not be reached).

    Kadir 4981 ②: an `answer_approval` among them carried a person's answer that never reached the device — its permission request
    must not stay `answered` (the approver's phone would say it went through: a false success). The same handler the daemon's own
    result takes (agent_permissions.on_answer_result) moves it to `rejected` with the same code, in this transaction."""
    from app.services.agent_permissions import on_answer_result

    if not setup_ids:
        return 0
    now = _now()
    rejected = (await db.execute(
        update(DesktopCommand)
        .where(DesktopCommand.setup_id.in_(setup_ids), DesktopCommand.state.in_(("queued", "delivered")))
        .values(state="rejected", result_code=result_code, finished_at=now)
        .returning(DesktopCommand.setup_id, DesktopCommand.kind, DesktopCommand.payload)
    )).all()
    if any(kind == "clock" for _, kind, _p in rejected):  # S5 · P2: an edit that never reached the computer leaves no typed text behind
        from app.services.desktop_clock import scrub_clock_edits

        for sid in {sid for sid, kind, _p in rejected if kind == "clock"}:
            await scrub_clock_edits(db, setup_id=sid)
    for setup_id, kind, payload in rejected:
        if kind == "answer_approval" and (payload or {}).get("request_id"):
            # story #4580 (Kadir 02:08Z): the stage the command answered — a late result of the first answer never moves the second
            stage = "confirm" if payload.get("stage") == "confirm" else "ask"
            await on_answer_result(db, setup_id, payload["request_id"], "rejected", result_code, stage=stage)
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


AGENT_REACTIVATED_CODE = "agent_reactivated"  # story 4739: the stream's frame name · the wake mark's key (its value: the agent's member id)


def _fire_agent_reactivated(setup_id: uuid.UUID, agent_id: uuid.UUID) -> None:
    """story 4739: the computer's open stream is told that this agent was turned on again — carried like a wake (this instance at once · other
    instances through the same backplane). The stream reads the mark, then looks again itself (the agent still bound to this computer · still on)
    before it sends the frame: the mark only says which agent to look at."""
    from app.routers.events import _push_to_agent

    try:
        _push_to_agent(wake_key(setup_id), {"__wake__": True, "seq": 0, AGENT_REACTIVATED_CODE: str(agent_id)})
    except Exception:  # noqa: BLE001 — the daemon's own back-off still brings it back (at worst a few minutes later)
        logger.warning("desktop relay agent_reactivated signal failed setup=%s", setup_id, exc_info=True)


async def schedule_agent_reactivated_after_commit(db: AsyncSession, org_id: uuid.UUID, agent_id: uuid.UUID) -> None:
    """story 4739: after the commit that turned the agent on (before it, the agent would still read as off), each computer of the organization that
    this agent is bound to (not revoked · exchanged — `desktop_commands._agent_setups`, the same «this agent's computers» every press uses) is told.
    Nothing is sent for an agent no computer holds."""
    if not isinstance(db.sync_session, Session):
        return
    from app.services.after_commit import schedule_after_commit
    from app.services.desktop_commands import _agent_setups

    setups = await _agent_setups(db, org_id, agent_id)
    schedule_after_commit(db, [functools.partial(_fire_agent_reactivated, s.id, agent_id) for s in setups])


async def reactivated_to_send(db: AsyncSession, setup_id: uuid.UUID, marks: set[str]) -> list[uuid.UUID]:
    """story 4739: of the agents a wake named, the ones this computer's stream may announce NOW: ids that parse · still bound to this computer (its
    `members`) · computer not revoked · the agent is an agent of the computer's organization, not deleted, and on. Anything else is dropped — a mark
    that went stale (turned off again meanwhile · a regrouped computer) never reaches the device."""
    ids: set[uuid.UUID] = set()
    for m in marks:
        try:
            ids.add(uuid.UUID(m))
        except (ValueError, AttributeError, TypeError):
            continue
    if not ids:
        return []
    setup = (await db.execute(select(DesktopSetup).where(DesktopSetup.id == setup_id, DesktopSetup.revoked_at.is_(None)))).scalar_one_or_none()
    if setup is None or setup.org_id is None:
        return []
    ids &= _setup_agents(setup)
    if not ids:
        return []
    from app.models.member import Member

    on = (await db.execute(
        select(Member.id).where(Member.id.in_(ids), Member.org_id == setup.org_id, Member.type == "agent", Member.is_active.is_(True), Member.deleted_at.is_(None))
    )).scalars().all()
    return sorted(on)


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
