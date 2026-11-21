"""story #4529 (E-DESKTOP-2 B-1 · alembic 0429) — the device relay: a device token apart from the agent keys, the sessions a
device reports and the commands sent down to it. Contract: doc «E-DESKTOP-2 B-1 — 기기 줄 계약 v1» (02d2cf71).

A device is one `desktop_setups` row. The lists below are the code side of the CHECK constraints in 0429 — a test holds the
two together (one changed alone → RED)."""
import uuid
from datetime import datetime

from sqlalchemy import Boolean, CheckConstraint, DateTime, ForeignKey, Index, Integer, String, Text, UniqueConstraint, func, text
from sqlalchemy.dialects.postgresql import JSONB, UUID
from sqlalchemy.orm import Mapped, mapped_column

from app.core.database import Base

# story #4599 (0443 · contract v1.13.2 · PO 14:08Z): `end_session` — a person's signed end of the whole session (the one handle on
# a turn held by a macOS window, where a stop cannot reach); always ends, what was signed is what happens
# story #4733 (0459 · S2 · design 4733-phone-clock-design-1020.md): `clock` — a person's signed clock-out / clock-in of one whole computer from the phone;
# the word is one, the choice (out_open · out_submit · out_cancel · in) is the payload's `action` (so a new action needs no migration)
# story #4951 (0477 · ①a): `read_changes` — the computer's pairing person asks for the LIST of changed files of one session's folder (names · status word · line counts, never content); payload exactly {session_key}
# story 4983 (0488 · P5): `file_list` — a person's SEALED request to list a folder of a project on their own computer; payload exactly {project_id, envelope} (no session, no path — the computer maps the project to a folder of its own)
# story 4983 (0491 · P6): `file_read` — the same road to OPEN one file of a project (text or a small picture); payload exactly the same {project_id, envelope}: the folder and the file's name are inside the sealed request
# story 4988 (0492 · P8): `file_download` — the same road to DOWNLOAD one file (up to 8 MiB, as sealed chunks); payload exactly the same {project_id, envelope}
COMMAND_KINDS = ("start_session", "send_prompt", "answer_approval", "stop_session", "end_session", "clock", "read_changes", "file_list", "file_read", "file_download")
COMMAND_STATES = ("queued", "delivered", "acked", "done", "failed", "rejected")
# a command's state moves forward only: queued → delivered → acked → one end
COMMAND_STATE_ORDER = {"queued": 0, "delivered": 1, "acked": 2, "done": 3, "failed": 3, "rejected": 3}
# story #4534 (0437 · contract v1.12): the board's own words — asked in the terminal · an error · paused at a usage limit
# story #4599 (0442 · contract v1.13): `waiting_system` — the turn is held by a macOS window on that computer (a folder-access
# question the person at the Mac must answer); a working word to a reader from before (legacy_state), never a resting one
SESSION_STATES = ("starting", "working", "idle", "waiting_permission", "waiting_input", "error", "paused_limit", "waiting_system", "stopped")
# the words a usage limit comes with (the only rows that may carry its why) · Claude's «may continue by itself»
SESSION_LIMIT_STATES = ("waiting_input", "error", "paused_limit")
SESSION_SELF_RESUME = ("maybe", "no", "unknown")
# story #4599 (0442 · contract v1.13 · Kadir lens ③): the folder a macOS window asks about — a closed list, carried with
# `waiting_system` only (the daemon read it from tccd's service name; a window seen by owner only carries none)
# story #4779 (0466 · AC3): why work waits for an agent whose computer cannot confirm / has lost the link to its Sprintable tools — a closed list, one word, no path
SESSION_WORK_HOLD_WHYS = ("tools_unconfirmed", "tools_failed")
SESSION_SYSTEM_FOLDERS = ("documents", "desktop", "downloads", "network_volume", "icloud")
# story #4641 (0449 · design 4641 · Kadir lens conditional pass): the permission mode a person widened at the terminal — the closed
# list (the daemon sends only these; a mode it does not know is not sent). The order (plan < default < acceptEdits < auto <
# dontAsk, bypassPermissions — measured on the daemon, 10-08) is the daemon's alone; the server checks the list and from ≠ to.
SESSION_WIDENED_MODES = ("plan", "default", "acceptEdits", "auto", "dontAsk", "bypassPermissions")
# story #4560 (0444 · contract v2.1 §5 · PO 14:41Z): the daemon did not touch a session whose limit should be over — the terminal's
# screen was not the expected one (`screen`), or the one Esc it sent was not taken (`esc_not_taken`)
SESSION_LIMIT_HELD = ("screen", "esc_not_taken")
# story #4684 (0454): why a computer's subscription for an agent is stopped — the app board's own closed words (the daemon's InboxStreamStatus stops)
SESSION_INBOX_STREAMS = ("stopped_other_receiver", "stopped_taken_over", "stopped_auth", "stopped_inbox_full")
# story #4763 (0465): the first-screen question that stands at a computer (one closed word — the daemon's own list, 4528: folder trust · Claude's new-MCP-server(s) question · Codex's update)
SESSION_FIRST_SCREEN_ASKS = ("trust", "mcp", "mcp_many", "update")
SESSION_RUNTIMES = ("claude", "codex")
# story #4733 (0459): the clock view a computer reports. A row exists while a flow is open (panel · out · in) — or, in mode `none`, only while some agents stand
# clocked out one by one (`outs`: ids and times, so the phone can draw each one's [출근]); a `none` report with nothing in it deletes the row
CLOCK_VIEW_MODES = ("none", "panel", "out", "in")


def _in(column: str, values: tuple[str, ...]) -> str:
    return f"{column} IN ({', '.join(repr(v) for v in values)})"


class DesktopDeviceToken(Base):
    """The device's own credential: issued with the exchange (one active per device), only for /api/v2/desktop/relay/*, revoked
    with the device. Only its SHA-256 is kept."""

    __tablename__ = "desktop_device_tokens"

    id: Mapped[uuid.UUID] = mapped_column(UUID(as_uuid=True), primary_key=True, default=uuid.uuid4)
    setup_id: Mapped[uuid.UUID] = mapped_column(
        UUID(as_uuid=True), ForeignKey("desktop_setups.id", ondelete="CASCADE"), nullable=False, index=True,
    )
    token_hash: Mapped[str] = mapped_column(Text, nullable=False, unique=True)
    issued_at: Mapped[datetime] = mapped_column(DateTime(timezone=True), server_default=func.now(), nullable=False)
    revoked_at: Mapped[datetime | None] = mapped_column(DateTime(timezone=True), nullable=True)
    last_used_at: Mapped[datetime | None] = mapped_column(DateTime(timezone=True), nullable=True)
    # story 4979: «the computer itself spoke» — stamped ONLY by what the device sends (the stream connect · its reports and acks · `POST /relay/presence`), never by the server's own 30-second tick (which keeps
    # `last_used_at` fresh for a stream whose peer is gone — measured 11-18: up to 5 min 20 s after the computer fell silent). The phone's «last seen N min ago» and the new «disconnected» rule read this.
    last_heard_at: Mapped[datetime | None] = mapped_column(DateTime(timezone=True), nullable=True)
    # story 4979: the last time the device sent its own `presence` (a host version that sends none keeps this empty — its «disconnected» rule stays the old 90 s one)
    last_presence_at: Mapped[datetime | None] = mapped_column(DateTime(timezone=True), nullable=True)


class DesktopSession(Base):
    """A session the device's daemon reports (it is the only source — the server records, never guesses). `unknown` is not a
    stored state: it is shown when the device has gone silent (services.desktop_relay.UNKNOWN_AFTER)."""

    __tablename__ = "desktop_sessions"
    __table_args__ = (
        UniqueConstraint("setup_id", "session_key", name="uq_desktop_sessions_setup_key"),
        CheckConstraint(_in("state", SESSION_STATES), name="ck_desktop_sessions_state"),
        CheckConstraint(_in("runtime", SESSION_RUNTIMES), name="ck_desktop_sessions_runtime"),
        CheckConstraint(f"limit_self_resume IS NULL OR {_in('limit_self_resume', SESSION_SELF_RESUME)}", name="ck_desktop_sessions_limit_self_resume"),
        CheckConstraint(f"system_folder IS NULL OR {_in('system_folder', SESSION_SYSTEM_FOLDERS)}", name="ck_desktop_sessions_system_folder"),
        CheckConstraint(f"permission_widened_from IS NULL OR {_in('permission_widened_from', SESSION_WIDENED_MODES)}", name="ck_desktop_sessions_widened_from"),
        CheckConstraint(f"permission_widened_to IS NULL OR {_in('permission_widened_to', SESSION_WIDENED_MODES)}", name="ck_desktop_sessions_widened_to"),
        CheckConstraint(
            "(permission_widened_at IS NULL) = (permission_widened_from IS NULL) AND (permission_widened_from IS NULL) = (permission_widened_to IS NULL)",
            name="ck_desktop_sessions_widened_all_or_none",
        ),
        # story #4641 (lens ② on 5028): from ≠ to in the DB too — the API check alone let ('auto','auto') through a probe
        CheckConstraint(
            "permission_widened_from IS NULL OR permission_widened_from IS DISTINCT FROM permission_widened_to",
            name="ck_desktop_sessions_widened_distinct",
        ),
        CheckConstraint(f"limit_held IS NULL OR {_in('limit_held', SESSION_LIMIT_HELD)}", name="ck_desktop_sessions_limit_held"),
        # story #4686 (0453): the run info's own caps in the DB too
        CheckConstraint("run_model IS NULL OR char_length(run_model) <= 70", name="ck_desktop_sessions_run_model_len"),
        CheckConstraint("run_account IS NULL OR char_length(run_account) <= 80", name="ck_desktop_sessions_run_account_len"),
        CheckConstraint("run_effort IS NULL OR run_effort IN ('low','medium','high','xhigh','max','ultra')", name="ck_desktop_sessions_run_effort"),
        # story #4684 (0454): the receive stop's closed set in the DB too
        CheckConstraint(f"inbox_stream IS NULL OR {_in('inbox_stream', SESSION_INBOX_STREAMS)}", name="ck_desktop_sessions_inbox_stream"),
        # story #4763 (0465): the first-screen question's closed set in the DB too
        CheckConstraint(f"first_screen_ask IS NULL OR {_in('first_screen_ask', SESSION_FIRST_SCREEN_ASKS)}", name="ck_desktop_sessions_first_screen_ask"),
        # story #4779 (0466): the work hold's closed set in the DB too
        CheckConstraint(f"work_hold_why IS NULL OR {_in('work_hold_why', SESSION_WORK_HOLD_WHYS)}", name="ck_desktop_sessions_work_hold_why"),
        # story 4781 (0467): the sweep reads only the few rows that carry a waiting lift — a partial index keeps that read off the whole table
        Index("ix_desktop_sessions_limit_cleared_at", "limit_cleared_at", postgresql_where=text("limit_cleared_at IS NOT NULL")),
    )

    id: Mapped[uuid.UUID] = mapped_column(UUID(as_uuid=True), primary_key=True, default=uuid.uuid4)
    setup_id: Mapped[uuid.UUID] = mapped_column(
        UUID(as_uuid=True), ForeignKey("desktop_setups.id", ondelete="CASCADE"), nullable=False,
    )
    session_key: Mapped[str] = mapped_column(Text, nullable=False)
    agent_member_id: Mapped[uuid.UUID] = mapped_column(UUID(as_uuid=True), nullable=False)
    runtime: Mapped[str] = mapped_column(Text, nullable=False)
    state: Mapped[str] = mapped_column(Text, nullable=False)
    last_report_seq: Mapped[int] = mapped_column(Integer, nullable=False)
    state_at: Mapped[datetime] = mapped_column(DateTime(timezone=True), nullable=False)
    created_at: Mapped[datetime] = mapped_column(DateTime(timezone=True), server_default=func.now(), nullable=False)
    ended_at: Mapped[datetime | None] = mapped_column(DateTime(timezone=True), nullable=True)
    # story #4534 (0437): a usage limit's why — on a limit word only (services.desktop_relay)
    # story #4599: the folder the macOS window asks about (waiting_system only · a closed list · never a path)
    system_folder: Mapped[str | None] = mapped_column(Text, nullable=True)
    # story #4641 (0449): the latest widening a person made at the terminal — three columns, all set or none (the CHECK above)
    permission_widened_at: Mapped[datetime | None] = mapped_column(DateTime(timezone=True), nullable=True)
    permission_widened_from: Mapped[str | None] = mapped_column(Text, nullable=True)
    permission_widened_to: Mapped[str | None] = mapped_column(Text, nullable=True)
    limited: Mapped[bool | None] = mapped_column(Boolean, nullable=True)
    limit_at: Mapped[datetime | None] = mapped_column(DateTime(timezone=True), nullable=True)
    limit_again: Mapped[bool | None] = mapped_column(Boolean, nullable=True)
    limit_self_resume: Mapped[str | None] = mapped_column(Text, nullable=True)
    # story #4560 (0444): the daemon held off — the limit's time is over but it did not touch the terminal (screen · esc_not_taken)
    limit_held: Mapped[str | None] = mapped_column(Text, nullable=True)
    # story #4685 (0452): the daemon looks at this limit again by itself (its reset time is unknown) — the words may promise it
    limit_looks: Mapped[bool | None] = mapped_column(Boolean, nullable=True)
    # story #4686 (0453): what the session really runs on — the model that ran · whether the profile named one · the thinking depth ·
    # the account's display label (Claude only; masked by the daemon). All set by the report that carries `run`.
    run_model: Mapped[str | None] = mapped_column(Text, nullable=True)
    run_model_set: Mapped[bool | None] = mapped_column(Boolean, nullable=True)
    run_effort: Mapped[str | None] = mapped_column(Text, nullable=True)
    run_account: Mapped[str | None] = mapped_column(Text, nullable=True)
    # story #4684 (0454): why this computer's subscription for the agent is stopped (the board's closed words) — set by the report that carries `inbox`
    inbox_stream: Mapped[str | None] = mapped_column(Text, nullable=True)
    # story #4534 (0438): whether the session can take an instruction into the running turn — hides [지금 지시] when not (only)
    instruct_now: Mapped[bool | None] = mapped_column(Boolean, nullable=True)
    # story #4763 (0465): the first-screen question that stands at that computer (`trust`) — set by the report that carries `first_screen`
    first_screen_ask: Mapped[str | None] = mapped_column(Text, nullable=True)
    # story #4779 (0466): why work waits for this agent (`tools_unconfirmed` · `tools_failed`) — set by the report that carries `work_hold`
    work_hold_why: Mapped[str | None] = mapped_column(Text, nullable=True)
    # story 4781 (AC2): when the report that took the limit away came — the «working again» notice waits for the hold; NULL = none waiting
    limit_cleared_at: Mapped[datetime | None] = mapped_column(DateTime(timezone=True), nullable=True)


class DesktopCommand(Base):
    """A command sent down to a device: five kinds only (DB CHECK + COMMAND_KINDS), one row per idempotency key, numbered per
    device for the stream (`device_seq`), its state moving forward only. The daemon reports a code, never output."""

    __tablename__ = "desktop_commands"
    __table_args__ = (
        UniqueConstraint("setup_id", "idempotency_key", name="uq_desktop_commands_setup_idem"),
        UniqueConstraint("setup_id", "device_seq", name="uq_desktop_commands_setup_seq"),
        CheckConstraint(_in("kind", COMMAND_KINDS), name="ck_desktop_commands_kind"),
        CheckConstraint(_in("state", COMMAND_STATES), name="ck_desktop_commands_state"),
        Index("ix_desktop_commands_setup_state_seq", "setup_id", "state", "device_seq"),
        # story #4951 (0477): the person's pause between two «changed files» asks reads their last ask — only those rows are in this index
        Index("ix_desktop_commands_read_changes_by", "requested_by", "created_at", postgresql_where=text("kind = 'read_changes'")),
        # story 4976 (0486): the minute sweep of instruction copies reads the open ones older than ten minutes and the finished ones of the last day — one partial index each
        Index("ix_desktop_commands_prompt_open_created", "created_at", postgresql_where=text("kind = 'send_prompt' AND state IN ('queued', 'delivered', 'acked')")),
        Index("ix_desktop_commands_prompt_ended_created", "created_at", postgresql_where=text("kind = 'send_prompt' AND state IN ('done', 'failed', 'rejected')")),
    )

    id: Mapped[uuid.UUID] = mapped_column(UUID(as_uuid=True), primary_key=True, default=uuid.uuid4)
    setup_id: Mapped[uuid.UUID] = mapped_column(
        UUID(as_uuid=True), ForeignKey("desktop_setups.id", ondelete="CASCADE"), nullable=False,
    )
    device_seq: Mapped[int] = mapped_column(Integer, nullable=False)
    kind: Mapped[str] = mapped_column(Text, nullable=False)
    session_key: Mapped[str | None] = mapped_column(Text, nullable=True)
    payload: Mapped[dict] = mapped_column(JSONB, nullable=False)
    idempotency_key: Mapped[str] = mapped_column(Text, nullable=False)
    requested_by: Mapped[uuid.UUID] = mapped_column(UUID(as_uuid=True), nullable=False)
    state: Mapped[str] = mapped_column(Text, nullable=False, server_default="queued")
    result_code: Mapped[str | None] = mapped_column(Text, nullable=True)
    created_at: Mapped[datetime] = mapped_column(DateTime(timezone=True), server_default=func.now(), nullable=False)
    delivered_at: Mapped[datetime | None] = mapped_column(DateTime(timezone=True), nullable=True)
    acked_at: Mapped[datetime | None] = mapped_column(DateTime(timezone=True), nullable=True)
    finished_at: Mapped[datetime | None] = mapped_column(DateTime(timezone=True), nullable=True)
    # story #4534 (0434) — a [지금 지시]'s conversation, and its turn's end told once to the person who sent it
    conversation_id: Mapped[uuid.UUID | None] = mapped_column(UUID(as_uuid=True), nullable=True)
    turn_end_notified_at: Mapped[datetime | None] = mapped_column(DateTime(timezone=True), nullable=True)


class DesktopClockView(Base):
    """story #4733 (0459): the latest closed clock view of one computer — at most one row per computer, only while a flow is open or some agents stand clocked
    out one by one (an empty `none` report deletes it; `expires_at` ends it otherwise). Holds the draft's first lines while the clock-out is being drafted: read by the paired phone of a person who
    may command that computer, never logged. The report numbering lives on desktop_setups (`clock_view_seq`), not here, so a deleted row cannot be brought
    back by a late lower-numbered report."""

    __tablename__ = "desktop_clock_views"
    __table_args__ = (CheckConstraint(_in("mode", CLOCK_VIEW_MODES), name="ck_desktop_clock_views_mode"),)

    setup_id: Mapped[uuid.UUID] = mapped_column(
        UUID(as_uuid=True), ForeignKey("desktop_setups.id", ondelete="CASCADE"), primary_key=True,
    )
    mode: Mapped[str] = mapped_column(Text, nullable=False)
    view: Mapped[dict] = mapped_column(JSONB, nullable=False)
    reported_at: Mapped[datetime] = mapped_column(DateTime(timezone=True), server_default=func.now(), nullable=False)
    expires_at: Mapped[datetime] = mapped_column(DateTime(timezone=True), nullable=False)


class DesktopUsage(Base):
    """story 4981 (0487): the computer's last known agent usage, one row per (computer, CLI, account) — closed numbers the host read (see the migration). Written only through the device's own
    `PUT /relay/usage`; `seen_at` is the host's time (the phone's «마지막으로 본 지»), `reported_at` the server's. Never logged."""

    __tablename__ = "desktop_usage"
    __table_args__ = (
        CheckConstraint("runtime IN ('claude', 'codex')", name="ck_desktop_usage_runtime"),
        CheckConstraint("account ~ '^[a-z0-9]{8,32}$'", name="ck_desktop_usage_account"),
        CheckConstraint("state IN ('windows', 'unavailable')", name="ck_desktop_usage_state"),
        CheckConstraint("why IS NULL OR why IN ('api_key', 'not_read')", name="ck_desktop_usage_why"),
        CheckConstraint("label IS NULL OR char_length(label) BETWEEN 1 AND 40", name="ck_desktop_usage_label"),  # 0490 — the length; the rest of the rule is the door's (desktop_usage.label_problem) and the reader's
        # the two shapes are the only ones: numbers (no reason · 1–4 windows) or the word (a reason · no numbers) — the same text as the migration (0487)
        CheckConstraint(
            "(state = 'windows' AND why IS NULL AND jsonb_typeof(windows) = 'array' AND jsonb_array_length(windows) BETWEEN 1 AND 4)"
            " OR (state = 'unavailable' AND why IS NOT NULL AND windows = '[]'::jsonb)",
            name="ck_desktop_usage_shape",
        ),
    )

    setup_id: Mapped[uuid.UUID] = mapped_column(UUID(as_uuid=True), ForeignKey("desktop_setups.id", ondelete="CASCADE"), primary_key=True)
    runtime: Mapped[str] = mapped_column(Text, primary_key=True)
    account: Mapped[str] = mapped_column(Text, primary_key=True)  # an opaque short id of the CLI's settings folder (never a path)
    state: Mapped[str] = mapped_column(Text, nullable=False)
    why: Mapped[str | None] = mapped_column(Text, nullable=True)
    windows: Mapped[list] = mapped_column(JSONB, nullable=False, server_default=text("'[]'::jsonb"))
    label: Mapped[str | None] = mapped_column(Text, nullable=True)  # story 4986 (0490): the name the person gave the account on the computer — display text only
    seen_at: Mapped[datetime] = mapped_column(DateTime(timezone=True), nullable=False)
    reported_at: Mapped[datetime] = mapped_column(DateTime(timezone=True), server_default=func.now(), nullable=False)


class DesktopChangesRead(Base):
    """story #4951 (0477 · ①a · Kadir lens A · E · I): one short-lived read of a session folder's changed-file LIST. Who asked (`viewer_id`), which computer (`setup_id`) and
    the command it travels in are fixed when the row is made; the computer's list (`payload`: names · a status word · line counts — no content) is written once and is
    deleted the moment the viewer reads it, at `expires_at` (asked + 120 s), with its command, and when its computer is disconnected / its pairing person's account is closed
    / the organization's remote control is turned off. Never logged."""

    __tablename__ = "desktop_changes_reads"
    __table_args__ = (
        CheckConstraint("(payload IS NULL) = (written_at IS NULL)", name="ck_desktop_changes_reads_written"),
        Index("ix_desktop_changes_reads_expires_at", "expires_at"),
        Index("ix_desktop_changes_reads_setup_created", "setup_id", "created_at"),
    )

    command_id: Mapped[uuid.UUID] = mapped_column(
        UUID(as_uuid=True), ForeignKey("desktop_commands.id", ondelete="CASCADE"), primary_key=True,
    )
    setup_id: Mapped[uuid.UUID] = mapped_column(
        UUID(as_uuid=True), ForeignKey("desktop_setups.id", ondelete="CASCADE"), nullable=False,
    )
    viewer_id: Mapped[uuid.UUID] = mapped_column(UUID(as_uuid=True), nullable=False)
    agent_member_id: Mapped[uuid.UUID] = mapped_column(UUID(as_uuid=True), nullable=False)  # the agent the read was asked for: the session key alone can pass to another agent later
    created_at: Mapped[datetime] = mapped_column(DateTime(timezone=True), server_default=func.now(), nullable=False)
    expires_at: Mapped[datetime] = mapped_column(DateTime(timezone=True), nullable=False)
    payload: Mapped[dict | None] = mapped_column(JSONB, nullable=True)
    written_at: Mapped[datetime | None] = mapped_column(DateTime(timezone=True), nullable=True)
    polled_at: Mapped[datetime | None] = mapped_column(DateTime(timezone=True), nullable=True)  # the last look at this pending read (one per second per read)


class DesktopFileRead(Base):
    """story 4983 (0488 · P5): one short-lived request to LIST a folder of a project on a person's own computer. Who asked (`viewer_id`), which computer (`setup_id`), which project and the press's own key are fixed when
    the row is made; the computer's SEALED answer (`payload` = {"envelope": …} — the server cannot open it: no name, no path, no word of what the folder holds) is written once and is deleted the moment the viewer reads
    it, at `expires_at` (asked + 10 minutes), with its command, and when its computer is disconnected / its pairing person's account is closed / the organization's remote control is turned off. Never logged."""

    __tablename__ = "desktop_file_reads"
    __table_args__ = (
        CheckConstraint("(payload IS NULL) = (written_at IS NULL)", name="ck_desktop_file_reads_written"),
        CheckConstraint("chunks_read >= 0 AND chunks_read <= chunks_written AND chunks_written <= 57", name="ck_desktop_file_reads_chunks"),  # story 4988 (0492)
        Index("ix_desktop_file_reads_expires_at", "expires_at"),
        Index("ix_desktop_file_reads_setup_created", "setup_id", "created_at"),
    )

    command_id: Mapped[uuid.UUID] = mapped_column(UUID(as_uuid=True), ForeignKey("desktop_commands.id", ondelete="CASCADE"), primary_key=True)
    setup_id: Mapped[uuid.UUID] = mapped_column(UUID(as_uuid=True), ForeignKey("desktop_setups.id", ondelete="CASCADE"), nullable=False)
    viewer_id: Mapped[uuid.UUID] = mapped_column(UUID(as_uuid=True), nullable=False)
    project_id: Mapped[uuid.UUID] = mapped_column(UUID(as_uuid=True), nullable=False)  # the project the request was asked for: the answer's header must name it
    press_key: Mapped[str] = mapped_column(String(100), nullable=False)  # the press's own key: the answer's header `command_id` must be it
    created_at: Mapped[datetime] = mapped_column(DateTime(timezone=True), server_default=func.now(), nullable=False)
    expires_at: Mapped[datetime] = mapped_column(DateTime(timezone=True), nullable=False)
    payload: Mapped[dict | None] = mapped_column(JSONB, nullable=True)
    written_at: Mapped[datetime | None] = mapped_column(DateTime(timezone=True), nullable=True)
    polled_at: Mapped[datetime | None] = mapped_column(DateTime(timezone=True), nullable=True)
    # story 4988 (0492 · P8): a DOWNLOAD's chunks are put (`chunks_written`) and taken (`chunks_read`) in order; the server holds at most CHUNKS_AHEAD_MAX unread ones (a `file_list`/`file_read` row keeps both at 0)
    chunks_written: Mapped[int] = mapped_column(Integer, nullable=False, server_default="0")
    chunks_read: Mapped[int] = mapped_column(Integer, nullable=False, server_default="0")


class DesktopFileChunk(Base):
    """story 4988 (0492 · P8): one SEALED chunk of a download (`payload` = {"envelope": …}: the server cannot open it — no name, no word, no byte of the file). Put by the computer once, deleted the moment the person reads it; it hangs from its
    request's row (`desktop_file_reads.command_id`, ON DELETE CASCADE) so every end of that row takes its chunks with it."""

    __tablename__ = "desktop_file_chunks"
    __table_args__ = (CheckConstraint("i >= 0 AND i < 57", name="ck_desktop_file_chunks_i"),)

    command_id: Mapped[uuid.UUID] = mapped_column(UUID(as_uuid=True), ForeignKey("desktop_file_reads.command_id", ondelete="CASCADE"), primary_key=True)
    i: Mapped[int] = mapped_column(Integer, primary_key=True)
    payload: Mapped[dict] = mapped_column(JSONB, nullable=False)
    written_at: Mapped[datetime] = mapped_column(DateTime(timezone=True), server_default=func.now(), nullable=False)


class DesktopRecordHandoff(Base):
    """story 4978 (0494 · C2): one SEALED `record_handoff` envelope in flight between a computer and a phone that are paired (the record key R travels inside, wrapped to ONE receiver: the server cannot open it and sees a shape and
    one fixed size). Addressed by the pair — (`setup_id`, `remote_device_id`) — and a direction; deleted the moment the receiver says it has it, and anyway at `expires_at`; a computer or a phone that goes takes what was addressed to it
    (ON DELETE CASCADE)."""

    __tablename__ = "desktop_record_handoffs"
    __table_args__ = (
        CheckConstraint("direction IN ('host_to_phone', 'phone_to_host')", name="ck_desktop_record_handoffs_direction"),
        CheckConstraint("char_length(command_id) BETWEEN 1 AND 64", name="ck_desktop_record_handoffs_command_id"),
        UniqueConstraint("setup_id", "remote_device_id", "direction", "command_id", name="uq_desktop_record_handoffs_one_envelope"),
        Index("ix_desktop_record_handoffs_pair", "setup_id", "remote_device_id", "direction", "created_at"),
        Index("ix_desktop_record_handoffs_phone", "remote_device_id", "direction", "created_at"),
        Index("ix_desktop_record_handoffs_expires", "expires_at"),
    )

    id: Mapped[uuid.UUID] = mapped_column(UUID(as_uuid=True), primary_key=True, default=uuid.uuid4)
    setup_id: Mapped[uuid.UUID] = mapped_column(UUID(as_uuid=True), ForeignKey("desktop_setups.id", ondelete="CASCADE"), nullable=False)
    remote_device_id: Mapped[uuid.UUID] = mapped_column(UUID(as_uuid=True), ForeignKey("remote_devices.id", ondelete="CASCADE"), nullable=False)
    direction: Mapped[str] = mapped_column(Text, nullable=False)
    command_id: Mapped[str] = mapped_column(Text, nullable=False)
    envelope: Mapped[dict] = mapped_column(JSONB, nullable=False)
    created_at: Mapped[datetime] = mapped_column(DateTime(timezone=True), server_default=func.now(), nullable=False)
    expires_at: Mapped[datetime] = mapped_column(DateTime(timezone=True), nullable=False)


class DesktopChangesAudit(Base):
    """story #4951 (0477 · Kadir lens G): one line per changed-file list a person actually read — who · which computer · which command · how many files · when. No name, no content.
    No foreign key to the computer or the command (the line outlives a disconnect); it goes with its organization."""

    __tablename__ = "desktop_changes_audit"
    __table_args__ = (
        Index("ix_desktop_changes_audit_org_created", "org_id", "created_at"),
        Index("ix_desktop_changes_audit_created", "created_at"),  # the 90-day sweep
    )

    id: Mapped[uuid.UUID] = mapped_column(UUID(as_uuid=True), primary_key=True, default=uuid.uuid4)
    org_id: Mapped[uuid.UUID] = mapped_column(UUID(as_uuid=True), ForeignKey("organizations.id", ondelete="CASCADE"), nullable=False)
    viewer_id: Mapped[uuid.UUID] = mapped_column(UUID(as_uuid=True), nullable=False)
    setup_id: Mapped[uuid.UUID] = mapped_column(UUID(as_uuid=True), nullable=False)
    command_id: Mapped[uuid.UUID] = mapped_column(UUID(as_uuid=True), nullable=False)
    file_count: Mapped[int] = mapped_column(Integer, nullable=False)
    created_at: Mapped[datetime] = mapped_column(DateTime(timezone=True), server_default=func.now(), nullable=False)


class DesktopDeviceTokenCode(Base):
    """story #4548 — a short, single-use code that lets an already set-up device get its device token by a person's
    confirmation (an owner/admin of its org), exchanged with the app's PKCE verifier. Asked with that setup's own agent key;
    the key never gets a token itself. Only the code's hash is kept."""

    __tablename__ = "desktop_device_token_codes"
    __table_args__ = (UniqueConstraint("code_hash", name="uq_desktop_device_token_codes_code_hash"),)

    id: Mapped[uuid.UUID] = mapped_column(UUID(as_uuid=True), primary_key=True, default=uuid.uuid4)
    setup_id: Mapped[uuid.UUID] = mapped_column(
        UUID(as_uuid=True), ForeignKey("desktop_setups.id", ondelete="CASCADE"), nullable=False, index=True,
    )
    code_hash: Mapped[str] = mapped_column(Text, nullable=False)
    code_challenge: Mapped[str] = mapped_column(Text, nullable=False)
    expires_at: Mapped[datetime] = mapped_column(DateTime(timezone=True), nullable=False)
    confirmed_by: Mapped[uuid.UUID | None] = mapped_column(UUID(as_uuid=True), nullable=True)
    confirmed_at: Mapped[datetime | None] = mapped_column(DateTime(timezone=True), nullable=True)
    exchanged_at: Mapped[datetime | None] = mapped_column(DateTime(timezone=True), nullable=True)
    created_at: Mapped[datetime] = mapped_column(DateTime(timezone=True), server_default=func.now(), nullable=False)
