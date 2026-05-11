"""add login_audit_logs table

Revision ID: 0021
Revises: 0020
Create Date: 2026-05-11
"""
from __future__ import annotations

import sqlalchemy as sa
from alembic import op
from sqlalchemy.dialects import postgresql

revision = "0021"
down_revision = "0020"
branch_labels = None
depends_on = None


def upgrade() -> None:
    op.create_table(
        "login_audit_logs",
        sa.Column("id", postgresql.UUID(as_uuid=True), nullable=False, server_default=sa.text("gen_random_uuid()")),
        sa.Column("event_type", sa.Text(), nullable=False),
        sa.Column("user_id", postgresql.UUID(as_uuid=True), nullable=True),
        sa.Column("email", sa.Text(), nullable=True),
        sa.Column("ip_address", sa.Text(), nullable=True),
        sa.Column("user_agent", sa.Text(), nullable=True),
        sa.Column("detail", sa.Text(), nullable=True),
        sa.Column("created_at", sa.DateTime(timezone=True), server_default=sa.text("now()"), nullable=False),
        sa.PrimaryKeyConstraint("id"),
    )
    op.create_index("ix_login_audit_logs_event_type", "login_audit_logs", ["event_type"])
    op.create_index("ix_login_audit_logs_user_id", "login_audit_logs", ["user_id"])
    op.create_index("ix_login_audit_logs_created_at", "login_audit_logs", ["created_at"])


def downgrade() -> None:
    op.drop_index("ix_login_audit_logs_created_at", table_name="login_audit_logs")
    op.drop_index("ix_login_audit_logs_user_id", table_name="login_audit_logs")
    op.drop_index("ix_login_audit_logs_event_type", table_name="login_audit_logs")
    op.drop_table("login_audit_logs")
