"""E-SECURITY SEC-S1(story 70c9e92c): deletion_audit_logs 테이블 — hard-delete 감사 흔적.

Revision ID: 0170
Revises: 0169
Create Date: 2026-07-10

순수 additive 신규 테이블 — 기존 스키마 무회귀.
"""
from __future__ import annotations

from alembic import op
import sqlalchemy as sa
from sqlalchemy.dialects import postgresql

revision = "0170"
down_revision = "0169"
branch_labels = None
depends_on = None


def upgrade() -> None:
    op.create_table(
        "deletion_audit_logs",
        sa.Column("id", postgresql.UUID(as_uuid=True), primary_key=True),
        sa.Column("org_id", postgresql.UUID(as_uuid=True), nullable=False),
        sa.Column("actor_id", postgresql.UUID(as_uuid=True), nullable=False),
        sa.Column("entity_type", sa.Text(), nullable=False),
        sa.Column("entity_id", postgresql.UUID(as_uuid=True), nullable=False),
        sa.Column("entity_title", sa.Text(), nullable=True),
        sa.Column("created_at", sa.DateTime(timezone=True), server_default=sa.text("now()"), nullable=False),
    )
    op.create_index("ix_deletion_audit_logs_org_id", "deletion_audit_logs", ["org_id"])
    op.create_index("ix_deletion_audit_logs_entity_id", "deletion_audit_logs", ["entity_id"])


def downgrade() -> None:
    op.drop_table("deletion_audit_logs")
