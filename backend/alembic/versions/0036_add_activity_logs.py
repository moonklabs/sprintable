"""add activity_logs table (S-C1)

Revision ID: 0036
Revises: 0035
Create Date: 2026-05-15
"""
import sqlalchemy as sa
from alembic import op
from sqlalchemy.dialects.postgresql import JSONB, UUID

revision = "0036"
down_revision = "0035"
branch_labels = None
depends_on = None


def upgrade() -> None:
    op.create_table(
        "activity_logs",
        sa.Column("id", UUID(as_uuid=True), primary_key=True),
        sa.Column("org_id", UUID(as_uuid=True), nullable=False),
        sa.Column("project_id", UUID(as_uuid=True), nullable=True),
        sa.Column("actor_id", UUID(as_uuid=True), nullable=True),
        sa.Column("actor_type", sa.Text(), nullable=False),
        sa.Column("action", sa.Text(), nullable=False),
        sa.Column("entity_type", sa.Text(), nullable=True),
        sa.Column("entity_id", UUID(as_uuid=True), nullable=True),
        sa.Column("context", JSONB(), nullable=False, server_default="{}"),
        sa.Column(
            "created_at",
            sa.DateTime(timezone=True),
            server_default=sa.text("NOW()"),
            nullable=False,
        ),
        sa.CheckConstraint("actor_type IN ('agent', 'human')", name="ck_activity_logs_actor_type"),
    )
    # AC: 인덱스 3개
    op.create_index("ix_activity_logs_org_created", "activity_logs", ["org_id", "created_at"])
    op.create_index("ix_activity_logs_actor_created", "activity_logs", ["actor_id", "created_at"])
    op.create_index("ix_activity_logs_entity", "activity_logs", ["entity_type", "entity_id"])


def downgrade() -> None:
    op.drop_index("ix_activity_logs_entity", table_name="activity_logs")
    op.drop_index("ix_activity_logs_actor_created", table_name="activity_logs")
    op.drop_index("ix_activity_logs_org_created", table_name="activity_logs")
    op.drop_table("activity_logs")
