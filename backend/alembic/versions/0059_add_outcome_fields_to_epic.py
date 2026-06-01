"""E-BOARD-SCHEMA S1: epics에 outcome 필드 추가.

Revision ID: 0059
Revises: 0058
Create Date: 2026-05-31
"""
from __future__ import annotations

import sqlalchemy as sa
from alembic import op
from sqlalchemy.dialects.postgresql import JSONB

revision = "0059"
down_revision = "0058"
branch_labels = None
depends_on = None

_OUTCOME_COLS = [
    ("success_hypothesis", sa.Text, {"nullable": True}),
    ("metric_definition", JSONB, {"nullable": True}),
    ("measure_after", sa.DateTime(timezone=True), {"nullable": True}),
    ("outcome_status", sa.String(20), {"nullable": False, "server_default": "n_a"}),
    ("outcome_result", JSONB, {"nullable": True}),
]


def _add_cols_idempotent(table: str) -> None:
    """컬럼이 이미 존재하면 무시 — dev 환경 idempotent."""
    conn = op.get_bind()
    insp = sa.inspect(conn)
    existing = {c["name"] for c in insp.get_columns(table)}
    for col_name, col_type, kwargs in _OUTCOME_COLS:
        if col_name not in existing:
            op.add_column(table, sa.Column(col_name, col_type, **kwargs))


def upgrade() -> None:
    _add_cols_idempotent("epics")


def downgrade() -> None:
    for col_name, _, _ in reversed(_OUTCOME_COLS):
        op.drop_column("epics", col_name)
