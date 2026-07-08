"""E-A2A-POC S2 (story 1485217f): a2a_tasks.root_message_id — task-완료 상관관계 폴링 키.

Revision ID: 0159
Revises: 0158
Create Date: 2026-07-06
"""
from __future__ import annotations

from alembic import op
import sqlalchemy as sa
from sqlalchemy.dialects import postgresql

revision = "0159"
down_revision = "0158"
branch_labels = None
depends_on = None


def upgrade() -> None:
    op.add_column(
        "a2a_tasks",
        sa.Column("root_message_id", postgresql.UUID(as_uuid=True), nullable=True),
    )


def downgrade() -> None:
    op.drop_column("a2a_tasks", "root_message_id")
