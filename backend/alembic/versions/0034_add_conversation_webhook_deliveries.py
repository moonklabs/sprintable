"""add conversation_webhook_deliveries table

Revision ID: 0034
Revises: 0033
Create Date: 2026-05-15
"""
import sqlalchemy as sa
from alembic import op
from sqlalchemy.dialects.postgresql import UUID

revision = "0034"
down_revision = "0033"
branch_labels = None
depends_on = None


def upgrade() -> None:
    op.create_table(
        "conversation_webhook_deliveries",
        sa.Column("id", UUID(as_uuid=True), primary_key=True, server_default=sa.text("gen_random_uuid()")),
        sa.Column(
            "message_id",
            UUID(as_uuid=True),
            sa.ForeignKey("conversation_messages.id", ondelete="CASCADE"),
            nullable=False,
            index=True,
        ),
        sa.Column(
            "webhook_config_id",
            UUID(as_uuid=True),
            sa.ForeignKey("webhook_configs.id", ondelete="SET NULL"),
            nullable=True,
            index=True,
        ),
        sa.Column("status", sa.Text, nullable=False, server_default="pending"),  # pending | delivered | failed
        sa.Column("attempt_count", sa.Integer, nullable=False, server_default="0"),
        sa.Column("last_error", sa.Text, nullable=True),
        sa.Column("created_at", sa.DateTime(timezone=True), server_default=sa.text("now()"), nullable=False),
        sa.Column("updated_at", sa.DateTime(timezone=True), server_default=sa.text("now()"), nullable=False),
    )
    op.create_index(
        "ix_conv_wh_deliveries_status",
        "conversation_webhook_deliveries",
        ["status", "created_at"],
    )


def downgrade() -> None:
    op.drop_index("ix_conv_wh_deliveries_status", table_name="conversation_webhook_deliveries")
    op.drop_table("conversation_webhook_deliveries")
