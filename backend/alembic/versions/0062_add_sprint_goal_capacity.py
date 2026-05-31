"""E-BOARD-SCHEMA S4: Sprint에 goal·capacity 필드 추가.

Revision ID: 0062
Revises: 0061
Create Date: 2026-05-31

goal     = 실행 목표 ("무엇을 한다") — success_hypothesis(효과 가설)와 별개
capacity = 가용 공수(SP) — team_size(인원수)와 별개
"""
from __future__ import annotations

import sqlalchemy as sa
from alembic import op

revision = "0062"
down_revision = "0061"
branch_labels = None
depends_on = None

_COLS = [
    ("goal", sa.Text, {"nullable": True}),
    ("capacity", sa.Integer, {"nullable": True}),
]


def _add_idempotent(table: str) -> None:
    conn = op.get_bind()
    insp = sa.inspect(conn)
    existing = {c["name"] for c in insp.get_columns(table)}
    for col_name, col_type, kwargs in _COLS:
        if col_name not in existing:
            op.add_column(table, sa.Column(col_name, col_type, **kwargs))


def upgrade() -> None:
    _add_idempotent("sprints")


def downgrade() -> None:
    for col_name, _, _ in reversed(_COLS):
        op.drop_column("sprints", col_name)
