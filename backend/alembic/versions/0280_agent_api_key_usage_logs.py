"""story #2087([BE] 에이전트 API 키 사용 이력 감사 트레일 부재) — agent_api_key_usage_logs 원장 신설.

성공 인증(get_current_user/get_current_user_streaming의 API-key 경로) 매 요청마다
append-only로 기록한다. story cd10e123 계열 인시던트 조사에서 "악용 여부"를 증명도 반증도
못 했던 갭을 메운다.

Revision ID: 0280
Revises: 0279
Create Date: 2026-08-25
"""
from __future__ import annotations

import sqlalchemy as sa
from alembic import op
from sqlalchemy.dialects import postgresql

revision = "0280"
down_revision = "0279"
branch_labels = None
depends_on = None


def upgrade() -> None:
    op.create_table(
        "agent_api_key_usage_logs",
        sa.Column("id", postgresql.UUID(as_uuid=True), primary_key=True),
        sa.Column("api_key_id", postgresql.UUID(as_uuid=True), nullable=False),
        sa.Column("org_id", postgresql.UUID(as_uuid=True), nullable=True),
        sa.Column("member_id", postgresql.UUID(as_uuid=True), nullable=True),
        sa.Column("endpoint", sa.Text(), nullable=False),
        sa.Column("method", sa.Text(), nullable=False),
        sa.Column("remote_ip", sa.Text(), nullable=True),
        sa.Column("occurred_at", sa.DateTime(timezone=True), server_default=sa.text("now()"), nullable=False),
    )
    op.create_index("ix_agent_api_key_usage_logs_api_key_id", "agent_api_key_usage_logs", ["api_key_id"])
    op.create_index("ix_agent_api_key_usage_logs_org_id", "agent_api_key_usage_logs", ["org_id"])
    op.create_index(
        "ix_agent_api_key_usage_logs_key_occurred", "agent_api_key_usage_logs",
        ["api_key_id", "occurred_at"],
    )


def downgrade() -> None:
    op.drop_index("ix_agent_api_key_usage_logs_key_occurred", table_name="agent_api_key_usage_logs")
    op.drop_index("ix_agent_api_key_usage_logs_org_id", table_name="agent_api_key_usage_logs")
    op.drop_index("ix_agent_api_key_usage_logs_api_key_id", table_name="agent_api_key_usage_logs")
    op.drop_table("agent_api_key_usage_logs")
