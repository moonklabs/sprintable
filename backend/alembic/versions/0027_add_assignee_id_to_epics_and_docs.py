"""add assignee_id to epics and docs tables

Revision ID: 0027
Revises: 0026
Create Date: 2026-05-13
"""
import sqlalchemy as sa
from alembic import op
from sqlalchemy.dialects.postgresql import UUID

revision = "0027"
down_revision = "0026"
branch_labels = None
depends_on = None


def upgrade() -> None:
    op.add_column(
        "epics",
        sa.Column(
            "assignee_id",
            UUID(as_uuid=True),
            sa.ForeignKey("team_members.id", ondelete="SET NULL"),
            nullable=True,
        ),
    )
    op.add_column(
        "docs",
        sa.Column(
            "assignee_id",
            UUID(as_uuid=True),
            sa.ForeignKey("team_members.id", ondelete="SET NULL"),
            nullable=True,
        ),
    )


def downgrade() -> None:
    op.drop_column("epics", "assignee_id")
    op.drop_column("docs", "assignee_id")
