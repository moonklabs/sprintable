"""E-BOARD-SCHEMA S2: item_dependency 테이블 생성 (3계층 의존성 구조).

Revision ID: 0060
Revises: 0059
Create Date: 2026-05-31
"""
from __future__ import annotations

import sqlalchemy as sa
from alembic import op
from sqlalchemy.dialects.postgresql import UUID

revision = "0060"
down_revision = "0059"
branch_labels = None
depends_on = None


def upgrade() -> None:
    conn = op.get_bind()
    insp = sa.inspect(conn)
    if "item_dependency" in insp.get_table_names():
        return  # idempotent — 이미 존재하면 무시

    op.create_table(
        "item_dependency",
        sa.Column("id", UUID(as_uuid=True), primary_key=True),
        sa.Column("org_id", UUID(as_uuid=True), nullable=False),
        sa.Column("from_id", UUID(as_uuid=True), nullable=False),
        sa.Column("to_id", UUID(as_uuid=True), nullable=False),
        sa.Column("dep_type", sa.String(20), nullable=False),
        sa.Column("item_type", sa.String(20), nullable=False),
        sa.Column(
            "created_at",
            sa.DateTime(timezone=True),
            server_default=sa.func.now(),
            nullable=False,
        ),
    )
    op.create_index("ix_item_dependency_org_id", "item_dependency", ["org_id"])
    op.create_index("ix_item_dependency_from_id", "item_dependency", ["from_id"])
    op.create_index("ix_item_dependency_to_id", "item_dependency", ["to_id"])
    op.create_unique_constraint(
        "uq_item_dependency_edge",
        "item_dependency",
        ["org_id", "from_id", "to_id", "item_type"],
    )


def downgrade() -> None:
    op.drop_constraint("uq_item_dependency_edge", "item_dependency", type_="unique")
    op.drop_index("ix_item_dependency_to_id", table_name="item_dependency")
    op.drop_index("ix_item_dependency_from_id", table_name="item_dependency")
    op.drop_index("ix_item_dependency_org_id", table_name="item_dependency")
    op.drop_table("item_dependency")
