"""story #3143(9a5abc24, Chat ②층 P1 BE) — chat_command_audit_logs 신설.

서버 집행 커맨드(/done·/assign·/priority)의 행위자·대상·전후 값·결과를 기록한다. 기존
agent_audit_logs(agent_id NOT NULL)·permission_audit_logs(role 변경 전용 스키마) 둘 다
휴먼 발신 커맨드를 담을 수 없거나 필드가 이 도메인과 안 맞아 새 테이블로 분리한다.

Revision ID: 0285
Revises: 0284
Create Date: 2026-08-27
"""
from __future__ import annotations

from alembic import op
import sqlalchemy as sa
from sqlalchemy.dialects import postgresql

revision = "0285"
down_revision = "0284"
branch_labels = None
depends_on = None


def upgrade() -> None:
    op.create_table(
        "chat_command_audit_logs",
        sa.Column("id", postgresql.UUID(as_uuid=True), primary_key=True),
        sa.Column("org_id", postgresql.UUID(as_uuid=True), nullable=False),
        sa.Column("project_id", postgresql.UUID(as_uuid=True), nullable=True),
        sa.Column("conversation_id", postgresql.UUID(as_uuid=True), nullable=False),
        sa.Column("message_id", postgresql.UUID(as_uuid=True), nullable=False),
        sa.Column("actor_id", postgresql.UUID(as_uuid=True), nullable=False),
        sa.Column("actor_type", sa.Text(), nullable=False),
        sa.Column("command", sa.Text(), nullable=False),
        sa.Column("raw_args", sa.Text(), nullable=False),
        sa.Column("target_type", sa.Text(), nullable=True),
        sa.Column("target_id", postgresql.UUID(as_uuid=True), nullable=True),
        sa.Column("outcome", sa.Text(), nullable=False),
        sa.Column("before_value", sa.Text(), nullable=True),
        sa.Column("after_value", sa.Text(), nullable=True),
        sa.Column("reason", sa.Text(), nullable=True),
        sa.Column("metadata", postgresql.JSONB(), nullable=False, server_default="{}"),
        sa.Column("created_at", sa.DateTime(timezone=True), server_default=sa.func.now(), nullable=False),
    )
    op.create_index("ix_chat_command_audit_logs_org_id", "chat_command_audit_logs", ["org_id"])
    op.create_index("ix_chat_command_audit_logs_message_id", "chat_command_audit_logs", ["message_id"])


def downgrade() -> None:
    op.drop_index("ix_chat_command_audit_logs_message_id", table_name="chat_command_audit_logs")
    op.drop_index("ix_chat_command_audit_logs_org_id", table_name="chat_command_audit_logs")
    op.drop_table("chat_command_audit_logs")
