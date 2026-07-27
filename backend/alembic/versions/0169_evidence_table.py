"""E-VERIFY V0-S1(story 5a5ba27b): evidence 테이블 — 에이전트 자기증명 1급 객체.

Revision ID: 0169
Revises: 0168
Create Date: 2026-07-10

Gate(0075/0110류)와 동형 polymorphic 패턴 — work_item_id/work_item_type에 FK 없음(Story/Task
양쪽 커버, 신규 domain 확장도 마이그 불요). 순수 additive 신규 테이블 — 기존 스키마 무회귀.
"""
from __future__ import annotations

from alembic import op
import sqlalchemy as sa
from sqlalchemy.dialects import postgresql

revision = "0169"
down_revision = "0168"
branch_labels = None
depends_on = None


def upgrade() -> None:
    op.create_table(
        "evidence",
        sa.Column("id", postgresql.UUID(as_uuid=True), primary_key=True),
        sa.Column("org_id", postgresql.UUID(as_uuid=True), nullable=False),
        sa.Column("work_item_id", postgresql.UUID(as_uuid=True), nullable=False),
        sa.Column("work_item_type", sa.String(length=20), nullable=False),
        sa.Column("type", sa.String(length=20), nullable=False),
        sa.Column("ref", sa.Text(), nullable=False),
        sa.Column("source", sa.Text(), nullable=True),
        sa.Column("note", sa.Text(), nullable=True),
        sa.Column("created_by", postgresql.UUID(as_uuid=True), nullable=False),
        sa.Column("created_at", sa.DateTime(timezone=True), server_default=sa.text("now()"), nullable=False),
    )
    op.create_index("ix_evidence_org_id", "evidence", ["org_id"])
    op.create_index("ix_evidence_work_item_id", "evidence", ["work_item_id"])
    op.create_index("ix_evidence_work_item_lookup", "evidence", ["work_item_id", "work_item_type"])
    op.create_check_constraint(
        "ck_evidence_type",
        "evidence",
        "type IN ('url','file','pr','deploy','metric','report','gate_approval')",
    )
    op.create_check_constraint(
        "ck_evidence_work_item_type",
        "evidence",
        "work_item_type IN ('story','task')",
    )


def downgrade() -> None:
    op.drop_table("evidence")
