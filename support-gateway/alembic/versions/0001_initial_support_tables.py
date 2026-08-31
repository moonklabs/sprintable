"""story #3259 — support_sessions/support_conversations/support_messages 초기 스키마.
이 서비스의 독립 리비전 체인 시작점(backend/alembic의 0001~0295 체인과 완전히 별개 —
같은 DB 인스턴스를 공유하지 않으므로 번호 충돌 우려 자체가 없다).

Revision ID: 0001
Revises:
Create Date: 2026-08-31

"""
from __future__ import annotations

from alembic import op
import sqlalchemy as sa
from sqlalchemy.dialects import postgresql

revision = "0001"
down_revision = None
branch_labels = None
depends_on = None


def upgrade() -> None:
    op.create_table(
        "support_sessions",
        sa.Column("id", postgresql.UUID(as_uuid=True), primary_key=True),
        sa.Column("org_id", postgresql.UUID(as_uuid=True), nullable=False),
        sa.Column("external_user_id", postgresql.UUID(as_uuid=True), nullable=False),
        sa.Column("created_at", sa.DateTime(timezone=True), server_default=sa.func.now(), nullable=False),
        sa.Column("last_seen_at", sa.DateTime(timezone=True), server_default=sa.func.now(), nullable=False),
        sa.Column("expired_at", sa.DateTime(timezone=True), nullable=True),
    )
    op.create_index("ix_support_sessions_org_id", "support_sessions", ["org_id"])
    op.create_index("ix_support_sessions_external_user_id", "support_sessions", ["external_user_id"])

    op.create_table(
        "support_conversations",
        sa.Column("id", postgresql.UUID(as_uuid=True), primary_key=True),
        sa.Column("org_id", postgresql.UUID(as_uuid=True), nullable=False),
        sa.Column(
            "session_id",
            postgresql.UUID(as_uuid=True),
            sa.ForeignKey("support_sessions.id"),
            nullable=False,
        ),
        sa.Column("created_at", sa.DateTime(timezone=True), server_default=sa.func.now(), nullable=False),
    )
    op.create_index("ix_support_conversations_org_id", "support_conversations", ["org_id"])

    op.create_table(
        "support_messages",
        sa.Column("id", postgresql.UUID(as_uuid=True), primary_key=True),
        sa.Column(
            "conversation_id",
            postgresql.UUID(as_uuid=True),
            sa.ForeignKey("support_conversations.id"),
            nullable=False,
        ),
        sa.Column("org_id", postgresql.UUID(as_uuid=True), nullable=False),
        sa.Column("role", sa.Text(), nullable=False),
        sa.Column("content", sa.Text(), nullable=False),
        sa.Column("created_at", sa.DateTime(timezone=True), server_default=sa.func.now(), nullable=False),
    )
    op.create_index("ix_support_messages_conversation_id", "support_messages", ["conversation_id"])
    op.create_index("ix_support_messages_org_id", "support_messages", ["org_id"])
    op.create_check_constraint(
        "ck_support_messages_role", "support_messages", "role IN ('customer', 'agent', 'system')"
    )


def downgrade() -> None:
    op.drop_table("support_messages")
    op.drop_table("support_conversations")
    op.drop_table("support_sessions")
