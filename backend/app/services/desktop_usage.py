"""story 4981 (연결 ③) — the computer's agent usage, as its host reports it: `PUT /api/v2/desktop/relay/usage`.

The host (desktop-host/src/usage.ts) reads, per CLI, the percentage of each limit window used and when it resets — closed numbers — and says so here. This module is the door's whole rule:
 · the body is CLOSED (`extra="forbid"` everywhere; whole percent 0..100; a window length in minutes; a reset time with a zone and not past a year ahead; at most 4 windows; at most one entry per CLI; an entry is
   either `windows` (numbers, no reason) or `unavailable` (a reason, no numbers)) — nothing else of what a CLI shows can be sent or kept;
 · it speaks for ONE computer: the device token's own (`_device`) — a report can never name another computer;
 · a report older than the stored one (by the host's `seen_at`) is ignored — a late request never covers a newer one; a `seen_at` in the future is cut to now;
 · it is the computer speaking: it counts as «heard from» (`touch_device`);
 · a disconnected computer is refused (409 `device_disconnected`), and the rows are written in one statement per CLI;
 · nothing of a body is logged.
Reading (the phone) is a later door; this one only keeps what the computer says.
"""
from __future__ import annotations

from datetime import datetime, timedelta, timezone
from typing import Literal

from pydantic import BaseModel, ConfigDict, Field, StrictInt, model_validator
from sqlalchemy import delete, func, select
from sqlalchemy.dialects.postgresql import insert as pg_insert
from sqlalchemy.ext.asyncio import AsyncSession

from app.core.datetime_query import OffsetDatetime
from app.models.desktop_relay import DesktopUsage
from app.models.desktop_setup import DesktopSetup
from app.services.desktop_relay import DISCONNECTED_CODE, DesktopRelayError, touch_device

USAGE_LIMIT = "20/minute"  # per VERIFIED device (the device row, never a header), counted before anything is written — presence's frame; the host sends on change, coalesced, a few a minute at most
MAX_WINDOWS = 4
MAX_ACCOUNTS = 8  # entries in one report AND rows kept per computer (a person's CLIs and logins on one computer are few) — the oldest `seen_at` goes first
ACCOUNT_PATTERN = r"^[a-z0-9]{8,32}$"  # the host's opaque id of a settings folder (a hash prefix) — never a path, never a name
MAX_MINUTES = 525_600  # a year
RESET_HORIZON = timedelta(days=400)  # a reset time further ahead than this is not believed (a wrong unit · a broken source)


def _now() -> datetime:
    return datetime.now(timezone.utc)


class UsageWindowReport(BaseModel):
    model_config = ConfigDict(extra="forbid")

    kind: Literal["five_hour", "seven_day", "other"]
    minutes: StrictInt | None = Field(default=None, ge=1, le=MAX_MINUTES)  # (a whole number as written: not "5", not 5.0)
    used_percent: StrictInt = Field(ge=0, le=100)
    resets_at: OffsetDatetime | None = None


class UsageEntry(BaseModel):
    model_config = ConfigDict(extra="forbid")

    runtime: Literal["claude", "codex"]
    account: str = Field(pattern=ACCOUNT_PATTERN)
    seen_at: OffsetDatetime
    state: Literal["windows", "unavailable"]
    windows: list[UsageWindowReport] = Field(default_factory=list, max_length=MAX_WINDOWS)
    why: Literal["api_key", "not_read"] | None = None

    @model_validator(mode="after")
    def _shape(self) -> "UsageEntry":
        if self.state == "windows" and (not self.windows or self.why is not None):
            raise ValueError("windows: numbers and no reason")
        if self.state == "unavailable" and (self.windows or self.why is None):
            raise ValueError("unavailable: a reason and no numbers")
        return self


class UsageReport(BaseModel):
    model_config = ConfigDict(extra="forbid")

    usage: list[UsageEntry] = Field(min_length=1, max_length=MAX_ACCOUNTS)

    @model_validator(mode="after")
    def _one_per_cli(self) -> "UsageReport":
        if len({(u.runtime, u.account) for u in self.usage}) != len(self.usage):
            raise ValueError("one entry per CLI and account")
        return self


def _windows_json(entry: UsageEntry, now: datetime) -> list[dict]:
    out = []
    for w in entry.windows:
        resets = w.resets_at.astimezone(timezone.utc) if w.resets_at is not None else None
        if resets is not None and resets > now + RESET_HORIZON:
            raise DesktopRelayError(422, "usage_reset_out_of_range", "a reset time is further ahead than a window can be")
        out.append({"kind": w.kind, "minutes": w.minutes, "used_percent": w.used_percent, "resets_at": resets.isoformat() if resets is not None else None})
    return out


async def apply_usage(db: AsyncSession, setup: DesktopSetup, report: UsageReport) -> int:
    """The computer's report → the number of rows written (an older report writes none of its rows). Raises 409 `device_disconnected` for a closed computer."""
    # one report of a computer at a time (Kadir/codex: two racing reports could both count ≤ MAX_ACCOUNTS rows before either deletes — the row cap would not hold, and a row just written could be the one deleted)
    await db.execute(select(func.pg_advisory_xact_lock(func.hashtext(f"desktop_usage:{setup.id}"))))
    fresh = (await db.execute(select(DesktopSetup).where(DesktopSetup.id == setup.id).execution_options(populate_existing=True))).scalar_one()
    if fresh.revoked_at is not None:
        raise DesktopRelayError(409, DISCONNECTED_CODE, "this computer was disconnected")
    now = _now()
    written = 0
    for entry in report.usage:
        seen = min(entry.seen_at.astimezone(timezone.utc), now)  # the host's clock may run ahead: never a time in the future
        windows = _windows_json(entry, now) if entry.state == "windows" else []
        ins = pg_insert(DesktopUsage).values(setup_id=setup.id, runtime=entry.runtime, account=entry.account, state=entry.state, why=entry.why, windows=windows, seen_at=seen, reported_at=now)
        stmt = ins.on_conflict_do_update(
            index_elements=[DesktopUsage.setup_id, DesktopUsage.runtime, DesktopUsage.account],
            set_={"state": ins.excluded.state, "why": ins.excluded.why, "windows": ins.excluded.windows, "seen_at": ins.excluded.seen_at, "reported_at": ins.excluded.reported_at},
            where=DesktopUsage.seen_at <= ins.excluded.seen_at,  # a late, older report never covers a newer one
        )
        res = await db.execute(stmt)
        written += res.rowcount or 0
    # a computer keeps at most MAX_ACCOUNTS rows: past it the ones seen longest ago go (a report never grows the table without bound)
    keep = select(DesktopUsage.runtime, DesktopUsage.account).where(DesktopUsage.setup_id == setup.id).order_by(DesktopUsage.seen_at.desc(), DesktopUsage.runtime, DesktopUsage.account).limit(MAX_ACCOUNTS)
    kept = {(r, a) for r, a in (await db.execute(keep)).all()}
    for runtime, account in (await db.execute(select(DesktopUsage.runtime, DesktopUsage.account).where(DesktopUsage.setup_id == setup.id))).all():
        if (runtime, account) not in kept:
            await db.execute(delete(DesktopUsage).where(DesktopUsage.setup_id == setup.id, DesktopUsage.runtime == runtime, DesktopUsage.account == account))
    await touch_device(db, setup.id)  # the computer spoke (even a report that was older: it was heard)
    return written


def row_view(row: DesktopUsage) -> dict:
    """one stored row as the (later) reader will see it — the closed shape only"""
    return {"runtime": row.runtime, "account": row.account, "state": row.state, "why": row.why, "windows": row.windows, "seen_at": row.seen_at.isoformat()}
