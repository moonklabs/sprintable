"""add thread_id, reply_count, last_reply_at to conversation_messages

Revision ID: 0031
Revises: 0030
Create Date: 2026-05-15
"""
import sqlalchemy as sa
from alembic import op
from sqlalchemy.dialects.postgresql import UUID

revision = "0031"
down_revision = "0030"
branch_labels = None
depends_on = None


def upgrade() -> None:
    op.add_column(
        "conversation_messages",
        sa.Column(
            "thread_id",
            UUID(as_uuid=True),
            sa.ForeignKey("conversation_messages.id", ondelete="SET NULL"),
            nullable=True,
        ),
    )
    op.add_column(
        "conversation_messages",
        sa.Column("reply_count", sa.Integer, nullable=False, server_default="0"),
    )
    op.add_column(
        "conversation_messages",
        sa.Column("last_reply_at", sa.DateTime(timezone=True), nullable=True),
    )

    # top-level 메시지 조회 최적화 (기본 list 경로)
    op.create_index(
        "ix_conversation_messages_top_level",
        "conversation_messages",
        ["conversation_id", "created_at"],
        postgresql_where=sa.text("thread_id IS NULL"),
    )
    # reply 조회 최적화
    op.create_index(
        "ix_conversation_messages_thread",
        "conversation_messages",
        ["thread_id", "created_at"],
        postgresql_where=sa.text("thread_id IS NOT NULL"),
    )


def downgrade() -> None:
    op.drop_index("ix_conversation_messages_thread", table_name="conversation_messages")
    op.drop_index("ix_conversation_messages_top_level", table_name="conversation_messages")
    op.drop_column("conversation_messages", "last_reply_at")
    op.drop_column("conversation_messages", "reply_count")
    op.drop_column("conversation_messages", "thread_id")
