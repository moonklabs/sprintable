"""story #3337(선생님 4바퀴 실사고, 페드루 PO 설계 확定 2026-09-02) — 사이클형 레시피 정의의
반복 스케줄 테이블(recipe_repeat_schedules) 신설.

⚠️번호 의존성(임시) — story #3340(PR#3723, `0303_preset_gate_verdict_requester_field.py`)이
QA 큐 순번상 이 PR보다 먼저 머지될 예정(페드루 확定)이라 논리적으로는 0303 뒤를 잇는 게
맞다. 그런데 그 파일은 **이 브랜치엔 아직 없다**(develop에 아직 머지 前) — CI의 "Alembic
upgrade head" 가 존재하지 않는 down_revision을 못 찾아 그대로는 fail한다(실측 확認, 이 PR
자체에서). 그래서 지금은 이 브랜치의 실제 최신(0302)을 가리키게 임시로 둔다 — **#3340이
먼저 머지되면 이 PR을 origin/develop 위로 rebase하며 down_revision을 0303으로, revision
번호가 그때 다른 PR과 또 겹치면 그 시점의 실제 head+1로 재정렬**한다(병합 전 마지막 단계,
페드루 확定). 데이터 충돌 없음(둘 다 순수 additive).

Revision ID: 0304
Revises: 0302
Create Date: 2026-09-02
"""
from __future__ import annotations

import sqlalchemy as sa
from alembic import op
from sqlalchemy.dialects import postgresql

revision = "0304"
down_revision = "0302"
branch_labels = None
depends_on = None


def upgrade() -> None:
    op.create_table(
        "recipe_repeat_schedules",
        sa.Column("id", postgresql.UUID(as_uuid=True), primary_key=True),
        sa.Column("org_id", postgresql.UUID(as_uuid=True), nullable=False),
        sa.Column("project_id", postgresql.UUID(as_uuid=True), nullable=False),
        sa.Column("definition_key", sa.Text(), nullable=False),
        sa.Column("work_item_type", sa.Text(), nullable=False),
        sa.Column("anchor_time", sa.DateTime(timezone=True), nullable=False),
        sa.Column("next_run_at", sa.DateTime(timezone=True), nullable=False),
        sa.Column("repeat", sa.Text(), nullable=False),
        sa.Column("last_payload_snapshot", postgresql.JSONB(astext_type=sa.Text()), nullable=False, server_default="{}"),
        sa.Column("consecutive_failure_count", sa.Integer(), nullable=False, server_default="0"),
        sa.Column("status", sa.Text(), nullable=False, server_default="active"),
        sa.Column("last_run_at", sa.DateTime(timezone=True), nullable=True),
        sa.Column("last_story_id", postgresql.UUID(as_uuid=True), nullable=True),
        sa.Column("created_at", sa.DateTime(timezone=True), server_default=sa.text("now()"), nullable=False),
        sa.Column("updated_at", sa.DateTime(timezone=True), server_default=sa.text("now()"), nullable=False),
        sa.UniqueConstraint("org_id", "project_id", "definition_key", name="uq_recipe_repeat_schedule_definition"),
    )
    op.create_index("ix_recipe_repeat_schedules_org_id", "recipe_repeat_schedules", ["org_id"])
    op.create_index("ix_recipe_repeat_schedules_project_id", "recipe_repeat_schedules", ["project_id"])
    # tick 배치 쿼리의 유일한 스캔 축(status='active' AND next_run_at<=now()) — 부분 인덱스로
    # paused 행을 아예 안 훑는다.
    op.create_index(
        "ix_recipe_repeat_schedules_next_run_at_active",
        "recipe_repeat_schedules", ["next_run_at"],
        postgresql_where=sa.text("status = 'active'"),
    )


def downgrade() -> None:
    op.drop_index("ix_recipe_repeat_schedules_next_run_at_active", table_name="recipe_repeat_schedules")
    op.drop_index("ix_recipe_repeat_schedules_project_id", table_name="recipe_repeat_schedules")
    op.drop_index("ix_recipe_repeat_schedules_org_id", table_name="recipe_repeat_schedules")
    op.drop_table("recipe_repeat_schedules")
