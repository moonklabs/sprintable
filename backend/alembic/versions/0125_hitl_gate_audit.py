"""E-HITL-GATING S-GATE-5.1: hitl_gate_audit 테이블 — enforce_gate 1건당 audit 1행.

coverage("전이 중 게이트 친 비율")·auto-pass 카운트가 DB 불가이던 한계 해소(auto/block 미persist 였음).
additive 신규 테이블(prod-safe). flag-gated(enforce active) 시에만 write.

Revision ID: 0125
Revises: 0124
"""
import sqlalchemy as sa
from sqlalchemy.dialects.postgresql import UUID

from alembic import op

revision = "0125"
down_revision = "0124"
branch_labels = None
depends_on = None


def upgrade() -> None:
    op.create_table(
        "hitl_gate_audit",
        sa.Column("id", UUID(as_uuid=True), primary_key=True, server_default=sa.text("gen_random_uuid()")),
        sa.Column("org_id", UUID(as_uuid=True), nullable=False),
        sa.Column("project_id", UUID(as_uuid=True), nullable=True),
        sa.Column("work_type", sa.Text(), nullable=False),
        sa.Column("actor_type", sa.Text(), nullable=True),
        sa.Column("resolved_level", sa.Text(), nullable=False),
        sa.Column("outcome", sa.Text(), nullable=False),
        sa.Column("work_item_id", UUID(as_uuid=True), nullable=False),
        sa.Column("actor_id", UUID(as_uuid=True), nullable=True),
        sa.Column("created_at", sa.DateTime(timezone=True), server_default=sa.text("now()"), nullable=False),
    )
    # 메트릭 쿼리: org 스코프 + created_at window(+project filter).
    op.create_index("ix_hitl_gate_audit_org_created", "hitl_gate_audit", ["org_id", "created_at"])


def downgrade() -> None:
    op.drop_index("ix_hitl_gate_audit_org_created", table_name="hitl_gate_audit")
    op.drop_table("hitl_gate_audit")
