"""gate.resolution_note 컬럼 추가 (반려 사유 영속화).

Revision ID: 0068
Revises: 0067
Create Date: 2026-06-01
"""
from __future__ import annotations

import sqlalchemy as sa
from alembic import op

revision = "0068"
down_revision = "0067"
branch_labels = None
depends_on = None


def upgrade() -> None:
    conn = op.get_bind()
    insp = sa.inspect(conn)
    cols = {c["name"] for c in insp.get_columns("gate")}
    if "resolution_note" not in cols:
        op.add_column("gate", sa.Column("resolution_note", sa.Text, nullable=True))


def downgrade() -> None:
    conn = op.get_bind()
    insp = sa.inspect(conn)
    cols = {c["name"] for c in insp.get_columns("gate")}
    if "resolution_note" in cols:
        op.drop_column("gate", "resolution_note")
