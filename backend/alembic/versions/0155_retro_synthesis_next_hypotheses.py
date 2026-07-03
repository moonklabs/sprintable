"""E-SPRINT-LOOP dc861e44: retro_sessions에 synthesis/next_hypotheses nullable JSONB.

Revision ID: 0155
Revises: 0154
Create Date: 2026-07-03

L2 종합(synthesis)·L3 다음가설 추천(next_hypotheses) 캐시 컬럼. overwrite 저장
(PO 결 2026-07-03: 이력 보존 YAGNI). idempotent: 컬럼 단위 inspect 가드.
"""
from __future__ import annotations

import sqlalchemy as sa
from alembic import op
from sqlalchemy.dialects.postgresql import JSONB

revision = "0155"
down_revision = "0154"
branch_labels = None
depends_on = None


def upgrade() -> None:
    conn = op.get_bind()
    insp = sa.inspect(conn)
    cols = {c["name"] for c in insp.get_columns("retro_sessions")}

    if "synthesis" not in cols:
        op.add_column("retro_sessions", sa.Column("synthesis", JSONB, nullable=True))
    if "next_hypotheses" not in cols:
        op.add_column("retro_sessions", sa.Column("next_hypotheses", JSONB, nullable=True))


def downgrade() -> None:
    conn = op.get_bind()
    insp = sa.inspect(conn)
    cols = {c["name"] for c in insp.get_columns("retro_sessions")}

    if "next_hypotheses" in cols:
        op.drop_column("retro_sessions", "next_hypotheses")
    if "synthesis" in cols:
        op.drop_column("retro_sessions", "synthesis")
