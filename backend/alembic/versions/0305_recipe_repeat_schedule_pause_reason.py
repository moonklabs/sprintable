"""story c7abdf42(2026-09-02, PO 확定①) — recipe_repeat_schedules.pause_reason 컬럼 신설.

정지 그 순간의 사유("정의가 비활성화되었거나 삭제되었습니다"·"프로젝트가 삭제(archive)
되었습니다"·"정의가 더 이상 사이클형이 아닙니다"·"연속 N회 발행 실패")를 영속한다 — #3337
원판은 이 사유를 담롱 DM(휘발성)에만 실어 보내고 행엔 안 남겼다. 반복 스케줄 설정 화면이
paused 행의 사유를 보여줘야 하는데, GET 시점 재판정("지금 다시 보면 이렇다")은 조건이
나중에 바뀌면 "그때 왜 멈췄나"와 어긋난다 — 정지 시점 사실을 그대로 저장한다.

nullable=True(순수 additive) — 이 컬럼 신설 前에 이미 paused였던 구 행은 NULL(미기록)로
남는다, 지어내지 않는다.

Revision ID: 0305
Revises: 0304
Create Date: 2026-09-02
"""
from __future__ import annotations

import sqlalchemy as sa
from alembic import op

revision = "0305"
down_revision = "0304"
branch_labels = None
depends_on = None


def upgrade() -> None:
    op.add_column("recipe_repeat_schedules", sa.Column("pause_reason", sa.Text(), nullable=True))


def downgrade() -> None:
    op.drop_column("recipe_repeat_schedules", "pause_reason")
