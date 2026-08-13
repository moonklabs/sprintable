"""story #2626: chain_escalation_org_config — 무감독 연쇄 알림 org 설정 표면.

Revision ID: 0243
Revises: 0242
Create Date: 2026-08-13

org_gate_policy(0066)와 동형 패턴 — org당 1행, 없으면 코드 기본값(300s/15건) 폴백.
"""
from __future__ import annotations

import sqlalchemy as sa
from alembic import op
from sqlalchemy.dialects.postgresql import UUID

revision = "0243"
down_revision = "0242"
branch_labels = None
depends_on = None


def upgrade() -> None:
    op.create_table(
        "chain_escalation_org_config",
        sa.Column("id", UUID(as_uuid=True), primary_key=True),
        sa.Column("org_id", UUID(as_uuid=True), nullable=False, unique=True),
        sa.Column("enabled", sa.Boolean(), nullable=False, server_default="true"),
        sa.Column("window_seconds", sa.Integer(), nullable=False, server_default="300"),
        sa.Column("threshold", sa.Integer(), nullable=False, server_default="15"),
        sa.Column(
            "created_at", sa.DateTime(timezone=True), server_default=sa.func.now(), nullable=False
        ),
        sa.Column(
            "updated_at", sa.DateTime(timezone=True), server_default=sa.func.now(), nullable=False
        ),
    )
    op.create_index(
        "ix_chain_escalation_org_config_org_id", "chain_escalation_org_config", ["org_id"],
    )


def downgrade() -> None:
    op.drop_index("ix_chain_escalation_org_config_org_id", table_name="chain_escalation_org_config")
    op.drop_table("chain_escalation_org_config")
