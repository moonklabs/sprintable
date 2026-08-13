"""story #2635 준비(P1a 승인 범위, PO 판정): role_templates.default_tool_groups 전체에
"events" 그룹 부여 — 이벤트 레지스트리 발행 표면(#2634, sprintable_publish_event/
sprintable_list_event_definitions) 개방.

Revision ID: 0246
Revises: 0245
Create Date: 2026-08-14

[[no-pr-for-data]] 게이트: role_templates 내용 변경이라 데이터 마이그레이션(0166/0167/0240
선례와 동일 규칙) — 병합 前 선생님 확認 필요. 이번 건은 P1 플랜(승인됨)의 fleet 전환 범위
내 PO 판정으로 진행하며 선생님께는 승격 보고에 얹어 통보한다(페드루군 지시, 2026-08-13) —
그래도 이 마커는 팀 관례대로 남긴다(추적성 — 다음에 이 파일을 보는 사람이 "데이터 마이그"임을
놓치지 않게).

범위: "현존 agent role_template 전부"(is_builtin/커스텀 구분 없음 — role_templates 테이블
자체가 전량 agent 채용 카탈로그, 휴먼 role(team_members.role) 과 무관한 별개 축이라 이
테이블만 건드리면 오염 걱정이 없다) — 목표가 "업무는 이벤트로"(P1a 승인 문서)인 이상 완료
보고의 주체는 특정 직무가 아니라 전 직무이므로 특정 role만 여는 안은 목표와 어긋난다(PO
판정, #3030 리뷰 스레드).

멱등: 이미 "events"를 가진 행(재실행·향후 커스텀 role_template이 미리 그 그룹을 가진 경우)은
건드리지 않는다 — `array_append` 전에 `NOT ('events' = ANY(...))` 로 걸러 중복 삽입 방지
(정확 일치, 부분문자열 아님 — [[feedback_destructive_guard_token_boundary]]와 동일 원칙:
배열 원소 완전일치라 애초에 substring 오염 위험 자체가 없다).
"""
from __future__ import annotations

import sqlalchemy as sa
from alembic import op

revision = "0246"
down_revision = "0245"
branch_labels = None
depends_on = None


def upgrade() -> None:
    bind = op.get_bind()
    bind.execute(sa.text(
        "UPDATE role_templates "
        "SET default_tool_groups = array_append(default_tool_groups, 'events') "
        "WHERE NOT ('events' = ANY(default_tool_groups))"
    ))


def downgrade() -> None:
    bind = op.get_bind()
    bind.execute(sa.text(
        "UPDATE role_templates "
        "SET default_tool_groups = array_remove(default_tool_groups, 'events')"
    ))
