"""add unique constraint on org_members(org_id, user_id)

Revision ID: 0012
Revises: 0011
Create Date: 2026-05-07
"""
from __future__ import annotations

from alembic import op

revision = "0012"
down_revision = "0011"
branch_labels = None
depends_on = None


def upgrade() -> None:
    op.execute("""
        DO $$ BEGIN
            IF NOT EXISTS (
                SELECT 1 FROM pg_constraint
                WHERE conname = 'uq_org_members_org_user'
            ) THEN
                ALTER TABLE org_members
                    ADD CONSTRAINT uq_org_members_org_user UNIQUE (org_id, user_id);
            END IF;
        END $$;
    """)


def downgrade() -> None:
    op.execute("""
        ALTER TABLE org_members
            DROP CONSTRAINT IF EXISTS uq_org_members_org_user;
    """)
