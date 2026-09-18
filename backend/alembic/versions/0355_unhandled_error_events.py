"""story #3672(BE·BFF·FE·관측, 페드루 PO 確定 2026-09-07) — 미처리 500의 서버측
지속 흔적(unhandled_error_events). id=error_id(응답 봉투·로그 한 줄과 동일 값) —
서버 발급 uuid4를 앱 코드가 그대로 싣는다(server_default 없음, 항상 명시 INSERT).

Revision ID: 0355
Revises: 0354
Create Date: 2026-09-07
"""
from __future__ import annotations

import sqlalchemy as sa
from alembic import op
from sqlalchemy.dialects import postgresql

revision = "0355"
down_revision = "0354"
branch_labels = None
depends_on = None


def upgrade() -> None:
    op.create_table(
        "unhandled_error_events",
        sa.Column("id", postgresql.UUID(as_uuid=True), nullable=False),
        sa.Column("occurred_at", sa.DateTime(timezone=True), server_default=sa.text("now()"), nullable=False),
        sa.Column("method", sa.Text(), nullable=False),
        sa.Column("path", sa.Text(), nullable=False),
        sa.Column("exception_class", sa.Text(), nullable=False),
        sa.Column("message", sa.Text(), nullable=True),
        sa.Column("org_id", postgresql.UUID(as_uuid=True), nullable=True),
        sa.Column("user_id", postgresql.UUID(as_uuid=True), nullable=True),
        sa.Column("request_id", sa.Text(), nullable=True),
        sa.PrimaryKeyConstraint("id"),
    )
    op.create_index("ix_unhandled_error_events_occurred_at", "unhandled_error_events", ["occurred_at"])
    op.create_index("ix_unhandled_error_events_org_id", "unhandled_error_events", ["org_id"])


def downgrade() -> None:
    op.drop_index("ix_unhandled_error_events_org_id", table_name="unhandled_error_events")
    op.drop_index("ix_unhandled_error_events_occurred_at", table_name="unhandled_error_events")
    op.drop_table("unhandled_error_events")
