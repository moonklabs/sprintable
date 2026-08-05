"""story #2460(§6 봉합②) — 웹훅/푸시 배달 트랜잭셔널 아웃박스 테이블. request 경로가 동기
HTTP 배달(웹훅 3회재시도·10s·Expo push)을 caller 세션 위에서 하던 것을 이 테이블 insert로
대체 — 실 배달은 delivery_dispatcher.py 워커가 자기 세션으로 수행한다.

Revision ID: 0227
Revises: 0226
Create Date: 2026-08-05
"""
from __future__ import annotations

from alembic import op
import sqlalchemy as sa
from sqlalchemy.dialects import postgresql

revision = "0227"
down_revision = "0226"
branch_labels = None
depends_on = None


def upgrade() -> None:
    op.create_table(
        "delivery_jobs",
        sa.Column("id", postgresql.UUID(as_uuid=True), primary_key=True),
        sa.Column("org_id", postgresql.UUID(as_uuid=True), nullable=False),
        sa.Column("kind", sa.Text(), nullable=False),
        sa.Column("payload", postgresql.JSONB(), nullable=False, server_default="{}"),
        sa.Column("status", sa.Text(), nullable=False, server_default="pending"),
        sa.Column("attempts", sa.Integer(), nullable=False, server_default="0"),
        sa.Column("last_error", sa.Text(), nullable=True),
        sa.Column("created_at", sa.DateTime(timezone=True), server_default=sa.func.now(), nullable=False),
        sa.Column("delivered_at", sa.DateTime(timezone=True), nullable=True),
        sa.CheckConstraint(
            "kind IN ('org_webhook', 'personal_webhook', 'expo_push')", name="ck_delivery_jobs_kind"
        ),
        sa.CheckConstraint("status IN ('pending', 'delivered', 'failed')", name="ck_delivery_jobs_status"),
    )
    op.create_index("ix_delivery_jobs_org_id", "delivery_jobs", ["org_id"])
    op.create_index(
        "ix_delivery_jobs_pending", "delivery_jobs", ["id"],
        postgresql_where=sa.text("status = 'pending'"),
    )


def downgrade() -> None:
    op.drop_index("ix_delivery_jobs_pending", table_name="delivery_jobs")
    op.drop_index("ix_delivery_jobs_org_id", table_name="delivery_jobs")
    op.drop_table("delivery_jobs")
