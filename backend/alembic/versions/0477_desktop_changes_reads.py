"""[SID:4951] ①a — «바뀐 파일» 목록: a person's read of the changed-file LIST of a session folder on their own computer.

- desktop_commands.kind takes one more word: `read_changes` (payload exactly {session_key}: no folder, no path, no signature — PO 11-14: the viewer is the computer's pairing person alone).
  The CHECK is dropped and made again with the seven kinds (the code side is app/models/desktop_relay.COMMAND_KINDS — a test holds them together). No row changes.
- desktop_changes_reads: one short-lived row per read — who asked (viewer_id), which computer (setup_id), when it ends (expires_at = asked + 120 s), and the list the computer
  sent back (`payload`, NULL until it comes). The list is names, a status word and line counts only — no file content, no diff (v1 · Kadir lens A: code is never kept).
  The row is deleted the moment the viewer reads the list (consume once), at expiry (swept), with the command, with the computer's disconnect / the account's closure /
  remote control turned off (the lens's I). The row cascades with its command and with its computer.

- desktop_changes_audit: one line per list a person actually read — who (viewer_id), which computer (setup_id), which command, how many files, when. No name, no content (Kadir lens G). No foreign key to the
  computer or the command (the line outlives a disconnect); it goes with its organization. (`permission_audit_logs` only takes member_added / member_removed / role_changed, so this has its own table.)

Additive only: no backfill. Downgrade deletes the `read_changes` commands (a server from before has no such word) and drops the table.

Revision ID: 0477
Revises: 0476
Create Date: 2026-11-15
"""
import sqlalchemy as sa
from sqlalchemy.dialects import postgresql

from alembic import op

revision = "0477"
down_revision = "0476"
branch_labels = None
depends_on = None

_OLD = ("start_session", "send_prompt", "answer_approval", "stop_session", "end_session", "clock")
_NEW = _OLD + ("read_changes",)


def _in(column: str, values: tuple[str, ...]) -> str:
    return f"{column} IN ({', '.join(repr(v) for v in values)})"


def upgrade() -> None:
    op.drop_constraint("ck_desktop_commands_kind", "desktop_commands", type_="check")
    op.create_check_constraint("ck_desktop_commands_kind", "desktop_commands", _in("kind", _NEW))
    op.create_table(
        "desktop_changes_reads",
        sa.Column("command_id", postgresql.UUID(as_uuid=True), sa.ForeignKey("desktop_commands.id", ondelete="CASCADE"), primary_key=True),
        sa.Column("setup_id", postgresql.UUID(as_uuid=True), sa.ForeignKey("desktop_setups.id", ondelete="CASCADE"), nullable=False),
        sa.Column("viewer_id", postgresql.UUID(as_uuid=True), nullable=False),
        sa.Column("agent_member_id", postgresql.UUID(as_uuid=True), nullable=False),
        sa.Column("created_at", sa.DateTime(timezone=True), server_default=sa.func.now(), nullable=False),
        sa.Column("expires_at", sa.DateTime(timezone=True), nullable=False),
        sa.Column("payload", postgresql.JSONB(), nullable=True),
        sa.Column("written_at", sa.DateTime(timezone=True), nullable=True),
        sa.CheckConstraint("(payload IS NULL) = (written_at IS NULL)", name="ck_desktop_changes_reads_written"),
    )
    op.create_table(
        "desktop_changes_audit",
        sa.Column("id", postgresql.UUID(as_uuid=True), primary_key=True),
        sa.Column("org_id", postgresql.UUID(as_uuid=True), sa.ForeignKey("organizations.id", ondelete="CASCADE"), nullable=False),
        sa.Column("viewer_id", postgresql.UUID(as_uuid=True), nullable=False),
        sa.Column("setup_id", postgresql.UUID(as_uuid=True), nullable=False),
        sa.Column("command_id", postgresql.UUID(as_uuid=True), nullable=False),
        sa.Column("file_count", sa.Integer(), nullable=False),
        sa.Column("created_at", sa.DateTime(timezone=True), server_default=sa.func.now(), nullable=False),
    )
    op.create_index("ix_desktop_changes_audit_org_created", "desktop_changes_audit", ["org_id", "created_at"])
    # the sweep reads rows by expiry; the per-computer limit reads a computer's open rows; the person's pause reads their last ask among the read commands (a partial index)
    op.create_index("ix_desktop_changes_reads_expires_at", "desktop_changes_reads", ["expires_at"])
    op.create_index("ix_desktop_changes_reads_setup_created", "desktop_changes_reads", ["setup_id", "created_at"])
    op.create_index(
        "ix_desktop_commands_read_changes_by", "desktop_commands", ["requested_by", "created_at"], postgresql_where=sa.text("kind = 'read_changes'"),
    )


def downgrade() -> None:
    # a read command cannot stay under the old CHECK, and a server from before has no command it could stand for: the rows go (an open one was never delivered by
    # that server anyway); the table goes with the feature
    op.drop_index("ix_desktop_commands_read_changes_by", table_name="desktop_commands")
    op.drop_table("desktop_changes_audit")
    op.drop_table("desktop_changes_reads")
    op.execute("DELETE FROM desktop_commands WHERE kind = 'read_changes'")
    op.drop_constraint("ck_desktop_commands_kind", "desktop_commands", type_="check")
    op.create_check_constraint("ck_desktop_commands_kind", "desktop_commands", _in("kind", _OLD))
