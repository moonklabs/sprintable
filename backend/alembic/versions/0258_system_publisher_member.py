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

마커는 `members.runtime_type`(에이전트 런타임 종류, 9종 enum이지만 `get_runtime_capability`가
None/빈문자열/미등록 문자열 전부 UNSUPPORTED_CAPABILITY로 안전 처리 — app/services/
agent_runtime.py 확인) 재사용 — `"system-publisher"`는 그 9종 어디에도 안 걸려 항상
UNSUPPORTED로 떨어질 뿐 예외를 안 낸다. `team_members` 뷰가 이 컬럼을 그대로 투영해
`send_message()`(conversations.py) 등 뷰 기반 호출부가 이 값을 직접 읽을 수 있다는 것이
핵심 — 2026-08-19 재QA(카디르)에서 이 마커가 실제로 필요해짐(system 발신자에게 org-wide
presence 방출을 스킵시키는 조건 분기의 판별 키).

⚠️초판(2026-08-19 최초 커밋)은 `members.handle`(구 에이전트 @멘션 핸들, 죽은 필드)을 마커로
썼으나 — `team_members` 뷰가 `handle`을 투영하지 않아 `send_message()` 등 뷰 기반 호출부에서
읽을 수 없다는 것이 재QA 중 드러나 `runtime_type`으로 정정.

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
        postgresql_where=sa.text("runtime_type = 'system-publisher' AND type = 'agent'"),
    )


def downgrade() -> None:
    op.drop_index("uq_members_org_system_publisher", table_name="members")
