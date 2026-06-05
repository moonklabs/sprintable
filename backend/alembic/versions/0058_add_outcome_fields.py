"""E-OUTCOME-LOOP S1: stories·sprints에 outcome 필드 추가.

Revision ID: 0058
Revises: 0057
Create Date: 2026-05-30
"""
from __future__ import annotations

import sqlalchemy as sa
from alembic import op
from sqlalchemy.dialects.postgresql import JSONB

revision = "0058"
down_revision = "0057"
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
    """컬럼이 이미 존재하면 무시 — dev 환경 idempotent (0056·0057 패턴)."""
    conn = op.get_bind()
    insp = sa.inspect(conn)
    existing = {c["name"] for c in insp.get_columns(table)}
    for col_name, col_type, kwargs in _OUTCOME_COLS:
        if col_name not in existing:
            op.add_column(table, sa.Column(col_name, col_type, **kwargs))


def upgrade() -> None:
    _add_cols_idempotent("stories")
    _add_cols_idempotent("sprints")


def downgrade() -> None:
    for col_name, _, _ in reversed(_OUTCOME_COLS):
        op.drop_column("sprints", col_name)
        op.drop_column("stories", col_name)
