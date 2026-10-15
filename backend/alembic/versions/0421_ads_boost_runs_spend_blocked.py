"""story #4417 (Qadir 01a0eb3b · PO 03:49Z) — a boost whose spend can't be checked against its budget is stopped, and says why.

- `spend_blocked_at` · `spend_blocked_code`: the moment the spend became unreadable for the cap (a spend in another currency
  than the sealed one, a currency outside the table, or repeated read failures) and the code. Set once; the run is paused by
  the scheduler at the same time and cannot be resumed while it is set (resuming would spend with no cap).
- `spend_blocked_notified_at`: when the people on the boost were told (Qadir 01a0eb71 B) — a failed notice is sent again on
  the next tick, a sent one never twice.
- `account_currency`: the ad account's currency as read before the start command touched the provider (the create/activate
  check); shown on the «needs your check» card when it differs from the sealed currency.

All four nullable: null = not blocked / not read yet. No backfill (existing runs were never blocked).

Revision ID: 0421
Revises: 0420
"""
import sqlalchemy as sa

from alembic import op

revision = "0421"
down_revision = "0420"
branch_labels = None
depends_on = None


def upgrade() -> None:
    op.add_column("ads_boost_runs", sa.Column("spend_blocked_at", sa.DateTime(timezone=True), nullable=True))
    op.add_column("ads_boost_runs", sa.Column("spend_blocked_code", sa.Text(), nullable=True))
    op.add_column("ads_boost_runs", sa.Column("spend_blocked_notified_at", sa.DateTime(timezone=True), nullable=True))
    op.add_column("ads_boost_runs", sa.Column("account_currency", sa.Text(), nullable=True))


def downgrade() -> None:
    op.drop_column("ads_boost_runs", "account_currency")
    op.drop_column("ads_boost_runs", "spend_blocked_notified_at")
    op.drop_column("ads_boost_runs", "spend_blocked_code")
    op.drop_column("ads_boost_runs", "spend_blocked_at")
