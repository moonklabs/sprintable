"""story #2791(P0, event-workflow-unification-design-2790) — 서버 도메인 전이 자동발행 전용
시스템 발신자(TeamMember) 프로비저닝을 위한 부분 유니크 인덱스.

레코드 자체는 여기서 시드하지 않는다(org는 마이그레이션 시점 이후에도 계속 생성되므로 시드로는
전량을 못 덮는다) — `app/routers/events.py::_get_or_create_system_publisher`가 최초 자동발행
시점에 lazy get-or-create로 프로비저닝한다. 이 인덱스는 그 get-or-create의 `ON CONFLICT`
타겟이자, org당 정확히 1행만 존재함을 DB 레벨로 보장하는 동시성 가드(레이스로 2행 생성 방지).

runtime_type 컬럼(기존 "에이전트 런타임 종류" 필드, E-CHAT-CMD S1b)을 마커로 재사용 —
신규 컬럼 발명 없이 기존 필드의 자유텍스트 여유를 쓴다("system-publisher" 고정값).

Revision ID: 0258
Revises: 0257
Create Date: 2026-08-19
"""
from __future__ import annotations

import sqlalchemy as sa
from alembic import op

revision = "0258"
down_revision = "0257"
branch_labels = None
depends_on = None


def upgrade() -> None:
    op.create_index(
        "uq_team_members_org_system_publisher",
        "team_members",
        ["org_id"],
        unique=True,
        postgresql_where=sa.text("runtime_type = 'system-publisher'"),
    )


def downgrade() -> None:
    op.drop_index("uq_team_members_org_system_publisher", table_name="team_members")
