"""add file_locks table (S4-1)

Revision ID: 0040
Revises: 0039
Create Date: 2026-05-19
"""
import sqlalchemy as sa
from alembic import op

revision = "0040"
down_revision = "0039"
branch_labels = None
depends_on = None


def upgrade() -> None:
    op.create_table(
        "file_locks",
        sa.Column("id", sa.UUID(as_uuid=True), primary_key=True),
        sa.Column("org_id", sa.UUID(as_uuid=True), nullable=False),
        sa.Column("project_id", sa.UUID(as_uuid=True), nullable=False),
        sa.Column("member_id", sa.UUID(as_uuid=True),
                  sa.ForeignKey("team_members.id", ondelete="CASCADE"), nullable=False),
        sa.Column("story_id", sa.UUID(as_uuid=True),
                  sa.ForeignKey("stories.id", ondelete="SET NULL"), nullable=True),
        sa.Column("file_path", sa.Text, nullable=False),
        sa.Column("locked_at", sa.TIMESTAMP(timezone=True), server_default=sa.text("now()"), nullable=False),
        sa.Column("released_at", sa.TIMESTAMP(timezone=True), nullable=True),
    )
    op.create_index("ix_file_locks_org_id", "file_locks", ["org_id"])
    op.create_index("ix_file_locks_project_id", "file_locks", ["project_id"])
    op.create_index("ix_file_locks_file_path", "file_locks", ["file_path"])
    op.create_index("ix_file_locks_active", "file_locks", ["file_path", "released_at"])


def downgrade() -> None:
    op.drop_table("file_locks")
