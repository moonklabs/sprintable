"""E-CAGE-REFEREE P1: stories에 is_excluded 플래그 추가 (데이터 오염 마킹용).

Revision ID: 0065
Revises: 0064
Create Date: 2026-05-31

삭제 아닌 마킹 — 원본 보존, 신뢰점수 집계 시 제외.
server_default=false → 기존 모든 행은 비제외 상태로 시작.
"""
from __future__ import annotations

import sqlalchemy as sa
from alembic import op

revision = "0065"
down_revision = "0064"
branch_labels = None
depends_on = None


def upgrade() -> None:
    conn = op.get_bind()
    insp = sa.inspect(conn)
    existing = {c["name"] for c in insp.get_columns("stories")}
    if "is_excluded" not in existing:
        op.add_column(
            "stories",
            sa.Column("is_excluded", sa.Boolean(), nullable=False, server_default="false"),
        )
        op.create_index("ix_stories_is_excluded", "stories", ["is_excluded"])


def downgrade() -> None:
    conn = op.get_bind()
    insp = sa.inspect(conn)
    existing = {c["name"] for c in insp.get_columns("stories")}
    if "is_excluded" not in existing:
        return
    op.drop_index("ix_stories_is_excluded", table_name="stories")
    op.drop_column("stories", "is_excluded")
