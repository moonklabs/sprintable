"""story bea25062(E-AUTH-REBUILD auth_valid_after 코어 인프라): auth_migrations.auth_valid_after
컬럼(doc firebase-poc-q12-didi-measurements §17d-1 cutover epoch authority).

Revision ID: 0190
Revises: 0189
Create Date: 2026-07-15

additive — 기본 NULL(제약 없음)이라 기존 스키마/동작 무회귀.
"""
from __future__ import annotations

from alembic import op
import sqlalchemy as sa

revision = "0190"
down_revision = "0189"
branch_labels = None
depends_on = None


def upgrade() -> None:
    op.add_column(
        "auth_migrations",
        sa.Column("auth_valid_after", sa.DateTime(timezone=True), nullable=True),
    )


def downgrade() -> None:
    op.drop_column("auth_migrations", "auth_valid_after")
