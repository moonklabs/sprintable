"""E-CAGE-REFEREE P3: gate 1급 객체 테이블.

Revision ID: 0067
Revises: 0066
Create Date: 2026-05-31

neutral_facts: 관찰값(touches_migration·diff_size 등) — 판정 아님.
상태기계: pending|approved|rejected|auto_passed.
"""
from __future__ import annotations

import sqlalchemy as sa
from alembic import op
from sqlalchemy.dialects.postgresql import JSONB, UUID

revision = "0067"
down_revision = "0066"
branch_labels = None
depends_on = None


def upgrade() -> None:
    conn = op.get_bind()
    insp = sa.inspect(conn)
    if "gate" in insp.get_table_names():
        return

    op.create_table(
        "gate",
        sa.Column("id", UUID(as_uuid=True), primary_key=True),
        sa.Column("org_id", UUID(as_uuid=True), nullable=False),
        sa.Column("work_item_id", UUID(as_uuid=True), nullable=False),
        sa.Column("work_item_type", sa.String(20), nullable=False),
        sa.Column("gate_type", sa.String(50), nullable=False),
        sa.Column("status", sa.String(20), nullable=False, server_default="pending"),
        sa.Column("resolver_id", UUID(as_uuid=True), nullable=True),
        sa.Column("resolved_at", sa.DateTime(timezone=True), nullable=True),
        sa.Column("neutral_facts", JSONB, nullable=True),
        sa.Column(
            "created_at",
            sa.DateTime(timezone=True),
            server_default=sa.func.now(),
            nullable=False,
        ),
        sa.Column(
            "updated_at",
            sa.DateTime(timezone=True),
            server_default=sa.func.now(),
            nullable=False,
        ),
    )
    op.create_index("ix_gate_org_id", "gate", ["org_id"])
    op.create_index("ix_gate_work_item_id", "gate", ["work_item_id"])
    op.create_unique_constraint(
        "uq_gate_work_item_gate_type",
        "gate",
        ["org_id", "work_item_id", "work_item_type", "gate_type"],
    )


def downgrade() -> None:
    conn = op.get_bind()
    insp = sa.inspect(conn)
    if "gate" not in insp.get_table_names():
        return
    op.drop_constraint("uq_gate_work_item_gate_type", "gate", type_="unique")
    op.drop_index("ix_gate_work_item_id", table_name="gate")
    op.drop_index("ix_gate_org_id", table_name="gate")
    op.drop_table("gate")
