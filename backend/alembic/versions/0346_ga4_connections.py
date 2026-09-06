"""story #3583-BE(Phase2·마케팅운영, 페드루 PO 確定 2026-09-06) — GA4 «고객 소유»
측정 연결 신규 테이블. `channel_connections`와 별개(발행 채널 아님, PO 確定 ①) —
org당 1행(unique). FK 없음(channel_connections·channel_app_credentials와 동일
관례 — 그라운딩 §9)."""
from __future__ import annotations

import sqlalchemy as sa
from alembic import op
from sqlalchemy.dialects import postgresql

revision = "0346"
down_revision = "0345"
branch_labels = None
depends_on = None


def upgrade() -> None:
    op.create_table(
        "ga4_connections",
        sa.Column("id", postgresql.UUID(as_uuid=True), primary_key=True),
        sa.Column("org_id", postgresql.UUID(as_uuid=True), nullable=False, index=True),
        sa.Column("encrypted_access_token", sa.Text(), nullable=False),
        sa.Column("encrypted_refresh_token", sa.Text(), nullable=False),
        sa.Column("property_id", sa.Text(), nullable=True),
        sa.Column("property_name", sa.Text(), nullable=True),
        sa.Column("status", sa.Text(), nullable=False, server_default="property_pending"),
        sa.Column("reason", sa.Text(), nullable=True),
        sa.Column("connected_by", postgresql.UUID(as_uuid=True), nullable=True),
        sa.Column("connected_at", sa.DateTime(timezone=True), nullable=True),
        sa.Column("created_at", sa.DateTime(timezone=True), server_default=sa.func.now(), nullable=False),
        sa.Column(
            "updated_at", sa.DateTime(timezone=True), server_default=sa.func.now(), onupdate=sa.func.now(),
            nullable=False,
        ),
        sa.UniqueConstraint("org_id", name="uq_ga4_connections_org_id"),
    )


def downgrade() -> None:
    op.drop_table("ga4_connections")
