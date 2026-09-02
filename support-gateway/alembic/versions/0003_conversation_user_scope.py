"""story #3276(지원v1·후속) — 상담 대화 사용자 단위 분리+수명주기.

Revision ID: 0003
Revises: 0002
Create Date: 2026-09-01

⚠️레거시 데이터 처분(AC4, 페드루 PO 승인 2026-09-01) — 이 마이그레이션은 기존
support_conversations 행의 external_user_id를 **backfill하지 않는다**(NULL로 남긴다).
새 조회 경로(app/routers/sessions.py)는 (org_id, external_user_id) exact match만 보므로
NULL 행은 누구의 조회에도 안 걸린다 — "봉인"(삭제는 안 함, 감사 목적 DB엔 그대로 남음).
backfill(원 생성 세션의 external_user_id로 귀속)도 검토했으나, 그러면 org당 대화가
여러 사용자에게 섞여 쌓인 오염 이력이 "원 생성자" 화면에 그대로 남는다 — 봉인이 증상
자체(선생님이 자기 위젯에서 타 계정 흔적을 본 것)를 완전히 지운다.
"""
from __future__ import annotations

from alembic import op
import sqlalchemy as sa
from sqlalchemy.dialects import postgresql

revision = "0003"
down_revision = "0002"
branch_labels = None
depends_on = None


def upgrade() -> None:
    op.add_column(
        "support_conversations",
        sa.Column("external_user_id", postgresql.UUID(as_uuid=True), nullable=True),
    )
    op.add_column(
        "support_conversations",
        sa.Column("ended_at", sa.DateTime(timezone=True), nullable=True),
    )
    op.create_index(
        "ix_support_conversations_org_user_active",
        "support_conversations",
        ["org_id", "external_user_id"],
    )


def downgrade() -> None:
    op.drop_index("ix_support_conversations_org_user_active", table_name="support_conversations")
    op.drop_column("support_conversations", "ended_at")
    op.drop_column("support_conversations", "external_user_id")
