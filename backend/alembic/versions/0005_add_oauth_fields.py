"""add oauth fields to users

Revision ID: 0005
Revises: 0004
Create Date: 2026-05-02

"""
from __future__ import annotations

from alembic import op
import sqlalchemy as sa

revision = "0005"
down_revision = "0004"
branch_labels = None
depends_on = None


def upgrade() -> None:
    op.add_column("users", sa.Column("google_id", sa.Text(), nullable=True))
    op.add_column("users", sa.Column("github_id", sa.Text(), nullable=True))
    op.create_unique_constraint("uq_users_google_id", "users", ["google_id"])
    op.create_unique_constraint("uq_users_github_id", "users", ["github_id"])
    op.create_index("ix_users_google_id", "users", ["google_id"])
    op.create_index("ix_users_github_id", "users", ["github_id"])


def downgrade() -> None:
    op.drop_index("ix_users_github_id", table_name="users")
    op.drop_index("ix_users_google_id", table_name="users")
    op.drop_constraint("uq_users_github_id", "users", type_="unique")
    op.drop_constraint("uq_users_google_id", "users", type_="unique")
    op.drop_column("users", "github_id")
    op.drop_column("users", "google_id")
