"""[SID:5025] C1 — what a phone may do on a computer is SIGNED by the server: the command word `capability_set`, the per-computer serial, and the host's counts of what it refused.

- desktop_commands.kind takes one more word: `capability_set` (payload exactly {envelope}: the server's own signed set — the code side is app/models/desktop_relay.COMMAND_KINDS, a test holds them together). The CHECK is dropped and
  made again with ONE word more (the template is 0495).
- desktop_setups: `capability_serial` (the last serial handed out · `serial = max(previous + 1, unix_ms)`), `capability_hash` (a hash of the caps last pushed — no phone id, no member id in it · NULL = none pushed yet) and
  `capability_pushed_at`. All nullable / defaulted: a running old revision never names them.
- desktop_capability_rejections: what a host REPORTS of its own refusals — counts only (`code` · phone · agent · how many · when). No content, no text, no path: a closed list of three codes, ids that are the server's own, and a count.
  One row per (computer, code, phone, agent); the report adds to it. It hangs from the computer (ON DELETE CASCADE): a disconnected-and-deleted computer takes its counts.

Additive only: no backfill, no row rewritten. Downgrade deletes the `capability_set` rows, puts the old CHECK back and drops the columns and the table.

Revision ID: 0500
Revises: 0499
Create Date: 2026-11-26
"""
import sqlalchemy as sa
from sqlalchemy.dialects import postgresql

from alembic import op

revision = "0500"
down_revision = "0499"
branch_labels = None
depends_on = None

_OLD = ("start_session", "send_prompt", "answer_approval", "stop_session", "end_session", "clock", "read_changes", "file_list", "file_read", "file_download", "direct_open")
_NEW = _OLD + ("capability_set",)
_CODES = ("no_capability", "capability_expired", "not_in_seal_to")


def _in(column: str, values: tuple[str, ...]) -> str:
    return f"{column} IN ({', '.join(repr(v) for v in values)})"


def upgrade() -> None:
    op.drop_constraint("ck_desktop_commands_kind", "desktop_commands", type_="check")
    op.create_check_constraint("ck_desktop_commands_kind", "desktop_commands", _in("kind", _NEW))
    op.add_column("desktop_setups", sa.Column("capability_serial", sa.BigInteger(), nullable=False, server_default="0"))
    op.add_column("desktop_setups", sa.Column("capability_hash", sa.Text(), nullable=True))
    op.add_column("desktop_setups", sa.Column("capability_pushed_at", sa.DateTime(timezone=True), nullable=True))
    op.create_table(
        "desktop_capability_rejections",
        sa.Column("setup_id", postgresql.UUID(as_uuid=True), sa.ForeignKey("desktop_setups.id", ondelete="CASCADE"), nullable=False),
        sa.Column("code", sa.Text(), nullable=False),
        sa.Column("phone_key_id", postgresql.UUID(as_uuid=True), nullable=False),
        sa.Column("agent_member_id", postgresql.UUID(as_uuid=True), nullable=False),
        sa.Column("count", sa.BigInteger(), nullable=False),
        sa.Column("last_at", sa.DateTime(timezone=True), nullable=False),
        sa.PrimaryKeyConstraint("setup_id", "code", "phone_key_id", "agent_member_id", name="pk_desktop_capability_rejections"),
        sa.CheckConstraint(_in("code", _CODES), name="ck_desktop_capability_rejections_code"),
        sa.CheckConstraint("count >= 1", name="ck_desktop_capability_rejections_count"),
    )


def downgrade() -> None:
    op.drop_table("desktop_capability_rejections")
    op.drop_column("desktop_setups", "capability_pushed_at")
    op.drop_column("desktop_setups", "capability_hash")
    op.drop_column("desktop_setups", "capability_serial")
    op.execute("DELETE FROM desktop_commands WHERE kind = 'capability_set'")
    op.drop_constraint("ck_desktop_commands_kind", "desktop_commands", type_="check")
    op.create_check_constraint("ck_desktop_commands_kind", "desktop_commands", _in("kind", _OLD))
