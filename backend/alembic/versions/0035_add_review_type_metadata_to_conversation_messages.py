"""add review_type and metadata to conversation_messages (S-B4)

Revision ID: 0035
Revises: 0034
Create Date: 2026-05-15
"""
from alembic import op

revision = "0035"
down_revision = "0034"
branch_labels = None
depends_on = None


def upgrade() -> None:
    # AC1: IF NOT EXISTS — S-A에서 이미 추가된 경우 no-op
    op.execute("""
        ALTER TABLE conversation_messages
        ADD COLUMN IF NOT EXISTS review_type TEXT,
        ADD COLUMN IF NOT EXISTS metadata JSONB
    """)


def downgrade() -> None:
    op.execute("ALTER TABLE conversation_messages DROP COLUMN IF EXISTS review_type")
    op.execute("ALTER TABLE conversation_messages DROP COLUMN IF EXISTS metadata")
