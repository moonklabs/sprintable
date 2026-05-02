"""add story_comments and story_activities tables

Revision ID: 0006
Revises: 0005
Create Date: 2026-05-03

"""
from __future__ import annotations

from alembic import op
import sqlalchemy as sa
from sqlalchemy.dialects.postgresql import UUID

revision = "0006"
down_revision = "0005"
branch_labels = None
depends_on = None


def upgrade() -> None:
    op.create_table(
        "story_comments",
        sa.Column("id", UUID(as_uuid=True), primary_key=True),
        sa.Column("story_id", UUID(as_uuid=True), sa.ForeignKey("stories.id", ondelete="CASCADE"), nullable=False),
        sa.Column("org_id", UUID(as_uuid=True), sa.ForeignKey("organizations.id", ondelete="CASCADE"), nullable=False),
        sa.Column("project_id", UUID(as_uuid=True), sa.ForeignKey("projects.id", ondelete="CASCADE"), nullable=False),
        sa.Column("content", sa.Text, nullable=False),
        sa.Column("created_by", UUID(as_uuid=True), sa.ForeignKey("team_members.id", ondelete="CASCADE"), nullable=False),
        sa.Column("created_at", sa.DateTime(timezone=True), server_default=sa.func.now(), nullable=False),
        sa.Column("updated_at", sa.DateTime(timezone=True), server_default=sa.func.now(), nullable=False),
        sa.Column("deleted_at", sa.DateTime(timezone=True), nullable=True),
    )
    op.create_index("ix_story_comments_story_id", "story_comments", ["story_id"])
    op.create_index("ix_story_comments_org_id", "story_comments", ["org_id"])

    op.create_table(
        "story_activities",
        sa.Column("id", UUID(as_uuid=True), primary_key=True),
        sa.Column("story_id", UUID(as_uuid=True), sa.ForeignKey("stories.id", ondelete="CASCADE"), nullable=False),
        sa.Column("org_id", UUID(as_uuid=True), sa.ForeignKey("organizations.id", ondelete="CASCADE"), nullable=False),
        sa.Column("project_id", UUID(as_uuid=True), sa.ForeignKey("projects.id", ondelete="CASCADE"), nullable=False),
        sa.Column("activity_type", sa.Text, nullable=False),
        sa.Column("old_value", sa.Text, nullable=True),
        sa.Column("new_value", sa.Text, nullable=True),
        sa.Column("created_by", UUID(as_uuid=True), sa.ForeignKey("team_members.id", ondelete="CASCADE"), nullable=False),
        sa.Column("created_at", sa.DateTime(timezone=True), server_default=sa.func.now(), nullable=False),
    )
    op.create_index("ix_story_activities_story_id", "story_activities", ["story_id"])
    op.create_index("ix_story_activities_org_id", "story_activities", ["org_id"])


def downgrade() -> None:
    op.drop_index("ix_story_activities_org_id", table_name="story_activities")
    op.drop_index("ix_story_activities_story_id", table_name="story_activities")
    op.drop_table("story_activities")
    op.drop_index("ix_story_comments_org_id", table_name="story_comments")
    op.drop_index("ix_story_comments_story_id", table_name="story_comments")
    op.drop_table("story_comments")
