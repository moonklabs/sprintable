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

import unicodedata
from datetime import datetime, timedelta, timezone
from typing import Literal

from pydantic import BaseModel, ConfigDict, Field, StrictInt, StrictStr, ValidationError, field_validator, model_validator
from sqlalchemy import delete, func, select
from sqlalchemy.dialects.postgresql import insert as pg_insert
from sqlalchemy.ext.asyncio import AsyncSession

from app.core.datetime_query import OffsetDatetime
from app.models.desktop_relay import DesktopUsage
from app.services.agent_runtime import DesktopRuntimeId
from app.models.desktop_setup import DesktopSetup
from app.services.desktop_relay import DISCONNECTED_CODE, DesktopRelayError, touch_heard

USAGE_LIMIT = "20/minute"  # per VERIFIED device (the device row, never a header), counted before anything is written — presence's frame; the host sends on change, coalesced, a few a minute at most
MAX_WINDOWS = 4
MAX_ACCOUNTS = 8  # entries in one report AND rows kept per computer (a person's CLIs and logins on one computer are few) — the oldest `seen_at` goes first
LABEL_MAX = 40  # characters (code points), as the host counts them
# a label is plain display text (the server decides nothing by it; the web shows it as text only). The rule: no character of the categories Cc (controls) · Cf (format: zero-width, word joiner, soft hyphen, BOM, bidirectional
# overrides and isolates …) · Cs · Co (private use) · Zl · Zp; no slash or backslash — nor a character that LOOKS like one (the fullwidth ／ ＼ · the division · fraction · set-minus slashes and the diagonals are listed one by one) — so a name cannot pass for a path; no space at either end. The server judges it itself (the host's check is not trusted); the host's table (desktop-electron `claude-account-labels.ts`) is the same, and
# tests/test_4986_usage_label_realdb.py pins both with the same cases (codex 11-20: the first table named a few code points and missed U+2060 and the fullwidth slash).
_LABEL_BAD_CATEGORIES = frozenset({"Cc", "Cf", "Cs", "Co", "Zl", "Zp"})
_SLASH_LIKE = frozenset("\\/\u2044\u2215\u2216\u29f5\u29f8\u29f9\ufe68\uff0f\uff3c\u2571\u2572\u27cb\u27cd")


def label_problem(text: object) -> str | None:
    """None = usable as a label; else the closed word of the first rule it breaks (`empty` · `too_long` · `bad_chars`)."""
    if not isinstance(text, str) or text == "":
        return "empty"
    if len(text) > LABEL_MAX:
        return "too_long"
    if any(unicodedata.category(c) in _LABEL_BAD_CATEGORIES for c in text) or any(c in _SLASH_LIKE for c in text) or text != text.strip():
        return "bad_chars"
    return None


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

    runtime: DesktopRuntimeId
    account: str = Field(pattern=ACCOUNT_PATTERN)
    seen_at: OffsetDatetime
    state: Literal["windows", "unavailable"]
    windows: list[UsageWindowReport] = Field(default_factory=list, max_length=MAX_WINDOWS)
    why: Literal["api_key", "not_read"] | None = None
    label: StrictStr | None = None  # story 4986: the name the person gave this account on the computer — display text only (nothing is decided by it); absent = none, and a report without it CLEARS the stored one

    @field_validator("label")
    @classmethod
    def _label(cls, v: str | None) -> str | None:
        if v is not None and (why := label_problem(v)) is not None:
            raise ValueError(f"label: {why}")
        return v

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


async def apply_usage(db: AsyncSession, setup: DesktopSetup, report: UsageReport, token: str | None = None) -> int:
    """The computer's report → the number of rows written (an older report writes none of its rows). Raises 409 `device_disconnected` for a closed computer."""
    # one report of a computer at a time (Kadir/codex: two racing reports could both count ≤ MAX_ACCOUNTS rows before either deletes — the row cap would not hold, and a row just written could be the one deleted)
    await db.execute(select(func.pg_advisory_xact_lock(func.hashtext(f"desktop_usage:{setup.id}"))))
    # the computer's row is read WITH A ROW LOCK (`with_for_update(key_share=True)` = PostgreSQL's FOR NO KEY UPDATE — the mode the disconnect's own UPDATE takes, so it waits for this transaction; the key itself is never touched, so
    # no foreign key waits on it) — Kadir 5854 low: a disconnect committed between this read and the writes below would otherwise leave rows on a closed computer
    fresh = (await db.execute(select(DesktopSetup).where(DesktopSetup.id == setup.id).with_for_update(key_share=True).execution_options(populate_existing=True))).scalar_one()
    if fresh.revoked_at is not None:
        raise DesktopRelayError(409, DISCONNECTED_CODE, "this computer was disconnected")
    now = _now()
    written = 0
    for entry in report.usage:
        seen = min(entry.seen_at.astimezone(timezone.utc), now)  # the host's clock may run ahead: never a time in the future
        windows = _windows_json(entry, now) if entry.state == "windows" else []
        ins = pg_insert(DesktopUsage).values(setup_id=setup.id, runtime=entry.runtime, account=entry.account, state=entry.state, why=entry.why, windows=windows, label=entry.label, seen_at=seen, reported_at=now)
        stmt = ins.on_conflict_do_update(
            index_elements=[DesktopUsage.setup_id, DesktopUsage.runtime, DesktopUsage.account],
            set_={"state": ins.excluded.state, "why": ins.excluded.why, "windows": ins.excluded.windows, "label": ins.excluded.label, "seen_at": ins.excluded.seen_at, "reported_at": ins.excluded.reported_at},
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
    await touch_heard(db, setup.id, token)  # the computer spoke (even a report that was older: it was heard) — `last_heard_at` only, never `last_used_at` (see touch_heard)
    return written


def row_view(row: DesktopUsage) -> dict | None:
    """one stored row as a reader sees it — judged AGAIN by the very model the door uses (Kadir 5854 · PR 3 condition): the table's CHECK holds the outer shape only, so a row written by anything but the door (a direct SQL
    write, a migration slip) could carry an odd element in `windows`. The row is read through `UsageEntry`; one that does not pass is LEFT OUT (never returned, never a 500), and what is returned is built from the model's
    own fields — not from the stored JSON — so no extra key can ride along. Returns None for a row that does not pass."""
    # a label that does not pass the rule (a direct write · a migration slip) is left OUT — the numbers still show, without a name (never the whole row lost for a name)
    safe_label = row.label if row.label is not None and label_problem(row.label) is None else None
    try:
        e = UsageEntry.model_validate({
            "runtime": row.runtime, "account": row.account, "seen_at": row.seen_at, "state": row.state, "why": row.why,
            "windows": row.windows if isinstance(row.windows, list) else None, "label": safe_label,
        })
    except ValidationError:
        return None
    return {
        "runtime": e.runtime, "account": e.account, "label": e.label, "state": e.state, "why": e.why,
        "windows": [{"kind": w.kind, "minutes": w.minutes, "used_percent": w.used_percent, "resets_at": w.resets_at.astimezone(timezone.utc).isoformat() if w.resets_at is not None else None} for w in e.windows],
        "seen_at": e.seen_at.astimezone(timezone.utc).isoformat(),
    }
