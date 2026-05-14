"""drop notifications_type_check constraint

Revision ID: 0029
Revises: 0028
Create Date: 2026-05-14
"""
from alembic import op

revision = "0029"
down_revision = "0028"
branch_labels = None
depends_on = None


def upgrade() -> None:
    op.execute("ALTER TABLE notifications DROP CONSTRAINT IF EXISTS notifications_type_check")


def downgrade() -> None:
    pass
