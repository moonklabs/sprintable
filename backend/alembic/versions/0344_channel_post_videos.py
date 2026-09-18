"""story #3554(Phase2·마케팅운영, 페드루 PO 確定 2026-09-06) — Instagram 릴스(영상)
마스터 원장 신설. 커버는 새 테이블이 아니라 기존 `channel_post_images`(position=0)를
재사용한다(PO 明示) — 이 마이그가 새로 여는 건 영상 본편 저장뿐."""
from __future__ import annotations

import sqlalchemy as sa
from alembic import op
from sqlalchemy.dialects import postgresql

revision = "0344"
down_revision = "0343"
branch_labels = None
depends_on = None


def upgrade() -> None:
    op.create_table(
        "channel_post_videos",
        sa.Column("id", postgresql.UUID(as_uuid=True), primary_key=True),
        sa.Column("org_id", postgresql.UUID(as_uuid=True), nullable=False),
        sa.Column("draft_id", postgresql.UUID(as_uuid=True), nullable=False),
        sa.Column("version_id", postgresql.UUID(as_uuid=True), nullable=False),
        sa.Column("original_object_path", sa.Text(), nullable=False),
        sa.Column("original_sha256", sa.Text(), nullable=False),
        sa.Column("original_content_type", sa.Text(), nullable=False),
        sa.Column("original_bytes", sa.BigInteger(), nullable=False),
        sa.Column("duration_seconds", sa.Float(), nullable=False),
        sa.Column("width", sa.Integer(), nullable=False),
        sa.Column("height", sa.Integer(), nullable=False),
        sa.Column("codec", sa.Text(), nullable=False),
        sa.Column("created_by", postgresql.UUID(as_uuid=True), nullable=False),
        sa.Column("created_at", sa.DateTime(timezone=True), server_default=sa.func.now(), nullable=False),
        sa.UniqueConstraint("version_id", name="uq_channel_post_videos_version"),
    )
    op.create_index("ix_channel_post_videos_org_id", "channel_post_videos", ["org_id"])
    op.create_index("ix_channel_post_videos_draft_id", "channel_post_videos", ["draft_id"])


def downgrade() -> None:
    op.drop_index("ix_channel_post_videos_draft_id", table_name="channel_post_videos")
    op.drop_index("ix_channel_post_videos_org_id", table_name="channel_post_videos")
    op.drop_table("channel_post_videos")
