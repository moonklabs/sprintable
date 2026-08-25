"""story #2254(그라운딩 doc e5bc0789, 2026-08-25) — 스토리 본문 덧붙이기·되돌리기.

description/acceptance_criteria 통째 교체로 조사 기록을 잃는 실사고(디디 자진 보고,
2026-07-28)의 남은 갭 — append 능력(원자적 이어붙이기)과 직전 값 1-depth 되돌리기.
shrink-guard(#2346)·낙관적 동시성(#2868)은 이미 있어 이번엔 이 컬럼 2개만 추가.

nullable — 기존 row는 previous_*가 없는 게 정상(과거 이력을 소급 생성하지 않음).

Revision ID: 0281
Revises: 0280
Create Date: 2026-08-25
"""
from __future__ import annotations

import sqlalchemy as sa
from alembic import op

revision = "0281"
down_revision = "0280"
branch_labels = None
depends_on = None


def upgrade() -> None:
    op.add_column("stories", sa.Column("previous_description", sa.Text(), nullable=True))
    op.add_column("stories", sa.Column("previous_acceptance_criteria", sa.Text(), nullable=True))


def downgrade() -> None:
    op.drop_column("stories", "previous_acceptance_criteria")
    op.drop_column("stories", "previous_description")
