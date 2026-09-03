"""story #3374(Phase1·마케팅운영, 페드루 PO 확定 2026-09-03) —
channel_post_drafts/channel_post_versions.

site_post_drafts/site_post_versions(story #3365)와 구조 미러, 페이로드만 채널 전용
(channel/connection_id·text/link_url). 유니크는 (org_id, work_item_id, connection_id)
— channel은 connection_id의 파생값이라 독립 식별축이 아니다(PO 정정, 2026-09-03
08:13Z — 한 채널에 여러 connection이 있을 수 있다).

Revision ID: 0314
Revises: 0313
Create Date: 2026-09-03
"""
from __future__ import annotations

import sqlalchemy as sa
from alembic import op
from sqlalchemy.dialects import postgresql

revision = "0314"
down_revision = "0313"
branch_labels = None
depends_on = None


def upgrade() -> None:
    op.create_table(
        "channel_post_drafts",
        sa.Column("id", postgresql.UUID(as_uuid=True), primary_key=True),
        sa.Column("org_id", postgresql.UUID(as_uuid=True), nullable=False),
        sa.Column("work_item_id", postgresql.UUID(as_uuid=True), nullable=False),
        sa.Column("channel", sa.Text(), nullable=False),
        sa.Column("connection_id", postgresql.UUID(as_uuid=True), nullable=False),
        sa.Column("status", sa.Text(), nullable=False, server_default="draft"),
        sa.Column("created_at", sa.DateTime(timezone=True), server_default=sa.func.now(), nullable=False),
        sa.Column(
            "updated_at", sa.DateTime(timezone=True), server_default=sa.func.now(), nullable=False,
        ),
        sa.UniqueConstraint(
            "org_id", "work_item_id", "connection_id", name="uq_channel_post_drafts_org_work_item_connection",
        ),
    )
    op.create_index(
        "ix_channel_post_drafts_org_id", "channel_post_drafts", ["org_id"],
    )

    op.create_table(
        "channel_post_versions",
        sa.Column("id", postgresql.UUID(as_uuid=True), primary_key=True),
        sa.Column(
            "draft_id", postgresql.UUID(as_uuid=True),
            sa.ForeignKey("channel_post_drafts.id"), nullable=False,
        ),
        sa.Column("version", sa.Integer(), nullable=False),
        sa.Column("text", sa.Text(), nullable=False),
        sa.Column("link_url", sa.Text(), nullable=True),
        sa.Column("body_sha256", sa.Text(), nullable=False),
        sa.Column("author_member_id", postgresql.UUID(as_uuid=True), nullable=False),
        sa.Column("author_kind", sa.Text(), nullable=False),
        sa.Column("created_at", sa.DateTime(timezone=True), server_default=sa.func.now(), nullable=False),
        sa.UniqueConstraint("draft_id", "version", name="uq_channel_post_versions_draft_version"),
    )
    op.create_index(
        "ix_channel_post_versions_draft_id", "channel_post_versions", ["draft_id"],
    )


def downgrade() -> None:
    op.drop_index("ix_channel_post_versions_draft_id", table_name="channel_post_versions")
    op.drop_table("channel_post_versions")
    op.drop_index("ix_channel_post_drafts_org_id", table_name="channel_post_drafts")
    op.drop_table("channel_post_drafts")
