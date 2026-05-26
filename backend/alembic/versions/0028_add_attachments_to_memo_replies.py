"""add attachments to memo_replies

Revision ID: 0028
Revises: 0027
Create Date: 2026-05-13
"""
import sqlalchemy as sa
from alembic import op
from sqlalchemy.dialects.postgresql import JSONB

revision = "0028"
down_revision = "0027"
branch_labels = None
depends_on = None


def upgrade() -> None:
    # OSS fresh installs never have `memo_replies` (SaaS-only, retired in E-MEMO-RETIRE).
    conn = op.get_bind()
    memo_replies_exists = conn.execute(
        sa.text("SELECT EXISTS (SELECT 1 FROM information_schema.tables WHERE table_schema='public' AND table_name='memo_replies')")
    ).scalar()
    if not memo_replies_exists:
        return

    op.add_column(
        "memo_replies",
        sa.Column("attachments", JSONB, nullable=False, server_default="[]"),
    )


def downgrade() -> None:
    op.drop_column("memo_replies", "attachments")
