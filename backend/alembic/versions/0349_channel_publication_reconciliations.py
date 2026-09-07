"""story #3620(Phase2·BE+FE·실측·4열, 페드루 PO 確定 2026-09-07) — 「채널 원본
지표와 evidence 대조」 기록 원장 신규 테이블. FK 없음(channel_connections·
insight_snapshots와 동일 관례, 그라운딩 §9)."""
from __future__ import annotations

import sqlalchemy as sa
from alembic import op
from sqlalchemy.dialects import postgresql

revision = "0349"
down_revision = "0348"
branch_labels = None
depends_on = None


def upgrade() -> None:
    op.create_table(
        "channel_publication_reconciliations",
        sa.Column("id", postgresql.UUID(as_uuid=True), primary_key=True),
        sa.Column("org_id", postgresql.UUID(as_uuid=True), nullable=False),
        sa.Column("publication_id", postgresql.UUID(as_uuid=True), nullable=False),
        sa.Column("snapshot_id", postgresql.UUID(as_uuid=True), nullable=True),
        sa.Column("live_raw", postgresql.JSONB(astext_type=sa.Text()), nullable=False),
        sa.Column("verdicts", postgresql.JSONB(astext_type=sa.Text()), nullable=False),
        sa.Column("has_mismatch", sa.Boolean(), nullable=False),
        sa.Column("requested_by_member_id", postgresql.UUID(as_uuid=True), nullable=False),
        sa.Column("created_at", sa.DateTime(timezone=True), server_default=sa.func.now(), nullable=False),
    )
    op.create_index(
        "ix_channel_publication_reconciliations_org_id", "channel_publication_reconciliations", ["org_id"],
    )
    op.create_index(
        "ix_channel_publication_reconciliations_publication_id",
        "channel_publication_reconciliations", ["publication_id"],
    )
    op.create_index(
        "ix_channel_publication_reconciliations_created_at",
        "channel_publication_reconciliations", ["created_at"],
    )


def downgrade() -> None:
    op.drop_index("ix_channel_publication_reconciliations_created_at", table_name="channel_publication_reconciliations")
    op.drop_index("ix_channel_publication_reconciliations_publication_id", table_name="channel_publication_reconciliations")
    op.drop_index("ix_channel_publication_reconciliations_org_id", table_name="channel_publication_reconciliations")
    op.drop_table("channel_publication_reconciliations")
