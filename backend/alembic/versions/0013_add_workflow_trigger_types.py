"""add workflow_trigger_types table

Revision ID: 0013
Revises: 0012
Create Date: 2026-05-08
"""
from __future__ import annotations

from alembic import op
import sqlalchemy as sa
from sqlalchemy.dialects.postgresql import UUID

revision = "0013"
down_revision = "0012"
branch_labels = None
depends_on = None


def upgrade() -> None:
    op.create_table(
        "workflow_trigger_types",
        sa.Column("id", UUID(as_uuid=True), primary_key=True),
        sa.Column("org_id", UUID(as_uuid=True), sa.ForeignKey("organizations.id", ondelete="CASCADE"), nullable=False, index=True),
        sa.Column("slug", sa.Text, nullable=False),
        sa.Column("label", sa.Text, nullable=False),
        sa.Column("description", sa.Text, nullable=True),
        sa.Column("is_system", sa.Boolean, nullable=False, server_default="false"),
        sa.Column("is_enabled", sa.Boolean, nullable=False, server_default="true"),
        sa.Column("deleted_at", sa.DateTime(timezone=True), nullable=True),
        sa.Column("created_at", sa.DateTime(timezone=True), server_default=sa.func.now(), nullable=False),
        sa.Column("updated_at", sa.DateTime(timezone=True), server_default=sa.func.now(), nullable=False),
    )
    op.create_index("ix_workflow_trigger_types_org_id", "workflow_trigger_types", ["org_id"])
    op.create_index(
        "uq_workflow_trigger_types_org_slug",
        "workflow_trigger_types",
        ["org_id", "slug"],
        unique=True,
        postgresql_where=sa.text("deleted_at IS NULL"),
    )


def downgrade() -> None:
    op.drop_index("uq_workflow_trigger_types_org_slug", table_name="workflow_trigger_types")
    op.drop_index("ix_workflow_trigger_types_org_id", table_name="workflow_trigger_types")
    op.drop_table("workflow_trigger_types")
