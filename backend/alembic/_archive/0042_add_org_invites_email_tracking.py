"""add email tracking columns to org_invites (E-ORG-MULTI S3.2)

Revision ID: 0042
Revises: 0041
Create Date: 2026-05-20
"""
import sqlalchemy as sa
from alembic import op

revision = "0042"
down_revision = "0041"
branch_labels = None
depends_on = None


def upgrade() -> None:
    op.add_column("org_invites", sa.Column("email_sent_at", sa.DateTime(timezone=True), nullable=True))
    op.add_column("org_invites", sa.Column("email_error", sa.Text, nullable=True))


def downgrade() -> None:
    op.drop_column("org_invites", "email_error")
    op.drop_column("org_invites", "email_sent_at")
