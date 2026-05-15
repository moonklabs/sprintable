"""add status, resolved_by, resolved_at to conversations

Revision ID: 0032
Revises: 0031
Create Date: 2026-05-15
"""
import sqlalchemy as sa
from alembic import op
from sqlalchemy.dialects.postgresql import UUID

revision = "0032"
down_revision = "0031"
branch_labels = None
depends_on = None


def upgrade() -> None:
    op.add_column(
        "conversations",
        sa.Column("status", sa.Text, nullable=False, server_default="open"),
    )
    op.add_column(
        "conversations",
        sa.Column(
            "resolved_by",
            UUID(as_uuid=True),
            sa.ForeignKey("team_members.id", ondelete="SET NULL"),
            nullable=True,
        ),
    )
    op.add_column(
        "conversations",
        sa.Column("resolved_at", sa.DateTime(timezone=True), nullable=True),
    )
    # 상태별 조회 최적화
    op.create_index(
        "ix_conversations_status",
        "conversations",
        ["org_id", "project_id", "status"],
    )


def downgrade() -> None:
    op.drop_index("ix_conversations_status", table_name="conversations")
    op.drop_column("conversations", "resolved_at")
    op.drop_column("conversations", "resolved_by")
    op.drop_column("conversations", "status")
