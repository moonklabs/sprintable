"""E-A2A-POC S1 (story 480e81fb): a2a_tasks — A2A Task 생명주기 저장소.

Revision ID: 0158
Revises: 0157
Create Date: 2026-07-06

PoC 스코프 — org_id/인증 컬럼 없음(member_id로만 스코프). Phase 3서 org-scope+인증 추가 시
컬럼 보강 예정(현재는 substrate 실증이 목적, 별도 SSOT 아님 — role_template/team_members가
능력 SSOT이고 이 테이블은 순수 task 생명주기 상태만 보관).
"""
from __future__ import annotations

from alembic import op
import sqlalchemy as sa
from sqlalchemy.dialects import postgresql

revision = "0158"
down_revision = "0157"
branch_labels = None
depends_on = None


def upgrade() -> None:
    op.create_table(
        "a2a_tasks",
        sa.Column("id", postgresql.UUID(as_uuid=True), primary_key=True),
        sa.Column("context_id", postgresql.UUID(as_uuid=True), nullable=False),
        sa.Column("member_id", postgresql.UUID(as_uuid=True), nullable=False),
        sa.Column("state", sa.Text(), nullable=False, server_default="TASK_STATE_SUBMITTED"),
        sa.Column("history", postgresql.JSONB(), nullable=False, server_default="[]"),
        sa.Column("artifacts", postgresql.JSONB(), nullable=False, server_default="[]"),
        sa.Column("task_metadata", postgresql.JSONB(), nullable=True),
        sa.Column("created_at", sa.DateTime(timezone=True), nullable=False, server_default=sa.func.now()),
        sa.Column("updated_at", sa.DateTime(timezone=True), nullable=False, server_default=sa.func.now()),
    )
    op.create_index("ix_a2a_tasks_member_id", "a2a_tasks", ["member_id"])


def downgrade() -> None:
    op.drop_index("ix_a2a_tasks_member_id", table_name="a2a_tasks")
    op.drop_table("a2a_tasks")
