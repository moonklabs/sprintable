"""[SID:4993] P2 — a paired phone ASKS its own computer for a same-network direct door: the command word `direct_open` and the one short-lived table that holds the ask's request row and the computer's SEALED answer.

- desktop_commands.kind takes one more word: `direct_open` (payload exactly {envelope}: a sealed, phone-signed ask — no session, no address, no key in the clear). The CHECK is dropped and made again with ONE word more (the code side is
  app/models/desktop_relay.COMMAND_KINDS — a test holds them together). A new partial index serves the person's one-ask-a-second pause (it reads the person's last ask among the `direct_open` commands only; the table of those is tiny).
- desktop_direct_asks: the request's row — who asked (`viewer_id`), which computer (`setup_id`), the press's own key, the end of the wait (`expires_at` = asked + 60 s) and, once the computer has answered, the SEALED answer (`payload` =
  {"envelope": …}, an envelope the server cannot open: no address, no port, no ticket). It hangs from the command (`command_id`, ON DELETE CASCADE) and from the computer (`setup_id`, ON DELETE CASCADE): every way the command or the computer ends
  takes the row with it, so no answer outlives its request. Deleted the moment its person reads it, at `expires_at`, and when the computer disconnects / the account closes / remote control is turned off (app/services/desktop_direct.forget).

Additive only: no backfill, no row rewritten. Why a running old revision lives with it: it never names `direct_open`, the new table or the new index (it writes only the words it knew, and every one of them still passes the new CHECK — which is the old
one PLUS one word); a command row that an old revision reads is never of the new kind (the server that creates `direct_open` rows is this revision). Downgrade deletes the `direct_open` rows, puts the old CHECK back and drops the index and the table.

Revision ID: 0495
Revises: 0494
Create Date: 2026-11-22
"""
import sqlalchemy as sa
from sqlalchemy.dialects import postgresql

from alembic import op

revision = "0495"
down_revision = "0494"
branch_labels = None
depends_on = None

_OLD = ("start_session", "send_prompt", "answer_approval", "stop_session", "end_session", "clock", "read_changes", "file_list", "file_read", "file_download")
_NEW = _OLD + ("direct_open",)


def _in(column: str, values: tuple[str, ...]) -> str:
    return f"{column} IN ({', '.join(repr(v) for v in values)})"


def upgrade() -> None:
    op.drop_constraint("ck_desktop_commands_kind", "desktop_commands", type_="check")
    op.create_check_constraint("ck_desktop_commands_kind", "desktop_commands", _in("kind", _NEW))
    op.create_index("ix_desktop_commands_direct_by", "desktop_commands", ["requested_by", "created_at"], postgresql_where=sa.text("kind = 'direct_open'"))
    op.create_table(
        "desktop_direct_asks",
        sa.Column("command_id", postgresql.UUID(as_uuid=True), sa.ForeignKey("desktop_commands.id", ondelete="CASCADE"), primary_key=True),
        sa.Column("setup_id", postgresql.UUID(as_uuid=True), sa.ForeignKey("desktop_setups.id", ondelete="CASCADE"), nullable=False),
        sa.Column("viewer_id", postgresql.UUID(as_uuid=True), nullable=False),
        sa.Column("press_key", sa.String(100), nullable=False),
        sa.Column("created_at", sa.DateTime(timezone=True), server_default=sa.func.now(), nullable=False),
        sa.Column("expires_at", sa.DateTime(timezone=True), nullable=False),
        sa.Column("payload", postgresql.JSONB(), nullable=True),
        sa.Column("written_at", sa.DateTime(timezone=True), nullable=True),
        sa.Column("polled_at", sa.DateTime(timezone=True), nullable=True),
        sa.CheckConstraint("(payload IS NULL) = (written_at IS NULL)", name="ck_desktop_direct_asks_written"),
    )
    op.create_index("ix_desktop_direct_asks_expires_at", "desktop_direct_asks", ["expires_at"])
    op.create_index("ix_desktop_direct_asks_setup_created", "desktop_direct_asks", ["setup_id", "created_at"])


def downgrade() -> None:
    op.drop_table("desktop_direct_asks")
    op.drop_index("ix_desktop_commands_direct_by", table_name="desktop_commands")
    op.execute("DELETE FROM desktop_commands WHERE kind = 'direct_open'")
    op.drop_constraint("ck_desktop_commands_kind", "desktop_commands", type_="check")
    op.create_check_constraint("ck_desktop_commands_kind", "desktop_commands", _in("kind", _OLD))
