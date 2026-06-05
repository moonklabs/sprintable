"""add notification_preferences table

Revision ID: 0033
Revises: 0032
Create Date: 2026-05-15
"""
import sqlalchemy as sa
from alembic import op
from sqlalchemy.dialects.postgresql import UUID

revision = "0033"
down_revision = "0032"
branch_labels = None
depends_on = None


def upgrade() -> None:
    op.create_table(
        "notification_preferences",
        sa.Column("id", UUID(as_uuid=True), primary_key=True, server_default=sa.text("gen_random_uuid()")),
        sa.Column(
            "member_id",
            UUID(as_uuid=True),
            sa.ForeignKey("team_members.id", ondelete="CASCADE"),
            nullable=False,
        ),
        sa.Column("scope_type", sa.Text, nullable=False),  # global | project | conversation | thread
        sa.Column("scope_id", UUID(as_uuid=True), nullable=True),
        sa.Column("channel", sa.Text, nullable=False),  # sse | discord | telegram | in_app
        sa.Column("level", sa.Text, nullable=False),  # all | mentions | mute
        sa.Column("created_at", sa.DateTime(timezone=True), server_default=sa.text("now()"), nullable=False),
        sa.Column("updated_at", sa.DateTime(timezone=True), server_default=sa.text("now()"), nullable=False),
    )

    # scope_id IS NULL (global scope) — partial unique
    op.create_index(
        "uq_notif_pref_global",
        "notification_preferences",
        ["member_id", "scope_type", "channel"],
        unique=True,
        postgresql_where=sa.text("scope_id IS NULL"),
    )
    # scope_id IS NOT NULL (project/conversation/thread) — partial unique
    op.create_index(
        "uq_notif_pref_scoped",
        "notification_preferences",
        ["member_id", "scope_type", "scope_id", "channel"],
        unique=True,
        postgresql_where=sa.text("scope_id IS NOT NULL"),
    )
    # 조회 최적화
    op.create_index(
        "ix_notif_pref_member",
        "notification_preferences",
        ["member_id", "scope_type"],
    )


def downgrade() -> None:
    op.drop_index("ix_notif_pref_member", table_name="notification_preferences")
    op.drop_index("uq_notif_pref_scoped", table_name="notification_preferences")
    op.drop_index("uq_notif_pref_global", table_name="notification_preferences")
    op.drop_table("notification_preferences")
