"""[SID:4988] P8 — a phone DOWNLOADS one file of a project of the person's own computer: the command word `file_download`, the unread SEALED chunks of its answer, and two counters of the one row that holds the request.

- desktop_commands.kind takes one more word: `file_download` (payload exactly {project_id, envelope}, as `file_list` and `file_read`: a project id and a sealed request — the file's name is inside it). The CHECK is dropped and made again with the ten kinds
  (the code side is app/models/desktop_relay.COMMAND_KINDS — a test holds them together). The person's one-ask-a-second pause reads their last ask among the FILE commands: its partial index (0491, over two words) is made again over all three.
- desktop_file_reads gets two counters (`chunks_written`, `chunks_read`; NOT NULL DEFAULT 0 — a constant default, no table rewrite) and one CHECK over them (read ≤ written ≤ 57): the chunks of a download are put and taken IN ORDER, and the server holds at most four unread ones.
- desktop_file_chunks: the sealed chunks of a download — one short-lived row per chunk (`payload` = {"envelope": …} the server cannot open: no name, no word, no byte of the file), put by the computer once, deleted the moment the person reads it. The row
  hangs from the request's own row (desktop_file_reads.command_id, ON DELETE CASCADE): every way that row ends — read to the end, cancelled, expired (10 minutes), the person's pairing gone, the computer disconnected, remote control turned off — takes its
  chunks with it, so no chunk outlives its request.

Additive only: no backfill. Why a running old revision lives with it: it never names `file_download`, the new columns (their defaults hold) or the new table; its CHECK reads are looser. Downgrade deletes the `file_download` commands (a server from before has no such word; their rows go with them
by the foreign keys), drops the table and the columns, and puts the two-kind index back.

Revision ID: 0492
Revises: 0491
Create Date: 2026-11-21
"""
import sqlalchemy as sa
from sqlalchemy.dialects import postgresql

from alembic import op

revision = "0492"
down_revision = "0491"
branch_labels = None
depends_on = None

_OLD = ("start_session", "send_prompt", "answer_approval", "stop_session", "end_session", "clock", "read_changes", "file_list", "file_read")
_NEW = _OLD + ("file_download",)
CHUNKS_MAX = 57  # contract `download.limits.chunks_max`: ceil(8 MiB / 144 KiB)


def _in(column: str, values: tuple[str, ...]) -> str:
    return f"{column} IN ({', '.join(repr(v) for v in values)})"


def upgrade() -> None:
    op.drop_constraint("ck_desktop_commands_kind", "desktop_commands", type_="check")
    op.create_check_constraint("ck_desktop_commands_kind", "desktop_commands", _in("kind", _NEW))
    op.drop_index("ix_desktop_commands_file_by", table_name="desktop_commands")
    op.create_index("ix_desktop_commands_file_by", "desktop_commands", ["requested_by", "created_at"], postgresql_where=sa.text("kind IN ('file_list', 'file_read', 'file_download')"))
    op.add_column("desktop_file_reads", sa.Column("chunks_written", sa.Integer(), nullable=False, server_default="0"))
    op.add_column("desktop_file_reads", sa.Column("chunks_read", sa.Integer(), nullable=False, server_default="0"))
    op.create_check_constraint("ck_desktop_file_reads_chunks", "desktop_file_reads", f"chunks_read >= 0 AND chunks_read <= chunks_written AND chunks_written <= {CHUNKS_MAX}")
    op.create_table(
        "desktop_file_chunks",
        sa.Column("command_id", postgresql.UUID(as_uuid=True), sa.ForeignKey("desktop_file_reads.command_id", ondelete="CASCADE"), primary_key=True),
        sa.Column("i", sa.Integer(), primary_key=True),
        sa.Column("payload", postgresql.JSONB(), nullable=False),
        sa.Column("written_at", sa.DateTime(timezone=True), server_default=sa.func.now(), nullable=False),
        sa.CheckConstraint(f"i >= 0 AND i < {CHUNKS_MAX}", name="ck_desktop_file_chunks_i"),
    )


def downgrade() -> None:
    op.drop_table("desktop_file_chunks")
    op.drop_constraint("ck_desktop_file_reads_chunks", "desktop_file_reads", type_="check")
    op.drop_column("desktop_file_reads", "chunks_read")
    op.drop_column("desktop_file_reads", "chunks_written")
    op.drop_index("ix_desktop_commands_file_by", table_name="desktop_commands")
    op.execute("DELETE FROM desktop_commands WHERE kind = 'file_download'")
    op.drop_constraint("ck_desktop_commands_kind", "desktop_commands", type_="check")
    op.create_check_constraint("ck_desktop_commands_kind", "desktop_commands", _in("kind", _OLD))
    op.create_index("ix_desktop_commands_file_by", "desktop_commands", ["requested_by", "created_at"], postgresql_where=sa.text("kind IN ('file_list', 'file_read')"))
