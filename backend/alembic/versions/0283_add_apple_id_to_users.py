"""story #3118(Sign in with Apple, App Store Guideline 4.8) — add users.apple_id.

google_id/github_id(0005)와 동형 패턴 — oauth_callback()의 getattr(User, f"{provider}_id")
조회가 이 컬럼명 규칙에 의존한다.

Revision ID: 0283
Revises: 0282
Create Date: 2026-08-26

"""
from __future__ import annotations

from alembic import op
import sqlalchemy as sa

revision = "0283"
down_revision = "0282"
branch_labels = None
depends_on = None


def upgrade() -> None:
    op.add_column("users", sa.Column("apple_id", sa.Text(), nullable=True))
    op.create_unique_constraint("uq_users_apple_id", "users", ["apple_id"])
    op.create_index("ix_users_apple_id", "users", ["apple_id"])


def downgrade() -> None:
    op.drop_index("ix_users_apple_id", table_name="users")
    op.drop_constraint("uq_users_apple_id", "users", type_="unique")
    op.drop_column("users", "apple_id")
