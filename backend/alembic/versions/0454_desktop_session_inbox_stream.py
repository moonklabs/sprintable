"""[SID:4684] (PO 10-14 · Yuna ux1-copy §L ②③) — the phone and the web strip say it too when this computer stopped receiving an agent's work.

The app board already says «another place is receiving / took over …» (4509 · 4676) from the daemon's inbox stream state, but the relay
session row had no such column, so a person looking from the phone or the web could not tell why a computer's agent got no new work.
desktop_sessions gets one nullable column, set by the report that carries `inbox` (a report without it clears it — the computer receives
again, like `run` / `instruct_now`):

- inbox_stream  TEXT — why this computer's subscription for the agent is stopped: the app board's own closed words
                       (stopped_other_receiver · stopped_taken_over · stopped_auth · stopped_inbox_full). NULL = receiving (or not said).

Additive only: no backfill, no index. The closed set is held in the DB too (the API check alone is not the last word).
"""
import sqlalchemy as sa

from alembic import op

revision = "0454"
down_revision = "0453"
branch_labels = None
depends_on = None


def upgrade() -> None:
    op.add_column("desktop_sessions", sa.Column("inbox_stream", sa.Text(), nullable=True))
    op.create_check_constraint(
        "ck_desktop_sessions_inbox_stream", "desktop_sessions",
        "inbox_stream IS NULL OR inbox_stream IN ('stopped_other_receiver','stopped_taken_over','stopped_auth','stopped_inbox_full')",
    )


def downgrade() -> None:
    op.drop_constraint("ck_desktop_sessions_inbox_stream", "desktop_sessions", type_="check")
    op.drop_column("desktop_sessions", "inbox_stream")
