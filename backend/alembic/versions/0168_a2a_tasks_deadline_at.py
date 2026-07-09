"""E-A2A-완성 S-A1(story 2a57dc0f) — a2a_tasks.deadline_at 컬럼.

Revision ID: 0168
Revises: 0167
Create Date: 2026-07-09

WORKING 영구정체 방지 blueprint(`a2a-completion-blueprint` Phase H). 기존 A2A_TASK_TIMEOUT_
MINUTES(30분) 판정은 GetTask 폴링 시점에만 `created_at`에서 즉석 계산하는 100% 반응형이었다
— 캐ller가 다시 폴링하지 않으면 task가 조용히 WORKING으로 남는다. 이 컬럼은 생성 시점에
명시적으로 기한을 기록해, 별도 cron 스위퍼가 폴링과 무관하게 능동적으로 판정할 수 있게 한다.

nullable(기존 행 백필 없음, 순수 additive) — 마이그 이전에 생성된 레거시 task는 NULL이며,
소비 코드(스위퍼·GetTask 양쪽)가 `deadline_at ?? created_at + A2A_TASK_TIMEOUT_MINUTES`로
폴백해 무회귀 처리한다.
"""
from __future__ import annotations

from alembic import op
import sqlalchemy as sa

revision = "0168"
down_revision = "0167"
branch_labels = None
depends_on = None


def upgrade() -> None:
    op.add_column(
        "a2a_tasks",
        sa.Column("deadline_at", sa.DateTime(timezone=True), nullable=True),
    )


def downgrade() -> None:
    op.drop_column("a2a_tasks", "deadline_at")
