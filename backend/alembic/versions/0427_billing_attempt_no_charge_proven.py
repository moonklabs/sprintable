"""story #4488 — a payment attempt records when «nothing was charged» was proven.

`no_charge_proven_at` is filled only on a positive answer:
- the attempt ended without a charge ever being started (`_finish` with no `charge_started_at`), or
- the recheck window closed and its last Toss lookup gave a definite «no payment» (NOT_FOUND · ABORTED/EXPIRED/CANCELED).
The screen says «청구된 금액은 없어요» only when it is set. «No operator alert» is not proof: the window's last turn commits
`next_check_at = None` before it asks Toss, and a worker that dies in between leaves neither an answer nor an alert.

Backfill: rows that ended (failed · declined) without ever starting a charge are proven by the same rule as `_finish`. Rows
that did start one keep it null — no positive answer was recorded for them.

Revision ID: 0427
Revises: 0426
"""
import sqlalchemy as sa

from alembic import op

revision = "0427"
down_revision = "0426"
branch_labels = None
depends_on = None


def upgrade() -> None:
    op.add_column("billing_payment_attempts", sa.Column("no_charge_proven_at", sa.DateTime(timezone=True), nullable=True))
    op.execute(
        "UPDATE billing_payment_attempts SET no_charge_proven_at = finished_at "
        "WHERE status IN ('failed', 'declined') AND charge_started_at IS NULL AND finished_at IS NOT NULL"
    )


def downgrade() -> None:
    op.drop_column("billing_payment_attempts", "no_charge_proven_at")
