"""story #3953(마케팅·안전장치·블루프린트 §1-5, 페드루 PO 確定 2026-09-16) —
external_publish_pause_audit_logs 신설.

`AuditLog`(permission_audit_logs)는 `action` DB CHECK(`permission_audit_logs_
action_check` — role-변경 3값 전용)라 재사용 불가(실측). 이 코드베이스가 이미
두 번 같은 상황에서 새 전용 테이블을 택한 선례(0262_gate_github_check.py의
`gate_github_check_event`·0285_chat_command_audit_logs.py의 `chat_command_
audit_logs`)를 그대로 따른다 — 행 2종(pause·resume)뿐인 소형 테이블.

Revision ID: 0380
Revises: 0379
Create Date: 2026-09-16
"""
from __future__ import annotations

import sqlalchemy as sa
from sqlalchemy.dialects import postgresql

from alembic import op

revision = "0380"
down_revision = "0379"
branch_labels = None
depends_on = None


def upgrade() -> None:
    op.create_table(
        "external_publish_pause_audit_logs",
        sa.Column("id", postgresql.UUID(as_uuid=True), primary_key=True),
        sa.Column("org_id", postgresql.UUID(as_uuid=True), nullable=False),
        sa.Column("action", sa.Text(), nullable=False),
        sa.Column("actor_member_id", postgresql.UUID(as_uuid=True), nullable=False),
        sa.Column("reason", sa.Text(), nullable=True),
        sa.Column("created_at", sa.DateTime(timezone=True), server_default=sa.func.now(), nullable=False),
    )
    op.create_index(
        "ix_external_publish_pause_audit_logs_org_id", "external_publish_pause_audit_logs", ["org_id"],
    )
    op.create_check_constraint(
        "ck_external_publish_pause_audit_logs_action",
        "external_publish_pause_audit_logs",
        "action IN ('pause', 'resume')",
    )


def downgrade() -> None:
    op.drop_index("ix_external_publish_pause_audit_logs_org_id", table_name="external_publish_pause_audit_logs")
    op.drop_table("external_publish_pause_audit_logs")
