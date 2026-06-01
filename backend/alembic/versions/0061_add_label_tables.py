"""E-BOARD-SCHEMA S3: label + item_label 테이블 생성 (3계층 labels/tags).

Revision ID: 0061
Revises: 0060
Create Date: 2026-05-31
"""
from __future__ import annotations

import sqlalchemy as sa
from alembic import op
from sqlalchemy.dialects.postgresql import UUID

revision = "0061"
down_revision = "0060"
branch_labels = None
depends_on = None


def upgrade() -> None:
    conn = op.get_bind()
    insp = sa.inspect(conn)
    existing = insp.get_table_names()

    if "label" not in existing:
        op.create_table(
            "label",
            sa.Column("id", UUID(as_uuid=True), primary_key=True),
            sa.Column("org_id", UUID(as_uuid=True), nullable=False),
            sa.Column("name", sa.Text(), nullable=False),
            sa.Column("color", sa.String(20), nullable=True),
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
        op.create_index("ix_label_org_id", "label", ["org_id"])
        op.create_unique_constraint("uq_label_org_name", "label", ["org_id", "name"])

    if "item_label" not in existing:
        op.create_table(
            "item_label",
            sa.Column("id", UUID(as_uuid=True), primary_key=True),
            sa.Column("org_id", UUID(as_uuid=True), nullable=False),
            sa.Column("label_id", UUID(as_uuid=True), nullable=False),
            sa.Column("item_id", UUID(as_uuid=True), nullable=False),
            sa.Column("item_type", sa.String(20), nullable=False),
            sa.Column(
                "created_at",
                sa.DateTime(timezone=True),
                server_default=sa.func.now(),
                nullable=False,
            ),
        )
        op.create_index("ix_item_label_org_id", "item_label", ["org_id"])
        op.create_index("ix_item_label_label_id", "item_label", ["label_id"])
        op.create_index("ix_item_label_item_id", "item_label", ["item_id"])
        op.create_unique_constraint(
            "uq_item_label_edge",
            "item_label",
            ["org_id", "label_id", "item_id", "item_type"],
        )


def downgrade() -> None:
    op.drop_constraint("uq_item_label_edge", "item_label", type_="unique")
    op.drop_index("ix_item_label_item_id", table_name="item_label")
    op.drop_index("ix_item_label_label_id", table_name="item_label")
    op.drop_index("ix_item_label_org_id", table_name="item_label")
    op.drop_table("item_label")

    op.drop_constraint("uq_label_org_name", "label", type_="unique")
    op.drop_index("ix_label_org_id", table_name="label")
    op.drop_table("label")
