"""add presence columns to team_members (S2-1)

Revision ID: 0038
Revises: 0037
Create Date: 2026-05-19
"""
import sqlalchemy as sa
from alembic import op

revision = "0038"
down_revision = "0037"
branch_labels = None
depends_on = None


def upgrade() -> None:
    # AC2: last_seen_at TIMESTAMPTZ NULL — passive heartbeat 기록
    op.add_column(
        "team_members",
        sa.Column("last_seen_at", sa.TIMESTAMP(timezone=True), nullable=True),
    )
    # AC3: active_story_id UUID NULL FK stories(id) ON DELETE SET NULL
    op.add_column(
        "team_members",
        sa.Column(
            "active_story_id",
            sa.UUID(as_uuid=True),
            sa.ForeignKey("stories.id", ondelete="SET NULL"),
            nullable=True,
        ),
    )
    # AC4: agent_status VARCHAR(20) NULL — online/idle/offline
    op.add_column(
        "team_members",
        sa.Column("agent_status", sa.String(20), nullable=True),
    )


def downgrade() -> None:
    op.drop_column("team_members", "agent_status")
    op.drop_column("team_members", "active_story_id")
    op.drop_column("team_members", "last_seen_at")
