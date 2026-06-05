"""add polar_webhook_events table for idempotency (E-ORG-MULTI S5.4)

Revision ID: 0043
Revises: 0042
Create Date: 2026-05-20
"""
import sqlalchemy as sa
from alembic import op

revision = "0043"
down_revision = "0042"
branch_labels = None
depends_on = None


def upgrade() -> None:
    op.create_table(
        "polar_webhook_events",
        sa.Column("event_id", sa.Text, primary_key=True),
        sa.Column("event_type", sa.Text, nullable=False),
        sa.Column("processed_at", sa.DateTime(timezone=True), server_default=sa.func.now(), nullable=False),
    )


def downgrade() -> None:
    op.drop_table("polar_webhook_events")
