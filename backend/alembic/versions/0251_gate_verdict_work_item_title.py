"""story #2637 AC4 후속(페드루 지시, 2026-08-14) — preset.gate.verdict 정정 2건.

Revision ID: 0251
Revises: 0250
Create Date: 2026-08-14

[[no-pr-for-data]] 게이트 — 프리셋 표현 콘텐츠 변경(0166/0167/0240/0249 선례와 동일 규칙,
병합 전 선생님 확認 필요할 수 있음).

정정 근거(페드루, 2026-08-14): 0249 시드의 block_template이 결재 카드 실물 대조 없이
만들어진 얕은 원본이었다 — 실 승인 카드는 work_item의 **title**을 그리는데(UUID를 그대로
보여주지 않는다), 0249는 "대상" 필드 value를 `{{payload.work_item_id}}`로 심었다. 이
정의(preset.gate.verdict)는 아직 발행처 0건(backend/app 전체에 publish 호출 없음, 페드루
실측)이라 계약을 공짜로 고칠 수 있는 지금이 적기다.

두 가지를 한 UPDATE로 묶는다(PATCH /api/v2/events/definitions의 version 범프 규율과
동형 — 여러 필드가 한 논리적 변경에 같이 바뀌어도 version은 1만 오른다, `content_changed`
불리언 하나가 payload_schema/routing/block_template/action_auth 전체를 대표하는 events.py
::update_event_definition 패턴 그대로):
1. block_template.fields[0]("대상") value: `{{payload.work_item_id}}` →
   `{{payload.work_item_title}}`.
2. payload_schema.properties에 `work_item_title` 추가(additive) — **required엔 안 넣는다**.
   발행처가 아직 없어 강제할 실 데이터가 없고, 치환 실패는 FE의 `⟨missing: payload.x⟩`
   플레이스홀더(apps/web/src/lib/block-template.ts::substituteMustache, #3038)가 정직하게
   드러내므로 여기서 required로 조기 강제할 필요가 없다.
"""
from __future__ import annotations

import json

import sqlalchemy as sa
from alembic import op

revision = "0251"
down_revision = "0250"
branch_labels = None
depends_on = None

_KEY = "preset.gate.verdict"

_OLD_BLOCK_TEMPLATE = {
    "blocks": [
        {"type": "header", "text": "게이트 판정"},
        {"type": "text", "text": "**{{payload.gate_type}}** 게이트 — **{{payload.verdict}}**"},
        {"type": "fields", "fields": [
            {"label": "대상", "value": "{{payload.work_item_id}}"},
            {"label": "사유", "value": "{{payload.resolution_note}}"},
        ]},
    ],
}

_NEW_BLOCK_TEMPLATE = {
    "blocks": [
        {"type": "header", "text": "게이트 판정"},
        {"type": "text", "text": "**{{payload.gate_type}}** 게이트 — **{{payload.verdict}}**"},
        {"type": "fields", "fields": [
            {"label": "대상", "value": "{{payload.work_item_title}}"},
            {"label": "사유", "value": "{{payload.resolution_note}}"},
        ]},
    ],
}

# 0245 원본 그대로 + work_item_title 추가(additive, required 아님) — 나머지 필드/구조는
# 무손실 보존(부분 jsonb merge 대신 전체 리터럴 교체, 0249와 동일 스타일 — 드리프트 방지).
_OLD_PAYLOAD_SCHEMA = {
    "type": "object",
    "additionalProperties": False,
    "required": ["work_item_type", "work_item_id", "gate_type", "verdict"],
    "properties": {
        "work_item_type": {"type": "string"},
        "work_item_id": {"type": "string", "format": "uuid"},
        "gate_type": {"type": "string"},
        "verdict": {"type": "string", "enum": ["approved", "rejected"]},
        "resolver_member_id": {"type": "string", "format": "uuid"},
        "resolution_note": {"type": ["string", "null"]},
    },
}

_NEW_PAYLOAD_SCHEMA = {
    "type": "object",
    "additionalProperties": False,
    "required": ["work_item_type", "work_item_id", "gate_type", "verdict"],
    "properties": {
        "work_item_type": {"type": "string"},
        "work_item_id": {"type": "string", "format": "uuid"},
        "work_item_title": {"type": ["string", "null"]},
        "gate_type": {"type": "string"},
        "verdict": {"type": "string", "enum": ["approved", "rejected"]},
        "resolver_member_id": {"type": "string", "format": "uuid"},
        "resolution_note": {"type": ["string", "null"]},
    },
}


def upgrade() -> None:
    bind = op.get_bind()
    bind.execute(
        sa.text(
            "UPDATE event_definitions "
            "SET block_template = :block_template, payload_schema = :payload_schema, "
            "    version = version + 1 "
            "WHERE org_id IS NULL AND key = :key"
        ),
        {
            "block_template": json.dumps(_NEW_BLOCK_TEMPLATE),
            "payload_schema": json.dumps(_NEW_PAYLOAD_SCHEMA),
            "key": _KEY,
        },
    )


def downgrade() -> None:
    bind = op.get_bind()
    bind.execute(
        sa.text(
            "UPDATE event_definitions "
            "SET block_template = :block_template, payload_schema = :payload_schema, "
            "    version = version - 1 "
            "WHERE org_id IS NULL AND key = :key"
        ),
        {
            "block_template": json.dumps(_OLD_BLOCK_TEMPLATE),
            "payload_schema": json.dumps(_OLD_PAYLOAD_SCHEMA),
            "key": _KEY,
        },
    )
