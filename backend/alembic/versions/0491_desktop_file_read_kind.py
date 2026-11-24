"""[SID:4983] P6 — a phone's request to OPEN one file of a project on the person's own computer: `file_read`.

- desktop_commands.kind takes one more word: `file_read` (payload exactly {project_id, envelope}, the same as `file_list`: a project id, never a path or a name — the folder and the file's name are inside the sealed request the
  server cannot open). The CHECK is dropped and made again with the nine kinds (the code side is app/models/desktop_relay.COMMAND_KINDS — a test holds them together). No row changes.
- the person's one-ask-a-second pause reads their last ask among the FILE commands (both kinds): the partial index of 0488 (`WHERE kind = 'file_list'`) is dropped and made again over both words.
- desktop_file_reads is unchanged: a row holds the sealed answer of either kind (the command's kind says which).

Additive only: no backfill. Downgrade deletes the `file_read` commands (a server from before has no such word; their answer rows go with them by the foreign key) and puts the one-kind index back.

Revision ID: 0491
Revises: 0490
Create Date: 2026-11-20
"""
import sqlalchemy as sa

from alembic import op

revision = "0491"
down_revision = "0490"
branch_labels = None
depends_on = None

_OLD = ("start_session", "send_prompt", "answer_approval", "stop_session", "end_session", "clock", "read_changes", "file_list")
_NEW = _OLD + ("file_read",)


def _in(column: str, values: tuple[str, ...]) -> str:
    return f"{column} IN ({', '.join(repr(v) for v in values)})"


def upgrade() -> None:
    op.drop_constraint("ck_desktop_commands_kind", "desktop_commands", type_="check")
    op.create_check_constraint("ck_desktop_commands_kind", "desktop_commands", _in("kind", _NEW))
    op.drop_index("ix_desktop_commands_file_list_by", table_name="desktop_commands")
    op.create_index("ix_desktop_commands_file_by", "desktop_commands", ["requested_by", "created_at"], postgresql_where=sa.text("kind IN ('file_list', 'file_read')"))


def downgrade() -> None:
    op.drop_index("ix_desktop_commands_file_by", table_name="desktop_commands")
    op.execute("DELETE FROM desktop_commands WHERE kind = 'file_read'")
    op.drop_constraint("ck_desktop_commands_kind", "desktop_commands", type_="check")
    op.create_check_constraint("ck_desktop_commands_kind", "desktop_commands", _in("kind", _OLD))
    op.create_index("ix_desktop_commands_file_list_by", "desktop_commands", ["requested_by", "created_at"], postgresql_where=sa.text("kind = 'file_list'"))
