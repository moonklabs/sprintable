"""[SID:4685] (limit notice · PO 10-14 00:39Z · Yuna limit-notice-1014.md §③) — a session's limit row says whether the daemon
looks at the limit again by itself.

- desktop_sessions gets one nullable column: `limit_looks` (BOOLEAN) — true only while the row stands at a usage limit whose
  reset time is unknown AND the reporting daemon is one that tries again every so often (relay contract: `limit.looks`, additive).
  The phone and the web promise «the app checks again» only when it is true — a daemon from before never does, and a line saying
  so would be the 10-13 failure again (7 hours standing).
- Additive only: no backfill (existing rows read as not looking — the old words stay), no existing row changes, no index.
"""
import sqlalchemy as sa

from alembic import op

revision = "0452"
down_revision = "0451"
branch_labels = None
depends_on = None


def upgrade() -> None:
    op.add_column("desktop_sessions", sa.Column("limit_looks", sa.Boolean(), nullable=True))


def downgrade() -> None:
    op.drop_column("desktop_sessions", "limit_looks")
