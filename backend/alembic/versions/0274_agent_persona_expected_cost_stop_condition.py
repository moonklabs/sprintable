"""방향서 03·에이전트 속성(story #2939 슬라이스②) — 예상 비용·중단 조건 선언 필드.

PO 방향 확定: 방향서 03절 4속성 중 「예상 비용」·「중단 조건」은 1차 층=선언·가시성이지
실측 계측/자동 집행이 아니다. `system_prompt`/`style_prompt`와 동형으로 자유 텍스트
nullable 컬럼 2개만 추가 — 구조화(amount/currency/period 등)는 실제 계측 파이프라인이
붙기 전엔 선반영 낭비라 하지 않는다(설계 doc
`agent-attributes-permission-cost-stop-2939` §2/§3). 백필 불요 — NULL이 곧 정직한
"미선언" 상태.

Revision ID: 0274
Revises: 0273
Create Date: 2026-08-22
"""
from __future__ import annotations

import sqlalchemy as sa
from alembic import op

revision = "0274"
down_revision = "0273"
branch_labels = None
depends_on = None


def upgrade() -> None:
    op.add_column(
        "agent_personas", sa.Column("expected_cost_note", sa.Text(), nullable=True)
    )
    op.add_column(
        "agent_personas", sa.Column("stop_condition_note", sa.Text(), nullable=True)
    )


def downgrade() -> None:
    op.drop_column("agent_personas", "stop_condition_note")
    op.drop_column("agent_personas", "expected_cost_note")
