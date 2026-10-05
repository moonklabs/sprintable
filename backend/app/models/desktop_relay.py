"""story #4529 (E-DESKTOP-2 B-1 · alembic 0429) — the device relay: a device token apart from the agent keys, the sessions a
device reports and the commands sent down to it. Contract: doc «E-DESKTOP-2 B-1 — 기기 줄 계약 v1» (02d2cf71).

A device is one `desktop_setups` row. The lists below are the code side of the CHECK constraints in 0429 — a test holds the
two together (one changed alone → RED)."""
import uuid
from datetime import datetime

from sqlalchemy import Boolean, CheckConstraint, DateTime, ForeignKey, Index, Integer, Text, UniqueConstraint, func
from sqlalchemy.dialects.postgresql import JSONB, UUID
from sqlalchemy.orm import Mapped, mapped_column

from app.core.database import Base

COMMAND_KINDS = ("start_session", "send_prompt", "answer_approval", "stop_session")
COMMAND_STATES = ("queued", "delivered", "acked", "done", "failed", "rejected")
# a command's state moves forward only: queued → delivered → acked → one end
COMMAND_STATE_ORDER = {"queued": 0, "delivered": 1, "acked": 2, "done": 3, "failed": 3, "rejected": 3}
# story #4534 (0437 · contract v1.12): the board's own words — asked in the terminal · an error · paused at a usage limit
SESSION_STATES = ("starting", "working", "idle", "waiting_permission", "waiting_input", "error", "paused_limit", "stopped")
# the words a usage limit comes with (the only rows that may carry its why) · Claude's «may continue by itself»
SESSION_LIMIT_STATES = ("waiting_input", "error", "paused_limit")
SESSION_SELF_RESUME = ("maybe", "no", "unknown")
SESSION_RUNTIMES = ("claude", "codex")


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


class DesktopSession(Base):
    """A session the device's daemon reports (it is the only source — the server records, never guesses). `unknown` is not a
    stored state: it is shown when the device has gone silent (services.desktop_relay.UNKNOWN_AFTER)."""

    __tablename__ = "desktop_sessions"
    __table_args__ = (
        UniqueConstraint("setup_id", "session_key", name="uq_desktop_sessions_setup_key"),
        CheckConstraint(_in("state", SESSION_STATES), name="ck_desktop_sessions_state"),
        CheckConstraint(_in("runtime", SESSION_RUNTIMES), name="ck_desktop_sessions_runtime"),
        CheckConstraint(f"limit_self_resume IS NULL OR {_in('limit_self_resume', SESSION_SELF_RESUME)}", name="ck_desktop_sessions_limit_self_resume"),
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
    limited: Mapped[bool | None] = mapped_column(Boolean, nullable=True)
    limit_at: Mapped[datetime | None] = mapped_column(DateTime(timezone=True), nullable=True)
    limit_again: Mapped[bool | None] = mapped_column(Boolean, nullable=True)
    limit_self_resume: Mapped[str | None] = mapped_column(Text, nullable=True)
    # story #4534 (0438): whether the session can take an instruction into the running turn — hides [지금 지시] when not (only)
    instruct_now: Mapped[bool | None] = mapped_column(Boolean, nullable=True)


class DesktopCommand(Base):
    """A command sent down to a device: four kinds only (DB CHECK + COMMAND_KINDS), one row per idempotency key, numbered per
    device for the stream (`device_seq`), its state moving forward only. The daemon reports a code, never output."""

    __tablename__ = "desktop_commands"
    __table_args__ = (
        UniqueConstraint("setup_id", "idempotency_key", name="uq_desktop_commands_setup_idem"),
        UniqueConstraint("setup_id", "device_seq", name="uq_desktop_commands_setup_seq"),
        CheckConstraint(_in("kind", COMMAND_KINDS), name="ck_desktop_commands_kind"),
        CheckConstraint(_in("state", COMMAND_STATES), name="ck_desktop_commands_state"),
        Index("ix_desktop_commands_setup_state_seq", "setup_id", "state", "device_seq"),
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
