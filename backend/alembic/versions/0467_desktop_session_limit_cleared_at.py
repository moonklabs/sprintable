"""[SID:b1e4a414] (4781 AC2 · PO 10-25) — «working again» is told only after the limit stayed gone: one nullable timestamp on the session row.

10-25: Claude Code resubmitted the stuck prompt by itself every ~30 minutes; the daemon reported «working» for a second, the server read it as «the limit is over» and
sent `agent.limit_lifted`, and the same limit error a second later sent `agent.limit_paused` again — ten false «다시 움직여요» in a day, none of which was true.

- limit_cleared_at  TIMESTAMPTZ — set by the report that took the limit away from a LIVE session; the «working again» line waits until it has been gone for the hold
                                   (`desktop_limit_notice.LIFT_HOLD_SEC`), a report that puts the limit back first cancels both the line and the new «stopped» notice.
                                   NULL = no lift is waiting.

Additive only: no backfill (a lift that was waiting when this ran is simply not told — as before a restart), no index (the sweep reads the few rows that carry it).
"""
import sqlalchemy as sa

from alembic import op

revision = "0467"
down_revision = "0466"
branch_labels = None
depends_on = None


def upgrade() -> None:
    op.add_column("desktop_sessions", sa.Column("limit_cleared_at", sa.DateTime(timezone=True), nullable=True))


def downgrade() -> None:
    op.drop_column("desktop_sessions", "limit_cleared_at")
