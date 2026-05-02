"""add doc_comments and doc_revisions tables

Revision ID: 0007
Revises: 0006
Create Date: 2026-05-03

"""
from __future__ import annotations

import sqlalchemy as sa
from alembic import op
from sqlalchemy.dialects.postgresql import UUID

revision = "0007"
down_revision = "0006"
branch_labels = None
depends_on = None


def upgrade() -> None:
    bind = op.get_bind()
    inspector = sa.inspect(bind)
    existing = set(inspector.get_table_names())

    if "doc_comments" not in existing:
        op.create_table(
            "doc_comments",
            sa.Column("id", UUID(as_uuid=True), primary_key=True),
            sa.Column("doc_id", UUID(as_uuid=True), sa.ForeignKey("docs.id", ondelete="CASCADE"), nullable=False),
            sa.Column("org_id", UUID(as_uuid=True), sa.ForeignKey("organizations.id", ondelete="CASCADE"), nullable=False),
            sa.Column("project_id", UUID(as_uuid=True), sa.ForeignKey("projects.id", ondelete="CASCADE"), nullable=False),
            sa.Column("content", sa.Text, nullable=False),
            sa.Column("created_by", UUID(as_uuid=True), sa.ForeignKey("team_members.id", ondelete="CASCADE"), nullable=False),
            sa.Column("created_at", sa.DateTime(timezone=True), server_default=sa.func.now(), nullable=False),
        )
        op.create_index("ix_doc_comments_doc_id", "doc_comments", ["doc_id"])
        op.create_index("ix_doc_comments_org_id", "doc_comments", ["org_id"])

    if "doc_revisions" not in existing:
        op.create_table(
            "doc_revisions",
            sa.Column("id", UUID(as_uuid=True), primary_key=True),
            sa.Column("doc_id", UUID(as_uuid=True), sa.ForeignKey("docs.id", ondelete="CASCADE"), nullable=False),
            sa.Column("org_id", UUID(as_uuid=True), sa.ForeignKey("organizations.id", ondelete="CASCADE"), nullable=False),
            sa.Column("project_id", UUID(as_uuid=True), sa.ForeignKey("projects.id", ondelete="CASCADE"), nullable=False),
            sa.Column("content", sa.Text, nullable=False, server_default=""),
            sa.Column("created_by", UUID(as_uuid=True), sa.ForeignKey("team_members.id", ondelete="SET NULL"), nullable=True),
            sa.Column("created_at", sa.DateTime(timezone=True), server_default=sa.func.now(), nullable=False),
        )
        op.create_index("ix_doc_revisions_doc_id", "doc_revisions", ["doc_id"])
        op.create_index("ix_doc_revisions_org_id", "doc_revisions", ["org_id"])


def downgrade() -> None:
    op.drop_index("ix_doc_revisions_org_id", table_name="doc_revisions")
    op.drop_index("ix_doc_revisions_doc_id", table_name="doc_revisions")
    op.drop_table("doc_revisions")
    op.drop_index("ix_doc_comments_org_id", table_name="doc_comments")
    op.drop_index("ix_doc_comments_doc_id", table_name="doc_comments")
    op.drop_table("doc_comments")
