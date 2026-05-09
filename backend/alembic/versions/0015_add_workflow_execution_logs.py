"""add workflow_execution_logs table

Revision ID: 0015
Revises: 0014
Create Date: 2026-05-09
"""
from __future__ import annotations

from alembic import op
import sqlalchemy as sa
from sqlalchemy.dialects.postgresql import JSONB, UUID

revision = "0015"
down_revision = "0014"
branch_labels = None
depends_on = None


def upgrade() -> None:
    op.create_table(
        "workflow_execution_logs",
        sa.Column("id", UUID(as_uuid=True), primary_key=True),
        sa.Column("org_id", UUID(as_uuid=True), nullable=False),
        sa.Column("project_id", UUID(as_uuid=True), nullable=False),
        sa.Column("rule_id", UUID(as_uuid=True), nullable=True),
        sa.Column("event_type", sa.Text, nullable=False),
        sa.Column("trigger_type_slug", sa.Text, nullable=True),
        sa.Column("event_context", JSONB, nullable=False, server_default="{}"),
        sa.Column("action", JSONB, nullable=True),
        sa.Column("target_agent_id", UUID(as_uuid=True), nullable=True),
        sa.Column("status", sa.Text, nullable=False, server_default="matched"),
        sa.Column("error_message", sa.Text, nullable=True),
        sa.Column("duration_ms", sa.Integer, nullable=True),
        sa.Column("created_at", sa.DateTime(timezone=True), server_default=sa.func.now(), nullable=False),
        sa.Column("completed_at", sa.DateTime(timezone=True), nullable=True),
    )
    op.create_index("ix_workflow_execution_logs_org_project", "workflow_execution_logs", ["org_id", "project_id"])
    op.create_index("ix_workflow_execution_logs_created_at", "workflow_execution_logs", ["created_at"])


def downgrade() -> None:
    op.drop_index("ix_workflow_execution_logs_created_at", table_name="workflow_execution_logs")
    op.drop_index("ix_workflow_execution_logs_org_project", table_name="workflow_execution_logs")
    op.drop_table("workflow_execution_logs")
