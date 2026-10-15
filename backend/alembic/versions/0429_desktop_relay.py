"""story #4529 (E-DESKTOP-2 B-1) — the device relay: device tokens, the sessions a device reports, the commands sent down to it.

- desktop_device_tokens: the device's own credential (issued with the exchange, apart from the agent keys; only its SHA-256;
  revoked with the device) — valid for /api/v2/desktop/relay/* only.
- desktop_sessions: what the device's daemon reports (state CHECK; `unknown` is computed on read, never stored).
- desktop_commands: four kinds only (CHECK — models.desktop_relay.COMMAND_KINDS is the code side), one row per idempotency key,
  numbered per device; the state moves forward only.
- desktop_setups.relay_command_seq: the last device_seq handed out (the stream's event id).
"""
import sqlalchemy as sa
from sqlalchemy.dialects import postgresql

from alembic import op

revision = "0429"
down_revision = "0428"
branch_labels = None
depends_on = None

_KINDS = ("start_session", "send_prompt", "answer_approval", "stop_session")
_CMD_STATES = ("queued", "delivered", "acked", "done", "failed", "rejected")
_SESSION_STATES = ("starting", "working", "idle", "waiting_permission", "stopped")
_RUNTIMES = ("claude", "codex")


def _in(column: str, values: tuple[str, ...]) -> str:
    return f"{column} IN ({', '.join(repr(v) for v in values)})"


def upgrade() -> None:
    op.add_column("desktop_setups", sa.Column("relay_command_seq", sa.Integer(), nullable=False, server_default="0"))
    op.create_table(
        "desktop_device_tokens",
        sa.Column("id", postgresql.UUID(as_uuid=True), primary_key=True),
        sa.Column("setup_id", postgresql.UUID(as_uuid=True), sa.ForeignKey("desktop_setups.id", ondelete="CASCADE"), nullable=False),
        sa.Column("token_hash", sa.Text(), nullable=False, unique=True),
        sa.Column("issued_at", sa.DateTime(timezone=True), server_default=sa.func.now(), nullable=False),
        sa.Column("revoked_at", sa.DateTime(timezone=True), nullable=True),
        sa.Column("last_used_at", sa.DateTime(timezone=True), nullable=True),
    )
    op.create_index("ix_desktop_device_tokens_setup_id", "desktop_device_tokens", ["setup_id"])
    op.create_table(
        "desktop_sessions",
        sa.Column("id", postgresql.UUID(as_uuid=True), primary_key=True),
        sa.Column("setup_id", postgresql.UUID(as_uuid=True), sa.ForeignKey("desktop_setups.id", ondelete="CASCADE"), nullable=False),
        sa.Column("session_key", sa.Text(), nullable=False),
        sa.Column("agent_member_id", postgresql.UUID(as_uuid=True), nullable=False),
        sa.Column("runtime", sa.Text(), nullable=False),
        sa.Column("state", sa.Text(), nullable=False),
        sa.Column("last_report_seq", sa.Integer(), nullable=False),
        sa.Column("state_at", sa.DateTime(timezone=True), nullable=False),
        sa.Column("created_at", sa.DateTime(timezone=True), server_default=sa.func.now(), nullable=False),
        sa.Column("ended_at", sa.DateTime(timezone=True), nullable=True),
        sa.UniqueConstraint("setup_id", "session_key", name="uq_desktop_sessions_setup_key"),
        sa.CheckConstraint(_in("state", _SESSION_STATES), name="ck_desktop_sessions_state"),
        sa.CheckConstraint(_in("runtime", _RUNTIMES), name="ck_desktop_sessions_runtime"),
    )
    op.create_table(
        "desktop_commands",
        sa.Column("id", postgresql.UUID(as_uuid=True), primary_key=True),
        sa.Column("setup_id", postgresql.UUID(as_uuid=True), sa.ForeignKey("desktop_setups.id", ondelete="CASCADE"), nullable=False),
        sa.Column("device_seq", sa.Integer(), nullable=False),
        sa.Column("kind", sa.Text(), nullable=False),
        sa.Column("session_key", sa.Text(), nullable=True),
        sa.Column("payload", postgresql.JSONB(), nullable=False),
        sa.Column("idempotency_key", sa.Text(), nullable=False),
        sa.Column("requested_by", postgresql.UUID(as_uuid=True), nullable=False),
        sa.Column("state", sa.Text(), nullable=False, server_default="queued"),
        sa.Column("result_code", sa.Text(), nullable=True),
        sa.Column("created_at", sa.DateTime(timezone=True), server_default=sa.func.now(), nullable=False),
        sa.Column("delivered_at", sa.DateTime(timezone=True), nullable=True),
        sa.Column("acked_at", sa.DateTime(timezone=True), nullable=True),
        sa.Column("finished_at", sa.DateTime(timezone=True), nullable=True),
        sa.UniqueConstraint("setup_id", "idempotency_key", name="uq_desktop_commands_setup_idem"),
        sa.UniqueConstraint("setup_id", "device_seq", name="uq_desktop_commands_setup_seq"),
        sa.CheckConstraint(_in("kind", _KINDS), name="ck_desktop_commands_kind"),
        sa.CheckConstraint(_in("state", _CMD_STATES), name="ck_desktop_commands_state"),
    )
    op.create_index("ix_desktop_commands_setup_state_seq", "desktop_commands", ["setup_id", "state", "device_seq"])


def downgrade() -> None:
    op.drop_index("ix_desktop_commands_setup_state_seq", table_name="desktop_commands")
    op.drop_table("desktop_commands")
    op.drop_table("desktop_sessions")
    op.drop_index("ix_desktop_device_tokens_setup_id", table_name="desktop_device_tokens")
    op.drop_table("desktop_device_tokens")
    op.drop_column("desktop_setups", "relay_command_seq")
