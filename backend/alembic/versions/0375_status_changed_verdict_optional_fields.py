"""story #3881(customer-zero) — status/verdict slug를 렌더 시점 라벨로, 옵셔널 필드는 줄 생략.

Revision ID: 0375
Revises: 0374
Create Date: 2026-09-14

[[no-pr-for-data]] 게이트 — 프리셋 표현 콘텐츠 변경(0166/0167/0240/0249 선례와 동일 규칙,
병합 전 선생님 확認 필요할 수 있음).

배경(PO 전체 화면 리뷰 PR 4285 임베드 캡처 2026-09-14 14:27Z → 미르코 그라운딩 14:30Z,
story #3881 AC1): 0249가 심은 `preset.work.status_changed`가 `{{payload.from_status}}` →
`{{payload.to_status}}`를 원시 slug 그대로 노출(예: 「story ready-for-dev → in-progress」)
하고, `preset.gate.verdict`도 `{{payload.verdict}}`로 "approved"/"rejected" 원문을 그대로
노출했다. 둘 다 유일 실 publisher(story_status_events.py:330-335 / gate_service.py:2169-
2174)가 그 값을 원시 slug/enum 그대로 payload에 싣는 것을 실측 확認 — publisher를 바꿔
번역된 문자열을 싣는 대신(PO 확定 사유: 라벨은 읽는 사람의 로케일·org 커스텀 라벨에 달린
값이라 **발행 시점**에 문자열로 굳히면 en 사용자·커스텀 상태명에서 틀린다), FE 렌더 시점에
해석하는 `{{label.X}}` 네임스페이스(block-template.ts, story #3881)로 옮긴다.

또한 `note`(status_changed)·`resolution_note`(gate.verdict)는 그 유일 publisher 둘 다
payload에 그 키를 아예 안 실어(선택적 필드, 값이 없을 때가 정상) `⟨missing: payload.x⟩`
fail-loud 플레이스홀더가 사용자에게 그대로 노출됐다 — 두 필드에 `optional: true`를 달아
값이 없으면 그 field entry 자체가 줄 생략되게 한다(block-template.ts renderBlockTemplate의
새 처리). `preset.goal.measured`의 `metric_unit`도 같은 클래스(스키마 nullable·publisher가
항상 채우지는 않음, cron.py:580)라 같이 처방하되, 원래 text 블록 안에 인라인이라 elision
메커니즘(fields 엔트리 단위) 적용 대상이 아니었다 — 독립 fields 엔트리("단위")로 재구조화
해 같은 처방을 받게 한다(text 블록은 metric_value만 남김, 사실 무변경 — 단위 없는 수치도
여전히 유효한 측정치라 텍스트가 어색해지지 않는다).

CHANGES(페드루 PO 2026-09-14 15:26Z, AC5 캡처 리뷰 中 실측 적출) — 위와 같은 자리에
`{{payload.work_item_type}}`(status_changed, 값 예 "story")·`{{payload.gate_type}}`
(gate.verdict, 값 예 "external_publish")도 원시 slug였다(AC2 "slug 0"과 동일 클래스,
그라운딩 1차 축이 status/verdict만 보고 놓쳤다). 같은 `{{label.X}}` 경로로 옮기고,
호출부(event-block-card.tsx)는 기존 SSOT를 그대로 재사용한다(새 매핑 0) —
`entityTypeLabel()`(chat-input-entity-tokens.ts, §②-1 낱말 표와 정합)·`gateTypeLabel()`
(lib/gate-type-label.ts, dashboard 네임스페이스).

AC1 실측(코드 grep, 2026-09-14): org별 block_template 복제/자동 생성 메커니즘 0건
(organizations.py에 event_definition 관련 코드 없음 — create_organization이 이 테이블을
건드리지 않는다). 오버라이드는 PATCH(POST/PUT /api/v2/events/definitions)로 사용자가 직접
만들 때만 존재하며, list_event_definitions는 `org_id=자기 자신 OR org_id IS NULL` 둘 다
노출한다 — 즉 org-specific override 행이 실제로 존재하면 이 마이그(0249와 동일하게
`org_id IS NULL`만 갱신)가 그 조직엔 적용 안 된다. 이번 그라운딩에서 이 4개 키에 대해
실제 override 행이 존재하는지는 런타임 데이터라 코드 레벨로 확認 불가 — PO 판단 필요(후속
조치 여지, 이 마이그 범위 밖).

preset.work.assigned은 무변경(assignee_member_id는 raw UUID 노출이라 이 스토리(status
slug·옵셔널 필드) 스코프 밖 — 별도 결함 클래스, story #3881 그라운딩에서 발견만 하고
새 착수 안 함).
"""
from __future__ import annotations

import json

import sqlalchemy as sa
from alembic import op

revision = "0375"
down_revision = "0374"
branch_labels = None
depends_on = None

_TEMPLATES: dict[str, dict] = {
    "preset.work.status_changed": {
        "blocks": [
            {"type": "header", "text": "작업 상태 변경"},
            {"type": "text", "text": "**{{label.work_item_type}}** `{{label.from_status}}` → `{{label.to_status}}`"},
            {"type": "fields", "fields": [
                {"label": "대상", "value": "{{payload.work_item_id}}"},
                {"label": "메모", "value": "{{payload.note}}", "optional": True},
            ]},
        ],
    },
    "preset.gate.verdict": {
        "blocks": [
            {"type": "header", "text": "게이트 판정"},
            {"type": "text", "text": "**{{label.gate_type}}** 게이트 — **{{label.verdict}}**"},
            {"type": "fields", "fields": [
                {"label": "대상", "value": "{{payload.work_item_id}}"},
                {"label": "사유", "value": "{{payload.resolution_note}}", "optional": True},
            ]},
        ],
    },
    "preset.goal.measured": {
        "blocks": [
            {"type": "header", "text": "목표 측정치 갱신"},
            {"type": "text", "text": "측정치 **{{payload.metric_value}}**"},
            {"type": "fields", "fields": [
                {"label": "목표", "value": "{{payload.goal_id}}"},
                {"label": "단위", "value": "{{payload.metric_unit}}", "optional": True},
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
    # story #0249 시드 그대로 복원(이 마이그 적용 前 상태) — preset.work.assigned/
    # preset.goal.measured(문구는 되돌리되 metric_unit 재구조화는 0249 원형이 없었으므로
    # 원본 0249 시드 그대로) 전부 여기 재수록해 정확한 원상복구를 보장한다.
    _ORIGINAL_0249: dict[str, dict] = {
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
    for key, template in _ORIGINAL_0249.items():
        bind.execute(
            sa.text(
                "UPDATE event_definitions SET block_template = :template "
                "WHERE org_id IS NULL AND key = :key"
            ),
            {"template": json.dumps(template), "key": key},
        )
