"""story #2630: chain_circuit_breaker + chain_escalation_org_config 서킷브레이커 설정.

Revision ID: 0244
Revises: 0243
Create Date: 2026-08-13

#2626 org 설정(chain_escalation_org_config)에 circuit_breaker_mode/circuit_breaker_release_mode
2컬럼 추가 + 신규 chain_circuit_breaker 테이블(대화당 open 행 최대 1개, 부분 unique index).
"""
from __future__ import annotations

import sqlalchemy as sa
from alembic import op
from sqlalchemy.dialects.postgresql import UUID

revision = "0244"
down_revision = "0243"
branch_labels = None
depends_on = None


def upgrade() -> None:
    op.add_column(
        "chain_escalation_org_config",
        sa.Column("circuit_breaker_mode", sa.Text(), nullable=False, server_default="block"),
    )
    op.add_column(
        "chain_escalation_org_config",
        sa.Column("circuit_breaker_release_mode", sa.Text(), nullable=False, server_default="manual"),
    )
    op.create_check_constraint(
        "ck_chain_escalation_org_config_circuit_breaker_mode",
        "chain_escalation_org_config",
        "circuit_breaker_mode IN ('block', 'notify_only')",
    )
    op.create_check_constraint(
        "ck_chain_escalation_org_config_circuit_breaker_release_mode",
        "chain_escalation_org_config",
        "circuit_breaker_release_mode IN ('manual', 'auto')",
    )

    op.create_table(
        "chain_circuit_breaker",
        sa.Column("id", UUID(as_uuid=True), primary_key=True),
        sa.Column("org_id", UUID(as_uuid=True), nullable=False),
        sa.Column("conversation_id", UUID(as_uuid=True), nullable=False),
        sa.Column("project_id", UUID(as_uuid=True), nullable=True),
        sa.Column("opened_at", sa.DateTime(timezone=True), server_default=sa.text("now()"), nullable=False),
        sa.Column("released_at", sa.DateTime(timezone=True), nullable=True),
        sa.Column("released_by", UUID(as_uuid=True), nullable=True),
        sa.Column("release_reason", sa.Text(), nullable=True),
    )
    op.create_index("ix_chain_circuit_breaker_org_id", "chain_circuit_breaker", ["org_id"])
    op.create_index("ix_chain_circuit_breaker_conversation_id", "chain_circuit_breaker", ["conversation_id"])
    op.create_index(
        "uq_chain_circuit_breaker_open_conversation",
        "chain_circuit_breaker",
        ["conversation_id"],
        unique=True,
        postgresql_where=sa.text("released_at IS NULL"),
    )


def downgrade() -> None:
    op.drop_index("uq_chain_circuit_breaker_open_conversation", table_name="chain_circuit_breaker")
    op.drop_index("ix_chain_circuit_breaker_conversation_id", table_name="chain_circuit_breaker")
    op.drop_index("ix_chain_circuit_breaker_org_id", table_name="chain_circuit_breaker")
    op.drop_table("chain_circuit_breaker")

    op.drop_constraint(
        "ck_chain_escalation_org_config_circuit_breaker_release_mode",
        "chain_escalation_org_config",
        type_="check",
    )
    op.drop_constraint(
        "ck_chain_escalation_org_config_circuit_breaker_mode",
        "chain_escalation_org_config",
        type_="check",
    )
    op.drop_column("chain_escalation_org_config", "circuit_breaker_release_mode")
    op.drop_column("chain_escalation_org_config", "circuit_breaker_mode")
