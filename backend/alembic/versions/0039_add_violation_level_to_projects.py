"""add violation_level to projects (S3-2)

Revision ID: 0039
Revises: 0038
Create Date: 2026-05-19
"""
import sqlalchemy as sa
from alembic import op

revision = "0039"
down_revision = "0038"
branch_labels = None
depends_on = None


def upgrade() -> None:
    op.add_column(
        "projects",
        sa.Column("violation_level", sa.String(10), nullable=False, server_default="warn"),
    )


def downgrade() -> None:
    op.drop_column("projects", "violation_level")
