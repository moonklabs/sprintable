"""story #4733 (E-DESKTOP-2 · S2 · design 4733-phone-clock-design-1020.md) — a phone clocks a whole computer out and in.

The server's part is small and dumb on purpose: the ClockFlow (the state machine) lives in the computer's daemon and decides; the server
- takes a person's signed `clock` press and queues it for that computer (`create_clock` — the same checks as every phone command, at the computer's level);
- keeps the closed view the computer reports while a flow is open (`apply_clock_view`) and gives it to the person's paired phone (`clock_view_read`);
- carries the daemon's nine result words and takes the draft lines off the moment a clock-out is submitted or cancelled (`on_clock_result`).

Who may press / look (computer level — Dan 10-20, no new power): an org owner/admin, or whoever confirmed the device. The agent-owner leg of a stop is per
agent and has no computer-level meaning — and it is NOT added for the one-agent press either (PO 10-20 00:23Z AC1b: `agent_member_id` names one agent of
that computer; the same two legs judge it; a plain agent owner pressing for their own agent is an open question, not an assumption). The phone must be that
person's own and paired with that computer. `signed` (its scope covers the agent too) is carried as is and never opened.

What the server holds (PO 10-20: «only for the clock-out flow · log 0 · only to the phone paired with that computer»): one row per computer in
desktop_clock_views, ids and closed words plus the names the daemon sent and — only while a row is a draft — the draft's first line (≤ 60 characters).
A report with mode `none` and no agent clocked out one by one deletes the row; so does an expiry, a disconnect, the organization's remote control turning off, and a submitted or cancelled
clock-out (its first lines at once). Nothing here logs a report, a view or a line.
"""
from __future__ import annotations

import uuid
from datetime import datetime, timedelta, timezone
from typing import Literal

from pydantic import BaseModel, ConfigDict, Field, model_validator
from sqlalchemy import delete, func, select, update
from sqlalchemy import text as sql_text
from sqlalchemy.dialects.postgresql import insert as pg_insert
from sqlalchemy.ext.asyncio import AsyncSession

from app.core.datetime_query import OffsetDatetime
from app.models.desktop_relay import DesktopClockView, DesktopCommand
from app.models.desktop_setup import DesktopSetup
from app.services.desktop_relay import CLOCK_ACTIONS, CLOCK_REV_MAX, DISCONNECTED_CODE, ClockEdit, DesktopRelayError, touch_device

# the words the daemon's ClockFlow gives back when a clock command is done (Dan 10-20 (d) · 00:23Z: nine with the one-agent press); a done result is one of these or it is refused
CLOCK_DONE_CODES = (
    "ok", "already", "nothing_running", "not_open", "not_ready", "needs_hands", "not_clocked_out",
    "unknown_agent",     # the one agent named is not a profile of that computer (the daemon asks again)
    "already_running",   # a clock-in of one agent that already runs
    # story #4733 (S5 · P2): the two more words of a phone's edit — `stale` (the row moved on since the report the phone read: nothing was written) and
    # `not_editable` (the row is being drafted or saved, or has no draft to fix: nothing was written)
    "stale", "not_editable",
)
ROW_STATES = ("drafting", "ready", "needs_you", "saving", "saved", "ended", "not_ended", "failed")
# a first line belongs to a draft that is still being made or kept: a row already saved (or ended) carries none
DRAFT_ROW_STATES = ("drafting", "ready", "needs_you", "saving", "failed")
MISSING_PARTS = ("done", "plan", "blockers")
FIRST_LINE_MAX = 60
NAME_MAX = 80
LIST_MAX = 64
SEQ_MAX = 2**62
# a flow that is moving (panel · in): the computer re-reports at least every ten minutes; an out is the night's clocked-out state (names only, no draft
# lines) and stays until the morning's clock-in — bounded
FLOW_TTL = timedelta(minutes=30)
RESTING_OUT_TTL = timedelta(hours=36)


def _now() -> datetime:
    return datetime.now(timezone.utc)


# ── who ───────────────────────────────────────────────────────────────────────────────────────────────────────────────────


def can_clock(*, member_role: str | None, user_id: uuid.UUID, setup: DesktopSetup) -> bool:
    """The computer-level legs of `desktop_commands.can_command`: an org owner/admin, or whoever confirmed the device."""
    if member_role in ("owner", "admin"):
        return True
    return setup.confirmed_by is not None and setup.confirmed_by == user_id


async def _computer(db: AsyncSession, org_id: uuid.UUID, setup_id: uuid.UUID) -> DesktopSetup:
    setup = (await db.execute(
        select(DesktopSetup).where(DesktopSetup.id == setup_id, DesktopSetup.org_id == org_id,
                                   DesktopSetup.revoked_at.is_(None), DesktopSetup.exchanged_at.is_not(None))
    )).scalar_one_or_none()
    if setup is None:  # another organization's, a disconnected one or none: the same answer
        raise DesktopRelayError(404, "computer_not_found", "no such computer")
    return setup


async def _authorized_computer(db: AsyncSession, *, user_id: uuid.UUID, org_id: uuid.UUID, setup_id: uuid.UUID) -> DesktopSetup:
    from app.services.desktop_commands import org_role

    setup = await _computer(db, org_id, setup_id)
    if not can_clock(member_role=await org_role(db, org_id, user_id), user_id=user_id, setup=setup):
        raise DesktopRelayError(403, "not_allowed_to_command", "you cannot command this computer")
    return setup


# ── ① a person's signed press ─────────────────────────────────────────────────────────────────────────────────────────────


class ClockRequest(BaseModel):
    """The phone's press: the action, its signature (carried as is), the key it signed with, the press's own key. Nothing else — no text, agent or path;
    the one exception is `out_edit` (S5 · P2): the agent it names and the fields the person typed into that agent's draft."""
    model_config = ConfigDict(extra="forbid")

    action: Literal["out_open", "out_submit", "out_cancel", "in", "out_edit"]
    idempotency_key: str = Field(min_length=1, max_length=100)
    signed: str = Field(min_length=1, max_length=16384)
    phone_key_id: uuid.UUID
    agent_member_id: uuid.UUID | None = None  # one agent of the computer (the signature covers it); absent = the whole computer
    edit: ClockEdit | None = None  # only with out_edit

    @model_validator(mode="after")
    def _edit_only_for_edit(self) -> ClockRequest:
        if (self.action == "out_edit") != (self.edit is not None):
            raise ValueError("an edit rides with the action out_edit, and only with it")
        if self.action == "out_edit" and self.agent_member_id is None:
            raise ValueError("an edit names its agent")
        return self


assert tuple(ClockRequest.model_fields["action"].annotation.__args__) == CLOCK_ACTIONS, "the request and the payload speak the same actions"


async def create_clock(db: AsyncSession, *, member_id: uuid.UUID, user_id: uuid.UUID, org_id: uuid.UUID, setup_id: uuid.UUID,
                       body: ClockRequest) -> tuple[DesktopCommand, str]:
    """A phone's signed `clock` → (the command, its state). Who may press is judged from the rows as they are now — asked twice, the second time under
    the computer's row lock (a demotion or a disconnect that committed while this press waited counts, and two presses of one key cannot both miss the
    first row). Then, in the order of every phone command: the same press again gets its command back · remote control on · the computer heard from ·
    the phone the person's own and paired with it. Whether the action fits the flow's state is the daemon's judgement (one state, one guard — it answers
    `already` · `not_open` · …); the server does not guess it."""
    from app.services import remote_control
    from app.services.agent_permissions import _reachable, paired_phone
    from app.services.desktop_relay import enqueue_command

    setup = await _authorized_computer(db, user_id=user_id, org_id=org_id, setup_id=setup_id)
    await db.execute(select(DesktopSetup).where(DesktopSetup.id == setup.id).with_for_update().execution_options(populate_existing=True))
    setup = await _authorized_computer(db, user_id=user_id, org_id=org_id, setup_id=setup_id)
    await scrub_clock_edits(db, setup_id=setup.id)  # a typed field that outlived its minutes (a press nobody answered) goes before a new one is taken
    key = f"b5:{member_id}:{body.idempotency_key}"
    existing = (await db.execute(
        select(DesktopCommand).where(DesktopCommand.setup_id == setup.id, DesktopCommand.idempotency_key == key)
    )).scalar_one_or_none()
    if existing is not None:
        return existing, existing.state
    if not await remote_control.is_enabled(db, org_id):
        raise DesktopRelayError(409, remote_control.OFF_CODE, "remote control is off for this organization")
    if setup.id not in await _reachable(db, {setup.id}, _now()):
        raise DesktopRelayError(409, "device_unreachable", "that computer has not been heard from")
    # the pairing (and the phone key) is held with a share lock until this press commits: an [빼기] or a key revocation that comes meanwhile waits, so a press can
    # not be queued behind a pairing that was just taken away
    if await paired_phone(db, member_id=member_id, phone_id=body.phone_key_id, setup_id=setup.id, lock=True) is None:
        raise DesktopRelayError(409, "phone_not_paired", "this phone is not paired with that computer")
    if body.action == "out_edit":
        # S5 · P2: the phone shows a draft's first line only to a person who can open that agent — the same person is the only one who writes into it
        from app.services.desktop_commands import can_view
        from app.services.desktop_relay import _check_agent

        _check_agent(setup, body.agent_member_id)  # an agent this computer was not set up with is no target — before anything is said of who may see it
        if not await can_view(db, user_id=user_id, org_id=org_id, agent_id=body.agent_member_id):
            raise DesktopRelayError(403, "not_allowed_to_command", "you cannot edit that agent's draft")
    payload = {"action": body.action, "signed": body.signed}
    if body.agent_member_id is not None:
        payload["agent_member_id"] = str(body.agent_member_id)  # enqueue_command refuses an agent this computer was not set up with (another organization's included)
    if body.edit is not None:
        payload["edit"] = body.edit.model_dump(exclude_none=True)  # only the fields the person touched; an absent one is left as it is
    cmd = await enqueue_command(db, setup=setup, kind="clock", payload=payload, idempotency_key=key, requested_by=member_id)
    return cmd, cmd.state


async def get_clock_command(db: AsyncSession, *, member_id: uuid.UUID, org_id: uuid.UUID, setup_id: uuid.UUID, command_id: uuid.UUID) -> dict:
    """The presser's own read of what became of a clock command (state + the daemon's word)."""
    row = (await db.execute(
        select(DesktopCommand).join(DesktopSetup, DesktopSetup.id == DesktopCommand.setup_id).where(
            DesktopCommand.id == command_id, DesktopCommand.setup_id == setup_id, DesktopCommand.requested_by == member_id,
            DesktopCommand.kind == "clock", DesktopSetup.org_id == org_id,
        )
    )).scalar_one_or_none()
    if row is None:
        raise DesktopRelayError(404, "command_not_found", "no such command of yours")
    return {"command_id": str(row.id), "kind": row.kind, "action": (row.payload or {}).get("action"), "state": row.state, "result_code": row.result_code}


def check_done_code(result_code: str | None) -> None:
    if result_code not in CLOCK_DONE_CODES:
        raise DesktopRelayError(422, "invalid_result_code", "a finished clock command ends in one of the clock words")


# story #4733 (S5 · P2): the text a person typed into a draft rides in the stored command only while the command is open: when it ends (done · failed · rejected)
# or when its minutes are up, the fields are taken out of the row and only the revision stays — «흐름 동안만 · 끝나면 지움 · 로그 0»
EDIT_TEXT_TTL = timedelta(minutes=10)
_SCRUB_EDIT_SQL = sql_text(
    "UPDATE desktop_commands SET payload = jsonb_set(payload, '{edit}', jsonb_build_object('base_rev', payload #> '{edit,base_rev}')) "
    "WHERE setup_id = :setup_id AND kind = 'clock' AND jsonb_exists(payload, 'edit') "
    "AND (payload #> '{edit}') <> jsonb_build_object('base_rev', payload #> '{edit,base_rev}') "
    "AND (state IN ('done', 'failed', 'rejected') OR created_at < :cutoff)"
)


async def scrub_clock_edits(db: AsyncSession, *, setup_id: uuid.UUID) -> None:
    await db.execute(_SCRUB_EDIT_SQL, {"setup_id": setup_id, "cutoff": _now() - EDIT_TEXT_TTL})


async def on_clock_result(db: AsyncSession, cmd: DesktopCommand) -> None:
    """A clock-out submitted or cancelled (done): the draft's first lines leave the server now — not at the computer's next report."""
    if cmd.state == "done" and (cmd.payload or {}).get("action") in ("out_submit", "out_cancel"):
        await _drop_first_lines(db, cmd.setup_id, (cmd.payload or {}).get("agent_member_id"))


# a clock-out submitted or cancelled raises the computer's report-number floor by this much: a report the computer had already sent (still on its way, with a number
# a little above the highest applied) would otherwise put the draft lines back a moment after they were taken off. The computer goes on from the number the
# server tells it (`clock_view_seq` in the answer to an ignored report — the same rule as the startable list); its next report is applied.
IN_FLIGHT_FLOOR = 1000


async def _drop_first_lines(db: AsyncSession, setup_id: uuid.UUID, agent_id: str | None = None) -> None:
    await db.execute(select(DesktopSetup.id).where(DesktopSetup.id == setup_id).with_for_update())  # after any report in flight on this computer
    row = (await db.execute(select(DesktopClockView).where(DesktopClockView.setup_id == setup_id).with_for_update())).scalar_one_or_none()
    if row is not None:
        view = dict(row.view or {})
        # a press for ONE agent takes that agent's line only (the panel of the whole computer may hold other agents' drafts)
        view["rows"] = [{**r, "first_line": None} if agent_id is None or r.get("agent_member_id") == agent_id else r for r in view.get("rows") or []]
        row.view = view
    await db.execute(
        update(DesktopSetup).where(DesktopSetup.id == setup_id, DesktopSetup.clock_view_seq.is_not(None))
        .values(clock_view_seq=func.least(DesktopSetup.clock_view_seq + IN_FLIGHT_FLOOR, SEQ_MAX))
    )
    await db.flush()


# ── ② what the computer reports ────────────────────────────────────────────────────────────────────────────────────────────


class ClockCount(BaseModel):
    model_config = ConfigDict(extra="forbid")

    ready: int = Field(ge=0, le=1000, strict=True)
    needs_you: int = Field(ge=0, le=1000, strict=True)
    drafting: int = Field(ge=0, le=1000, strict=True)


class ClockRow(BaseModel):
    """One agent's line. Ids and closed words; the name is the board's own (read at the phone's read), never the computer's. `first_line` = the first
    non-empty line of the draft's «done», cut to 60 characters, and only for a draft that is still being made or kept."""
    model_config = ConfigDict(extra="forbid")

    agent_member_id: uuid.UUID
    state: Literal["drafting", "ready", "needs_you", "saving", "saved", "ended", "not_ended", "failed"]
    missing: list[Literal["done", "plan", "blockers"]] = Field(default_factory=list, max_length=3)
    first_line: str | None = Field(default=None, min_length=1, max_length=FIRST_LINE_MAX)
    # a session that never ran a turn (the Mac's words differ: «한 일 없음 — 인계 없이 멈춰요») — a mark on top of the state, not a state
    idle: bool = Field(default=False, strict=True)
    # story #4733 (S5 · P2): the row's revision — it moves whenever the draft, a field or the row's state changes on the computer; a phone's edit names the one it
    # saw and the computer refuses it (`stale`) when the row has moved. A computer of the older build sends none (0).
    rev: int = Field(default=0, ge=0, le=CLOCK_REV_MAX, strict=True)
    # story #4733 (S5 · P2): a person's hand has been on this row (the Mac's or a phone's) — its first line is then the person's own words, not the agent's draft; the phone
    # says so in front of the line («고친 글»). A closed mark on top of the state, like `idle` — not a state of its own.
    edited: bool = Field(default=False, strict=True)

    @model_validator(mode="after")
    def _closed(self) -> ClockRow:
        if self.first_line is not None:
            if self.state not in DRAFT_ROW_STATES:
                raise ValueError("a first line belongs to a draft, not to a saved or ended row")
            if not _plain_line(self.first_line):
                raise ValueError("a first line is one line of plain text")
        if self.edited and self.state not in DRAFT_ROW_STATES:
            raise ValueError("a person's hand is a mark on a draft, not on a saved or ended row")
        if len(set(self.missing)) != len(self.missing):
            raise ValueError("missing has no repeats")
        if self.idle and (self.first_line is not None or self.missing):
            raise ValueError("an idle row has no draft: no first line, nothing missing")
        return self


class ClockOut(BaseModel):
    model_config = ConfigDict(extra="forbid")

    at: OffsetDatetime
    came: int = Field(ge=0, le=100000, strict=True)
    warn: Literal["none", "many", "full"]
    still_working: list[str] = Field(default_factory=list, max_length=LIST_MAX)
    left: list[str] = Field(default_factory=list, max_length=LIST_MAX)
    alone: int = Field(default=0, ge=0, le=100000, strict=True)  # of those, how many clocked out one by one before

    @model_validator(mode="after")
    def _names(self) -> ClockOut:
        _check_names(self.still_working, self.left)
        return self


class Starting(BaseModel):
    """«시작 k/n» — the agents started so far of those to start."""
    model_config = ConfigDict(extra="forbid")

    k: int = Field(ge=0, le=100000, strict=True)
    n: int = Field(ge=0, le=100000, strict=True)


class Handing(BaseModel):
    """«넘기는 중 k/m» — the hand-over notes passed on so far of those to pass."""
    model_config = ConfigDict(extra="forbid")

    k: int = Field(ge=0, le=100000, strict=True)
    m: int = Field(ge=0, le=100000, strict=True)


class Came(BaseModel):
    model_config = ConfigDict(extra="forbid")

    total: int = Field(ge=0, le=100000, strict=True)
    task: int = Field(ge=0, le=100000, strict=True)
    message: int = Field(ge=0, le=100000, strict=True)
    recipe: int = Field(ge=0, le=100000, strict=True)
    event: int = Field(ge=0, le=100000, strict=True)


class ClockFailed(BaseModel):
    model_config = ConfigDict(extra="forbid")

    name: str = Field(min_length=1, max_length=NAME_MAX)
    code: str = Field(pattern=r"^[a-z_]{1,40}$")
    limit: int | None = Field(default=None, ge=0, le=100000, strict=True)

    @model_validator(mode="after")
    def _plain(self) -> ClockFailed:
        _check_names([self.name])
        return self


class ClockIn(BaseModel):
    model_config = ConfigDict(extra="forbid")

    at: OffsetDatetime | None = None
    starting: Starting | None = None
    handing: Handing | None = None
    came: Came | None = None
    failed: list[ClockFailed] = Field(default_factory=list, max_length=LIST_MAX)
    unread: list[str] = Field(default_factory=list, max_length=LIST_MAX)

    @model_validator(mode="after")
    def _names(self) -> ClockIn:
        _check_names(self.unread)
        return self


def _plain_line(text: str) -> bool:
    """One line of plain text: no control character (C0, DEL, the C1 controls, the Unicode line / paragraph separators) — a tab is the one allowed (an indented
    draft line is ordinary). A NUL among them would pass this schema and be refused by the database (jsonb) as a 500 whose error log carries the bound
    parameters — the draft's line included — so it is refused HERE, as a 422 (a refused report is not logged). The computer replaces such characters before it sends."""
    return not any((ord(ch) < 32 and ch != "\t") or 0x7F <= ord(ch) <= 0x9F or ch in "\u2028\u2029" for ch in text)


def _check_names(*lists: list[str]) -> None:
    for names in lists:
        for n in names:
            if not 1 <= len(n) <= NAME_MAX or not _plain_line(n):
                raise ValueError("a name is 1 to 80 characters on one line")


class ClockOne(BaseModel):
    """An agent that clocked out on its own (one by one) and stands so — the phone draws its [출근]. Kept by the computer across a restart."""
    model_config = ConfigDict(extra="forbid")

    agent_member_id: uuid.UUID
    at: OffsetDatetime


class ClockViewReport(BaseModel):
    """The computer's closed clock view (`mode` is ClockFlow.view's own word). Nothing outside these fields is accepted — every body forbids extra.
    A field that does not belong to the mode is refused, not dropped: it would mean the computer and the server read the contract differently."""
    model_config = ConfigDict(extra="forbid", populate_by_name=False)

    seq: int = Field(ge=1, le=SEQ_MAX, strict=True)
    mode: Literal["none", "panel", "out", "in"]
    scope: Literal["computer", "one"] | None = None  # a panel's: the whole computer's clock-out, or one agent's end at the Mac
    # which side opened the flow (a closed word — never a person's id or a device's name); null = an out brought back from an older clock.json (not guessed)
    opened_from: Literal["mac", "phone"] | None = None
    count: ClockCount | None = None
    rows: list[ClockRow] = Field(default_factory=list, max_length=LIST_MAX)
    out: ClockOut | None = None
    in_: ClockIn | None = Field(default=None, alias="in")
    outs: list[ClockOne] = Field(default_factory=list, max_length=LIST_MAX)  # in every mode — also with mode none

    @model_validator(mode="after")
    def _fits_the_mode(self) -> ClockViewReport:
        m = self.mode
        if m == "none" and (self.scope or self.opened_from or self.count or self.rows or self.out or self.in_):
            raise ValueError("a report with mode none carries nothing")
        if self.scope is not None and m != "panel":
            raise ValueError("scope belongs to a panel")
        if self.scope == "one" and len(self.rows) != 1:
            raise ValueError("a panel of one agent has that one row")
        if (self.count is not None or self.rows) and m != "panel":
            raise ValueError("count and rows belong to a panel (an out is names, an in is steps)")
        if self.out is not None and m != "out":
            raise ValueError("out belongs to mode out")
        if self.in_ is not None and m != "in":
            raise ValueError("in belongs to mode in")
        ids = [r.agent_member_id for r in self.rows]
        if len(set(ids)) != len(ids):
            raise ValueError("an agent is one row")
        one_ids = [o.agent_member_id for o in self.outs]
        if len(set(one_ids)) != len(one_ids):
            raise ValueError("an agent is one entry of outs")
        return self

def expires_after(report: ClockViewReport) -> timedelta:
    """A moving flow (panel · in; only a panel holds draft lines): the short term — the computer re-reports every ten minutes. An out (the night's clocked-out
    state, names only) and a `none` that only holds the agents clocked out one by one stay until the morning's clock-in: the long term, bounded."""
    return RESTING_OUT_TTL if report.mode in ("out", "none") else FLOW_TTL


async def apply_clock_view(db: AsyncSession, setup: DesktopSetup, report: ClockViewReport) -> tuple[bool, int | None, int]:
    """The computer's report → (applied, the highest number held after it, rows dropped). One statement holds the numbering guard: a report at or below
    the highest applied is IGNORED (a late request cannot cover — or bring back — a newer state, lock or no lock); a numbered report that is applied
    leaves the row as the report says: `none` deletes it, any other mode replaces it whole. Rows of an agent this device was not set up with are dropped
    (named only by count) — the same rule as the startable list."""
    from app.services.desktop_relay import _setup_agents

    # the device row is locked and read again first: the `setup` this request loaded may be older than a move of an agent to another computer
    fresh = (await db.execute(
        select(DesktopSetup).where(DesktopSetup.id == setup.id).with_for_update().execution_options(populate_existing=True)
    )).scalar_one()
    # what committed while this report waited for the lock counts: a computer disconnected meanwhile, or the organization's remote control turned off
    # (both delete the view — a report that slipped in behind them must not put one back)
    if fresh.revoked_at is not None:
        raise DesktopRelayError(409, DISCONNECTED_CODE, "this computer was disconnected")
    from app.services import remote_control

    if not await remote_control.is_enabled(db, fresh.org_id):
        raise DesktopRelayError(409, remote_control.OFF_CODE, "remote control is off for this organization")
    mine = _setup_agents(fresh)
    kept = [r for r in report.rows if r.agent_member_id in mine]
    kept_outs = [o for o in report.outs if o.agent_member_id in mine]
    dropped = len(report.rows) - len(kept) + len(report.outs) - len(kept_outs)
    now = _now()
    # a view that ran out of time goes whoever it belonged to (a disconnected computer's included) — the table has one row per computer, so this is small
    await db.execute(delete(DesktopClockView).where(DesktopClockView.expires_at <= now))
    row = (await db.execute(
        update(DesktopSetup).where(DesktopSetup.id == setup.id)
        .where((DesktopSetup.clock_view_seq.is_(None)) | (DesktopSetup.clock_view_seq < report.seq))
        .values(clock_view_seq=report.seq, clock_seen_at=now)
        .returning(DesktopSetup.clock_view_seq)
    )).first()
    await touch_device(db, setup.id)  # an ignored report is still the computer speaking: it was heard
    if row is None:
        held = (await db.execute(select(DesktopSetup.clock_view_seq).where(DesktopSetup.id == setup.id))).scalar_one()
        await db.execute(update(DesktopSetup).where(DesktopSetup.id == setup.id).values(clock_seen_at=now))  # …and it spoke of the clock: `supported`
        await db.flush()
        return False, held, 0
    if report.mode == "none" and not kept_outs:
        await db.execute(delete(DesktopClockView).where(DesktopClockView.setup_id == setup.id))
    else:
        body = report.model_copy(update={"rows": kept, "outs": kept_outs}).model_dump(mode="json", by_alias=True, exclude={"seq"})
        values = {"mode": report.mode, "view": body, "reported_at": now, "expires_at": now + expires_after(report)}
        await db.execute(
            pg_insert(DesktopClockView).values(setup_id=setup.id, **values)
            .on_conflict_do_update(index_elements=[DesktopClockView.setup_id], set_=values)
        )
    await db.flush()
    return True, row[0], dropped


async def forget(db: AsyncSession, setup_ids: list[uuid.UUID], *, lock: bool = True) -> None:
    """The computers' views go (a disconnect · the organization's remote control turned off): nothing of a flow stays for a computer that cannot be reached."""
    if setup_ids:
        # the computers' rows are locked first: a report in flight holds its computer's lock until it commits, so this waits for it and deletes what it wrote
        # (and a report that starts after this waits for the lock, then finds the computer disconnected / remote control off and writes nothing).
        # `lock=False` for a caller that already holds those rows in the service's one lock order (`desktop_setup._lock_in_order`: the exchange and the
        # disconnect) — a second lock statement there would be a second place that takes setup rows.
        if lock:
            await db.execute(select(DesktopSetup.id).where(DesktopSetup.id.in_(setup_ids)).order_by(DesktopSetup.id).with_for_update())
        await db.execute(delete(DesktopClockView).where(DesktopClockView.setup_id.in_(setup_ids)))


# ── ③ what the phone reads ─────────────────────────────────────────────────────────────────────────────────────────────────


async def clock_view_read(db: AsyncSession, *, member_id: uuid.UUID, user_id: uuid.UUID, org_id: uuid.UUID, setup_id: uuid.UUID,
                          phone_key_id: uuid.UUID) -> dict:
    """The paired phone's read of the computer's clock view. The same people as a press (a person's own session — checked by the route — whom
    `can_clock` lets command that computer, with their own paired phone). Remote control off → no view (the line is off). An expired row is not given and
    is deleted here. Names are the board's own; a draft's first line is shown only to a person who can open that agent (else null)."""
    from app.models.member import Member
    from app.services import remote_control
    from app.services.agent_permissions import _reachable, paired_phone
    from app.services.desktop_commands import can_view

    setup = await _authorized_computer(db, user_id=user_id, org_id=org_id, setup_id=setup_id)
    if await paired_phone(db, member_id=member_id, phone_id=phone_key_id, setup_id=setup.id) is None:
        raise DesktopRelayError(409, "phone_not_paired", "this phone is not paired with that computer")
    now = _now()
    enabled = await remote_control.is_enabled(db, org_id)
    out = {"remote_control": enabled, "reachable": setup.id in await _reachable(db, {setup.id}, now),
           "supported": setup.clock_seen_at is not None, "view": None}
    if not enabled:
        return out
    row = (await db.execute(select(DesktopClockView).where(DesktopClockView.setup_id == setup.id))).scalar_one_or_none()
    if row is None:
        return out
    if row.expires_at <= now:
        await db.execute(delete(DesktopClockView).where(DesktopClockView.setup_id == setup.id))
        return out
    view = dict(row.view)
    ids = [uuid.UUID(r["agent_member_id"]) for r in (view.get("rows") or []) + (view.get("outs") or [])]
    names: dict[uuid.UUID, str | None] = {}
    if ids:
        names = dict((await db.execute(
            select(Member.id, Member.name).where(Member.id.in_(ids), Member.org_id == org_id, Member.type == "agent", Member.deleted_at.is_(None))
        )).all())
    rows = []
    for r in view.get("rows") or []:
        aid = uuid.UUID(r["agent_member_id"])
        if aid not in names:  # an agent that is gone is not a row
            continue
        line = r.get("first_line")
        if line is not None and not await can_view(db, user_id=user_id, org_id=org_id, agent_id=aid):
            line = None
        rows.append({**r, "name": names[aid], "first_line": line})
    view["rows"] = rows
    view["outs"] = [{**o, "name": names[uuid.UUID(o["agent_member_id"])]} for o in view.get("outs") or [] if uuid.UUID(o["agent_member_id"]) in names]
    out["view"] = {"mode": row.mode, **view, "reported_at": row.reported_at.isoformat()}
    return out
