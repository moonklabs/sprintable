"""story #3261(지원v1·3오케스트레이션) — 메모리 요약 필드 + 실행 로그·에스컬레이션 테이블 +
메시지 비용 컬럼.

Revision ID: 0002
Revises: 0001
Create Date: 2026-08-31

"""
from __future__ import annotations

from alembic import op
import sqlalchemy as sa
from sqlalchemy.dialects import postgresql

revision = "0002"
down_revision = "0001"
branch_labels = None
depends_on = None


def upgrade() -> None:
    op.add_column("support_conversations", sa.Column("memory_summary", sa.Text(), nullable=True))
    op.add_column(
        "support_conversations",
        sa.Column("memory_summarized_through_message_id", postgresql.UUID(as_uuid=True), nullable=True),
    )
    op.add_column("support_messages", sa.Column("cost_usd", sa.Float(), nullable=True))

    op.create_table(
        "support_execution_logs",
        sa.Column("id", postgresql.UUID(as_uuid=True), primary_key=True),
        sa.Column(
            "conversation_id",
            postgresql.UUID(as_uuid=True),
            sa.ForeignKey("support_conversations.id"),
            nullable=False,
        ),
        sa.Column("org_id", postgresql.UUID(as_uuid=True), nullable=False),
        sa.Column("task_type", sa.Text(), nullable=False),
        sa.Column("model", sa.Text(), nullable=False),
        sa.Column("summary", sa.Text(), nullable=False),
        sa.Column("cost_usd", sa.Float(), nullable=True),
        sa.Column("created_at", sa.DateTime(timezone=True), server_default=sa.func.now(), nullable=False),
    )
    op.create_index("ix_support_execution_logs_conversation_id", "support_execution_logs", ["conversation_id"])
    op.create_index("ix_support_execution_logs_org_id", "support_execution_logs", ["org_id"])

    op.create_table(
        "support_escalations",
        sa.Column("id", postgresql.UUID(as_uuid=True), primary_key=True),
        sa.Column(
            "conversation_id",
            postgresql.UUID(as_uuid=True),
            sa.ForeignKey("support_conversations.id"),
            nullable=False,
        ),
        sa.Column("org_id", postgresql.UUID(as_uuid=True), nullable=False),
        sa.Column("reason", sa.Text(), nullable=False),
        sa.Column("detail", sa.Text(), nullable=False),
        sa.Column("status", sa.Text(), nullable=False, server_default="open"),
        sa.Column("created_at", sa.DateTime(timezone=True), server_default=sa.func.now(), nullable=False),
    )
    op.create_index("ix_support_escalations_conversation_id", "support_escalations", ["conversation_id"])
    op.create_index("ix_support_escalations_org_id", "support_escalations", ["org_id"])


def downgrade() -> None:
    op.drop_table("support_escalations")
    op.drop_table("support_execution_logs")
    op.drop_column("support_messages", "cost_usd")
    op.drop_column("support_conversations", "memory_summarized_through_message_id")
    op.drop_column("support_conversations", "memory_summary")
