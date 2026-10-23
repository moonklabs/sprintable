"""[SID:4753] polar_webhook_events.outcome / org_id: a webhook the server refused to apply is kept where a person can find it

`outcome` NULL = the event was handled the usual way. `refused_org_closed` = the provider reported a subscription for an organization that no longer exists; no subscription row was written (the
organization row is the lock every subscription write takes, and «closed» is «the row is gone» — see services/org_billing_lock.py). `org_id` is that organization. The provider cannot be told to cancel
or refund from here (PolarAdapter.cancel / .refund are not implemented), so this row is the list a person works through.

Additive only, nullable, no backfill, no index (a handful of rows a year at most).
"""
import sqlalchemy as sa

from alembic import op

revision = "0461"
down_revision = "0460"
branch_labels = None
depends_on = None


def upgrade() -> None:
    op.add_column("polar_webhook_events", sa.Column("outcome", sa.Text, nullable=True))
    op.add_column("polar_webhook_events", sa.Column("org_id", sa.dialects.postgresql.UUID(as_uuid=True), nullable=True))


def downgrade() -> None:
    op.drop_column("polar_webhook_events", "org_id")
    op.drop_column("polar_webhook_events", "outcome")
