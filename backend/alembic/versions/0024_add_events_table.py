"""add events table

Revision ID: 0024
Revises: 0023
Create Date: 2026-05-12
"""
import sqlalchemy as sa
from alembic import op
from sqlalchemy.dialects.postgresql import JSONB, UUID

revision = "0024"
down_revision = "0023"
branch_labels = None
depends_on = None


def upgrade() -> None:
    op.create_table(
        "events",
        sa.Column("id", UUID(as_uuid=True), primary_key=True),
        sa.Column("org_id", UUID(as_uuid=True), nullable=False),
        sa.Column("project_id", UUID(as_uuid=True), nullable=False),
        sa.Column("event_type", sa.Text(), nullable=False),
        sa.Column("source_entity_type", sa.Text(), nullable=True),
        sa.Column("source_entity_id", UUID(as_uuid=True), nullable=True),
        sa.Column("sender_id", UUID(as_uuid=True), nullable=True),
        sa.Column("recipient_id", UUID(as_uuid=True), nullable=False),
        sa.Column("recipient_type", sa.Text(), nullable=False),
        sa.Column("payload", JSONB(), nullable=False, server_default="{}"),
        sa.Column("status", sa.Text(), nullable=False, server_default="pending"),
        sa.Column("created_at", sa.DateTime(timezone=True), server_default=sa.func.now(), nullable=False),
        sa.Column("delivered_at", sa.DateTime(timezone=True), nullable=True),
        sa.ForeignKeyConstraint(["project_id"], ["projects.id"], ondelete="CASCADE"),
        sa.ForeignKeyConstraint(["sender_id"], ["team_members.id"], ondelete="SET NULL"),
        sa.ForeignKeyConstraint(["recipient_id"], ["team_members.id"], ondelete="CASCADE"),
    )

    op.create_index("ix_events_org_id", "events", ["org_id"])
    op.create_index(
        "ix_events_project_recipient_status",
        "events",
        ["project_id", "recipient_id", "status"],
    )
    op.create_index(
        "ix_events_project_created_at",
        "events",
        ["project_id", "created_at"],
    )


def downgrade() -> None:
    op.drop_index("ix_events_project_created_at", table_name="events")
    op.drop_index("ix_events_project_recipient_status", table_name="events")
    op.drop_index("ix_events_org_id", table_name="events")
    op.drop_table("events")
