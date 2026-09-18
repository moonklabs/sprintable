"""story #3365(Phase0 S1·마케팅 운영 블루프린트 v3, 선생님 확定 2026-09-03) — 초안·불변 버전
원장. 고객 에이전트가 넣는 초안과 휴먼 개정본을 `site_posts`(공개 projection)와 분리된 별도
테이블에 쌓는다 — 승인·발행 전에는 공개 행이 절대 생기지 않는다.

Revision ID: 0308
Revises: 0307
Create Date: 2026-09-03
"""
from __future__ import annotations

import sqlalchemy as sa
from alembic import op
from sqlalchemy.dialects import postgresql

revision = "0308"
down_revision = "0307"
branch_labels = None
depends_on = None


def upgrade() -> None:
    op.create_table(
        "site_post_drafts",
        sa.Column("id", postgresql.UUID(as_uuid=True), primary_key=True),
        sa.Column("org_id", postgresql.UUID(as_uuid=True), nullable=False),
        sa.Column("work_item_id", postgresql.UUID(as_uuid=True), nullable=False),
        sa.Column("slug", sa.Text(), nullable=False),
        sa.Column("status", sa.Text(), nullable=False, server_default="draft"),
        sa.Column("created_at", sa.DateTime(timezone=True), server_default=sa.text("now()"), nullable=False),
        sa.Column("updated_at", sa.DateTime(timezone=True), server_default=sa.text("now()"), nullable=False),
        sa.UniqueConstraint("org_id", "work_item_id", "slug", name="uq_site_post_drafts_org_work_item_slug"),
    )
    op.create_index("ix_site_post_drafts_org_id", "site_post_drafts", ["org_id"])

    op.create_table(
        "site_post_versions",
        sa.Column("id", postgresql.UUID(as_uuid=True), primary_key=True),
        sa.Column(
            "draft_id", postgresql.UUID(as_uuid=True),
            sa.ForeignKey("site_post_drafts.id"), nullable=False,
        ),
        sa.Column("version", sa.Integer(), nullable=False),
        sa.Column("title", sa.Text(), nullable=False),
        sa.Column("lang", sa.Text(), nullable=False),
        sa.Column("summary", sa.Text(), nullable=False),
        sa.Column("tags", postgresql.JSONB(astext_type=sa.Text()), nullable=False, server_default="[]"),
        sa.Column("body_md", sa.Text(), nullable=False),
        sa.Column("body_sha256", sa.Text(), nullable=False),
        sa.Column("author_member_id", postgresql.UUID(as_uuid=True), nullable=False),
        sa.Column("author_kind", sa.Text(), nullable=False),
        sa.Column("created_at", sa.DateTime(timezone=True), server_default=sa.text("now()"), nullable=False),
        sa.UniqueConstraint("draft_id", "version", name="uq_site_post_versions_draft_version"),
    )
    op.create_index("ix_site_post_versions_draft_id", "site_post_versions", ["draft_id"])


def downgrade() -> None:
    op.drop_index("ix_site_post_versions_draft_id", table_name="site_post_versions")
    op.drop_table("site_post_versions")
    op.drop_index("ix_site_post_drafts_org_id", table_name="site_post_drafts")
    op.drop_table("site_post_drafts")
