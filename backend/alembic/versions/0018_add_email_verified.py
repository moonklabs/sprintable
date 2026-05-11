"""add email_verified to users

Revision ID: 0018
Revises: 0017
Create Date: 2026-05-11
"""
from __future__ import annotations

import sqlalchemy as sa
from alembic import op

revision = "0018"
down_revision = "0017"
branch_labels = None
depends_on = None


def upgrade() -> None:
    # 기존 사용자는 이미 인증된 것으로 처리 (서비스 연속성)
    op.add_column("users", sa.Column("email_verified", sa.Boolean(), nullable=False, server_default="true"))
    op.alter_column("users", "email_verified", server_default=None)


def downgrade() -> None:
    op.drop_column("users", "email_verified")
