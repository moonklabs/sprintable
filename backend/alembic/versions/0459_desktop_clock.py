"""[SID:4733] S2 — a phone's signed clock-out / clock-in of a whole computer: the `clock` command word and the computer's clock view.

- desktop_commands.kind takes one more word: `clock` (payload exactly {action, signed}; the action is the payload's, so the next action needs no migration).
  The CHECK is dropped and made again with the six kinds (the code side is app/models/desktop_relay.COMMAND_KINDS — a test holds them together). No row
  changes: every stored value is still one of the five.
- desktop_clock_views: the computer's latest closed clock view, one row per computer, only while a flow is open or some agents stand clocked out one by one
  (an empty `none` report deletes it · `expires_at` ends it otherwise). Holds the clock-out draft's first lines while drafting — so it is its own table: nothing that loads a desktop_setups row loads it.
- desktop_setups.clock_view_seq BIGINT NULL — the highest report number applied (kept when the view row is deleted: a late lower number cannot bring it back);
  clock_seen_at TIMESTAMPTZ NULL — when the computer last spoke of the clock (NULL = never = an older app).

Additive only: no backfill.
"""
import sqlalchemy as sa
from sqlalchemy.dialects import postgresql

from alembic import op

revision = "0459"
down_revision = "0458"
branch_labels = None
depends_on = None

_OLD = ("start_session", "send_prompt", "answer_approval", "stop_session", "end_session")
_NEW = _OLD + ("clock",)


def _in(column: str, values: tuple[str, ...]) -> str:
    return f"{column} IN ({', '.join(repr(v) for v in values)})"


def upgrade() -> None:
    op.drop_constraint("ck_desktop_commands_kind", "desktop_commands", type_="check")
    op.create_check_constraint("ck_desktop_commands_kind", "desktop_commands", _in("kind", _NEW))
    op.add_column("desktop_setups", sa.Column("clock_view_seq", sa.BigInteger(), nullable=True))
    op.add_column("desktop_setups", sa.Column("clock_seen_at", sa.DateTime(timezone=True), nullable=True))
    op.create_table(
        "desktop_clock_views",
        sa.Column("setup_id", postgresql.UUID(as_uuid=True), sa.ForeignKey("desktop_setups.id", ondelete="CASCADE"), primary_key=True),
        sa.Column("mode", sa.Text(), nullable=False),
        sa.Column("view", postgresql.JSONB(), nullable=False),
        sa.Column("reported_at", sa.DateTime(timezone=True), server_default=sa.func.now(), nullable=False),
        sa.Column("expires_at", sa.DateTime(timezone=True), nullable=False),
        sa.CheckConstraint(_in("mode", ("none", "panel", "out", "in")), name="ck_desktop_clock_views_mode"),
    )


def downgrade() -> None:
    # a clock command cannot stay under the old CHECK, and a server from before has no command it could stand for: the rows go (an open one was never
    # delivered by that server anyway); the view table and the two columns go with the feature
    op.execute("DELETE FROM desktop_commands WHERE kind = 'clock'")
    op.drop_table("desktop_clock_views")
    op.drop_column("desktop_setups", "clock_seen_at")
    op.drop_column("desktop_setups", "clock_view_seq")
    op.drop_constraint("ck_desktop_commands_kind", "desktop_commands", type_="check")
    op.create_check_constraint("ck_desktop_commands_kind", "desktop_commands", _in("kind", _OLD))
