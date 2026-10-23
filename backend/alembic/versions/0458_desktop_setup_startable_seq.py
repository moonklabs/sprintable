"""[SID:4714] (PO 10-18) — the order of a computer's startable reports.

`PUT /relay/startable` replaces the computer's whole list. A request the computer gave up (it reconnected) can still reach the server late and
cover a newer one, and nothing on the server said which was newer. The computer now numbers each report with a value that only grows (even
across a restart); desktop_setups keeps the highest number applied and ignores a lower one.

- startable_seq  BIGINT NULL — NULL = no numbered report yet (an older app never numbers: its reports are applied as before).

Additive only: no backfill, no index.
"""
import sqlalchemy as sa

from alembic import op

revision = "0458"
down_revision = "0457"
branch_labels = None
depends_on = None


def upgrade() -> None:
    op.add_column("desktop_setups", sa.Column("startable_seq", sa.BigInteger(), nullable=True))


def downgrade() -> None:
    op.drop_column("desktop_setups", "startable_seq")
