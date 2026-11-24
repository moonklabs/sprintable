"""[SID:4983] P5 — a phone's request to LIST a folder of a project on the person's own computer, and the computer's SEALED answer.

- desktop_commands.kind takes one more word: `file_list` (payload exactly {project_id, envelope}: a project id, never a path, and a sealed request the server cannot open). The CHECK is dropped and made again
  with the eight kinds (the code side is app/models/desktop_relay.COMMAND_KINDS — a test holds them together). No row changes.
- desktop_file_reads: one short-lived row per request — who asked (viewer_id), which computer (setup_id), which project, the press's own key (the answer's header must name it), when it ends (expires_at = asked + 10
  minutes), and the answer the computer sent back (`payload` = {"envelope": …} sealed; NULL until it comes). The row is deleted the moment the viewer reads the answer (consume once), at expiry (swept), with the command, with the
  computer's disconnect / the account's closure / remote control turned off. It cascades with its command and with its computer. The server never holds a name, a path or a word of what a folder holds.

Additive only: no backfill. Downgrade deletes the `file_list` commands (a server from before has no such word) and drops the table.

Revision ID: 0488
Revises: 0487
Create Date: 2026-11-20
"""
import sqlalchemy as sa
from sqlalchemy.dialects import postgresql

from alembic import op

revision = "0488"
down_revision = "0487"
branch_labels = None
depends_on = None

_OLD = ("start_session", "send_prompt", "answer_approval", "stop_session", "end_session", "clock", "read_changes")
_NEW = _OLD + ("file_list",)


def _in(column: str, values: tuple[str, ...]) -> str:
    return f"{column} IN ({', '.join(repr(v) for v in values)})"


def upgrade() -> None:
    op.drop_constraint("ck_desktop_commands_kind", "desktop_commands", type_="check")
    op.create_check_constraint("ck_desktop_commands_kind", "desktop_commands", _in("kind", _NEW))
    op.create_table(
        "desktop_file_reads",
        sa.Column("command_id", postgresql.UUID(as_uuid=True), sa.ForeignKey("desktop_commands.id", ondelete="CASCADE"), primary_key=True),
        sa.Column("setup_id", postgresql.UUID(as_uuid=True), sa.ForeignKey("desktop_setups.id", ondelete="CASCADE"), nullable=False),
        sa.Column("viewer_id", postgresql.UUID(as_uuid=True), nullable=False),
        sa.Column("project_id", postgresql.UUID(as_uuid=True), nullable=False),
        sa.Column("press_key", sa.String(100), nullable=False),
        sa.Column("created_at", sa.DateTime(timezone=True), server_default=sa.func.now(), nullable=False),
        sa.Column("expires_at", sa.DateTime(timezone=True), nullable=False),
        sa.Column("payload", postgresql.JSONB(), nullable=True),
        sa.Column("written_at", sa.DateTime(timezone=True), nullable=True),
        sa.Column("polled_at", sa.DateTime(timezone=True), nullable=True),
        sa.CheckConstraint("(payload IS NULL) = (written_at IS NULL)", name="ck_desktop_file_reads_written"),
    )
    op.create_index("ix_desktop_file_reads_expires_at", "desktop_file_reads", ["expires_at"])
    op.create_index("ix_desktop_file_reads_setup_created", "desktop_file_reads", ["setup_id", "created_at"])
    # the person's pause reads their last ask among the file commands (a partial index, as the changed-files read's)
    op.create_index("ix_desktop_commands_file_list_by", "desktop_commands", ["requested_by", "created_at"], postgresql_where=sa.text("kind = 'file_list'"))


def downgrade() -> None:
    op.drop_index("ix_desktop_commands_file_list_by", table_name="desktop_commands")
    op.drop_table("desktop_file_reads")
    op.execute("DELETE FROM desktop_commands WHERE kind = 'file_list'")
    op.drop_constraint("ck_desktop_commands_kind", "desktop_commands", type_="check")
    op.create_check_constraint("ck_desktop_commands_kind", "desktop_commands", _in("kind", _OLD))
