"""story #2791(P0, event-workflow-unification-design-2790) — 서버 도메인 전이 자동발행 전용
시스템 발신자(Member) 프로비저닝을 위한 부분 유니크 인덱스.

⛔초판 실수(2026-08-19, CI realdb로 즉시 발각) — `team_members`를 대상으로 인덱스를 만들려
했으나 `team_members`는 0088+에서 `members`/`project_access`/`agent_project_profiles` 위
3-way UNION ALL **VIEW**로 전환된 지 오래라(0110이 최신 정의) 인덱스는커녕 직접 INSERT도
안 되는 대상이다("cannot create index on relation ... This operation is not supported for
views" — CI Alembic 잡이 실측으로 잡아냄). 실제 anchor 테이블 `members`를 대상으로 정정.

레코드 자체는 여기서 시드하지 않는다(org는 마이그레이션 시점 이후에도 계속 생성되므로 시드로는
전량을 못 덮는다) — `app/routers/events.py::_get_or_create_system_publisher`가 최초 자동발행
시점에 lazy get-or-create로 프로비저닝한다(`members` 행 + `project_access` grant 1건).

마커는 `members.handle`(구 에이전트 @멘션 핸들 — story #2646이 완전히 은퇴시킨 죽은 필드,
"이제 아무 코드도 안 쓴다") 재사용 — `runtime_type`(9종 enum, agent_runtime capability
registry의 실 조회 키)을 마커로 쓰면 그 조회 로직과 충돌할 위험이 있어 피한다.

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
        "uq_members_org_system_publisher",
        "members",
        ["org_id"],
        unique=True,
        postgresql_where=sa.text("handle = 'system-publisher' AND type = 'agent'"),
    )


def downgrade() -> None:
    op.drop_index("uq_members_org_system_publisher", table_name="members")
