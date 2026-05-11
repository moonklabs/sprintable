"""add login_fail_count and login_locked_until to users

Revision ID: 0019
Revises: 0018
Create Date: 2026-05-11
"""
from __future__ import annotations

import sqlalchemy as sa
from alembic import op

revision = "0019"
down_revision = "0018"
branch_labels = None
depends_on = None


def upgrade() -> None:
    op.add_column("users", sa.Column("login_fail_count", sa.Integer(), nullable=False, server_default="0"))
    op.add_column("users", sa.Column("login_locked_until", sa.DateTime(timezone=True), nullable=True))


def downgrade() -> None:
    op.drop_column("users", "login_locked_until")
    op.drop_column("users", "login_fail_count")
