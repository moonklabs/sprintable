"""story #4534 (E-DESKTOP-2 · relay contract v1.12 · PO 2026-10-05 03:06Z · Yuna) — the board's own words reach the phone and the web.

- desktop_sessions.state takes three more words: `waiting_input` (asked in the terminal) · `error` · `paused_limit` (paused at a
  usage limit — the daemon continues it by itself at `limit_at`). Before, the daemon folded them into `idle`, so an agent that
  stopped with an error looked idle on the phone.
- the why of a usage limit, on a limit word only (the service refuses it on any other): `limited` (the row carries a limit —
  an error from a limit whose time is not known has nothing else) · `limit_at` (when it resets / continues) ·
  `limit_again` (it hit the limit again after continuing) · `limit_self_resume` (Claude: whether it may continue by itself — its
  login). All nullable: a row without a limit has none.
The CHECK is dropped and made again with the eight words (the code side is app/models/desktop_relay.SESSION_STATES — a test holds
them together). No row changes: every stored value is one of the five, all still allowed.
"""
import sqlalchemy as sa

from alembic import op

revision = "0437"
down_revision = "0436"
branch_labels = None
depends_on = None

_OLD = ("starting", "working", "idle", "waiting_permission", "stopped")
_NEW = ("starting", "working", "idle", "waiting_permission", "waiting_input", "error", "paused_limit", "stopped")
_SELF_RESUME = ("maybe", "no", "unknown")


def _in(column: str, values: tuple[str, ...]) -> str:
    return f"{column} IN ({', '.join(repr(v) for v in values)})"


def upgrade() -> None:
    op.drop_constraint("ck_desktop_sessions_state", "desktop_sessions", type_="check")
    op.create_check_constraint("ck_desktop_sessions_state", "desktop_sessions", _in("state", _NEW))
    op.add_column("desktop_sessions", sa.Column("limited", sa.Boolean(), nullable=True))
    op.add_column("desktop_sessions", sa.Column("limit_at", sa.DateTime(timezone=True), nullable=True))
    op.add_column("desktop_sessions", sa.Column("limit_again", sa.Boolean(), nullable=True))
    op.add_column("desktop_sessions", sa.Column("limit_self_resume", sa.Text(), nullable=True))
    op.create_check_constraint(
        "ck_desktop_sessions_limit_self_resume", "desktop_sessions",
        f"limit_self_resume IS NULL OR {_in('limit_self_resume', _SELF_RESUME)}",
    )


def downgrade() -> None:
    # a row in a new word cannot stay under the old CHECK: it reads as idle again (what the daemon sent before)
    op.execute("UPDATE desktop_sessions SET state = 'idle' WHERE state IN ('waiting_input', 'error', 'paused_limit')")
    op.drop_constraint("ck_desktop_sessions_limit_self_resume", "desktop_sessions", type_="check")
    op.drop_column("desktop_sessions", "limit_self_resume")
    op.drop_column("desktop_sessions", "limit_again")
    op.drop_column("desktop_sessions", "limit_at")
    op.drop_column("desktop_sessions", "limited")
    op.drop_constraint("ck_desktop_sessions_state", "desktop_sessions", type_="check")
    op.create_check_constraint("ck_desktop_sessions_state", "desktop_sessions", _in("state", _OLD))
