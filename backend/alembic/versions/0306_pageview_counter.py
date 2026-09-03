"""story #3354(마케팅자동화·측정, 페드루 PO 확定 2026-09-03) — 자체 조회수 카운터.
GA4 속성을 우리 계정이 못 읽어(담롱·PO 실측 2026-09-03) 발행 재개 즉시 «유입→활성화» 첫
열을 세려면 우리 서버가 직접 세는 수단이 필요하다.

두 테이블:
- org_metering_keys — 공개 글 페이지 beacon이 자신을 식별할 비밀 아닌 공개 키(랜딩 JS에
  박힘, revoked_at으로만 재발급).
- org_pageview_daily — (org_id, path, day) 일별 집계(standup.py의 (member, date) unique와
  동형 골격).

Revision ID: 0306
Revises: 0305
Create Date: 2026-09-03
"""
from __future__ import annotations

import sqlalchemy as sa
from alembic import op
from sqlalchemy.dialects import postgresql

revision = "0306"
down_revision = "0305"
branch_labels = None
depends_on = None


def upgrade() -> None:
    op.create_table(
        "org_metering_keys",
        sa.Column("id", postgresql.UUID(as_uuid=True), primary_key=True),
        sa.Column("org_id", postgresql.UUID(as_uuid=True), nullable=False),
        sa.Column("public_key", sa.Text(), nullable=False),
        sa.Column("created_at", sa.DateTime(timezone=True), server_default=sa.text("now()"), nullable=False),
        sa.Column("revoked_at", sa.DateTime(timezone=True), nullable=True),
        sa.UniqueConstraint("public_key", name="uq_org_metering_keys_public_key"),
    )
    op.create_index("ix_org_metering_keys_org_id", "org_metering_keys", ["org_id"])

    op.create_table(
        "org_pageview_daily",
        sa.Column("id", postgresql.UUID(as_uuid=True), primary_key=True),
        sa.Column("org_id", postgresql.UUID(as_uuid=True), nullable=False),
        sa.Column("path", sa.Text(), nullable=False),
        sa.Column("day", sa.Date(), nullable=False),
        sa.Column("count", sa.Integer(), nullable=False, server_default="0"),
        sa.Column("created_at", sa.DateTime(timezone=True), server_default=sa.text("now()"), nullable=False),
        sa.Column("updated_at", sa.DateTime(timezone=True), server_default=sa.text("now()"), nullable=False),
        sa.UniqueConstraint("org_id", "path", "day", name="uq_org_pageview_daily_org_path_day"),
    )
    op.create_index("ix_org_pageview_daily_org_path", "org_pageview_daily", ["org_id", "path"])


def downgrade() -> None:
    op.drop_index("ix_org_pageview_daily_org_path", table_name="org_pageview_daily")
    op.drop_table("org_pageview_daily")
    op.drop_index("ix_org_metering_keys_org_id", table_name="org_metering_keys")
    op.drop_table("org_metering_keys")
