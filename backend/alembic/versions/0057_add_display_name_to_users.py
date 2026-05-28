"""Add display_name column to users table.

Revision ID: 0057
Revises: 0056
Create Date: 2026-05-29
"""
from __future__ import annotations

import sqlalchemy as sa
from alembic import op

revision = "0057"
down_revision = "0056"
branch_labels = None
depends_on = None


def upgrade() -> None:
    op.add_column("users", sa.Column("display_name", sa.Text, nullable=True))
    op.execute(
        "UPDATE users SET display_name = split_part(email, '@', 1) WHERE display_name IS NULL"
    )


def downgrade() -> None:
    op.drop_column("users", "display_name")
