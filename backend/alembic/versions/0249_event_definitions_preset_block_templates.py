"""story #2637 §범위5(0-b 준용) — 프리셋 4종에 기본 block_template 시드.

Revision ID: 0249
Revises: 0248
Create Date: 2026-08-14

[[no-pr-for-data]] 게이트 — 프리셋 표현 콘텐츠 변경(0166/0167/0240 선례와 동일 규칙, 병합 전
선생님 확認 필요할 수 있음).

doc event-registry-p2-block-template-detail의 0-b 예시(preset.work.status_changed)를
그대로 쓰고, 나머지 3종은 그 예시의 header/text/fields 패턴을 각 프리셋의 실 payload_schema
필드(0245 시드 참조)에 맞춰 동형으로 짓는다 — "현행 제네릭보다 읽기 좋은 최소형"(스토리
범위5 문구). actions 블록은 이번엔 안 심는다 — 0-b 예시의 actions.definition_key가
"<발행할 key>" 플레이스홀더였고(실 값 미확定), 실제 발행 대상 없는 액션 버튼을 시드하면
"눌러도 뭘 하는지 모르는 버튼"이 되는 게 더 나쁘다(story #2637 §범위4 "결재 카드 이관"이
실제 액션 버튼을 갖는 첫 케이스 — 그건 별도 축, 이 마이그 범위 밖).

치환 실패 시 명시 플레이스홀더(`⟨missing: payload.x⟩`)는 렌더러(FE, #2637)의 몫이라 여기
시드 콘텐츠 자체엔 없다 — 이 마이그는 템플릿 구조만 심는다.
"""
from __future__ import annotations

import json

import sqlalchemy as sa
from alembic import op

revision = "0249"
down_revision = "0248"
branch_labels = None
depends_on = None

_TEMPLATES: dict[str, dict] = {
    "preset.gate.verdict": {
        "blocks": [
            {"type": "header", "text": "게이트 판정"},
            {"type": "text", "text": "**{{payload.gate_type}}** 게이트 — **{{payload.verdict}}**"},
            {"type": "fields", "fields": [
                {"label": "대상", "value": "{{payload.work_item_id}}"},
                {"label": "사유", "value": "{{payload.resolution_note}}"},
            ]},
        ],
    },
    "preset.work.status_changed": {
        "blocks": [
            {"type": "header", "text": "작업 상태 변경"},
            {"type": "text", "text": "**{{payload.work_item_type}}** `{{payload.from_status}}` → `{{payload.to_status}}`"},
            {"type": "fields", "fields": [
                {"label": "대상", "value": "{{payload.work_item_id}}"},
                {"label": "메모", "value": "{{payload.note}}"},
            ]},
        ],
    },
    "preset.work.assigned": {
        "blocks": [
            {"type": "header", "text": "작업 배정"},
            {"type": "text", "text": "**{{payload.work_item_type}}** 이(가) 배정되었습니다."},
            {"type": "fields", "fields": [
                {"label": "대상", "value": "{{payload.work_item_id}}"},
                {"label": "담당자", "value": "{{payload.assignee_member_id}}"},
            ]},
        ],
    },
    "preset.goal.measured": {
        "blocks": [
            {"type": "header", "text": "목표 측정치 갱신"},
            {"type": "text", "text": "측정치 **{{payload.metric_value}}** {{payload.metric_unit}}"},
            {"type": "fields", "fields": [
                {"label": "목표", "value": "{{payload.goal_id}}"},
                {"label": "출처", "value": "{{payload.source}}"},
            ]},
        ],
    },
}


def upgrade() -> None:
    bind = op.get_bind()
    for key, template in _TEMPLATES.items():
        bind.execute(
            sa.text(
                "UPDATE event_definitions SET block_template = :template "
                "WHERE org_id IS NULL AND key = :key"
            ),
            {"template": json.dumps(template), "key": key},
        )


def downgrade() -> None:
    bind = op.get_bind()
    for key in _TEMPLATES:
        bind.execute(
            sa.text(
                "UPDATE event_definitions SET block_template = NULL "
                "WHERE org_id IS NULL AND key = :key"
            ),
            {"key": key},
        )
