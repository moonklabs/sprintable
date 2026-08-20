"""story #2836([결함·관측], 실사고 — 유나 세션 6시간+ 침묵·미르코 revoke 사례) — agent_auth_failure
원장 신설.

에이전트 API키 401 인증실패가 어떤 표면에도 안 뜨던 것을 매 401마다 append-only로 기록한다.
「연속 N회」 판정은 이 원장을 windowed COUNT로 읽는다(별도 카운터/서킷브레이커 테이블 없음).

Revision ID: 0266
Revises: 0265
Create Date: 2026-08-20
"""
from __future__ import annotations

import sqlalchemy as sa
from alembic import op
from sqlalchemy.dialects import postgresql

revision = "0266"
down_revision = "0265"
branch_labels = None
depends_on = None


def upgrade() -> None:
    op.create_table(
        "agent_auth_failure",
        sa.Column("id", postgresql.UUID(as_uuid=True), primary_key=True),
        sa.Column("org_id", postgresql.UUID(as_uuid=True), nullable=True),
        sa.Column("api_key_id", postgresql.UUID(as_uuid=True), nullable=True),
        sa.Column("member_id", postgresql.UUID(as_uuid=True), nullable=True),
        sa.Column("key_prefix", sa.Text(), nullable=False),
        sa.Column("reason", sa.Text(), nullable=False),
        sa.Column("occurred_at", sa.DateTime(timezone=True), server_default=sa.text("now()"), nullable=False),
        sa.CheckConstraint("reason IN ('expired', 'revoked', 'invalid')", name="ck_agent_auth_failure_reason"),
    )
    op.create_index("ix_agent_auth_failure_org_id", "agent_auth_failure", ["org_id"])
    op.create_index(
        "ix_agent_auth_failure_org_member_occurred", "agent_auth_failure",
        ["org_id", "member_id", "occurred_at"],
    )


def downgrade() -> None:
    op.drop_index("ix_agent_auth_failure_org_member_occurred", table_name="agent_auth_failure")
    op.drop_index("ix_agent_auth_failure_org_id", table_name="agent_auth_failure")
    op.drop_table("agent_auth_failure")
