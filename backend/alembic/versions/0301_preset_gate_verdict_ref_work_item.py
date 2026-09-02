"""story #3332(PO 확定 2026-09-02) — preset.gate.verdict block_template의 "대상" 필드를
work item 참조 토큰으로 교체.

Revision ID: 0301
Revises: 0300
Create Date: 2026-09-02

[[no-pr-for-data]] 게이트 — 프리셋 표현 콘텐츠 변경(0166/0167/0240/0249/0251 선례와 동일 규칙,
병합 전 선생님 확認 필요할 수 있음).

정정 근거: 0251이 "대상" 값을 `{{payload.work_item_id}}`(원시 UUID)에서
`{{payload.work_item_title}}`로 바꿨는데, 이 필드는 payload_schema에 optional로만
추가됐을 뿐(0251) 실제 발행처(`_publish_gate_verdict_notification`, #3330) 어디서도
채워진 적이 없어 렌더 시 항상 `⟨missing: payload.work_item_title⟩`로 떴다(PR#3711
리뷰, 페드루 실측). 이번 정정(#3332)이 새로 연 `{{ref.X}}` 네임스페이스(서버가 발행
시점에 계산하는 클릭 가능한 참조 토큰, events.py::_publish_registry_event_core)로
"대상"을 `{{ref.work_item}}`으로 바꾼다 — 생 텍스트가 아니라 실제 클릭 토큰이 뜬다.

payload_schema는 이번엔 안 건드린다(0251이 추가한 work_item_title 필드는 그대로
남겨둔다 — 파괴적 스키마 변경 불필요, 그저 아무도 안 채우는 optional 필드로 남을 뿐
무해하다).
"""
from __future__ import annotations

import json

import sqlalchemy as sa
from alembic import op

revision = "0301"
down_revision = "0300"
branch_labels = None
depends_on = None

_KEY = "preset.gate.verdict"

_OLD_BLOCK_TEMPLATE = {
    "blocks": [
        {"type": "header", "text": "게이트 판정"},
        {"type": "text", "text": "**{{payload.gate_type}}** 게이트 — **{{payload.verdict}}**"},
        {"type": "fields", "fields": [
            {"label": "대상", "value": "{{payload.work_item_title}}"},
            {"label": "사유", "value": "{{payload.resolution_note}}"},
        ]},
    ],
}

_NEW_BLOCK_TEMPLATE = {
    "blocks": [
        {"type": "header", "text": "게이트 판정"},
        {"type": "text", "text": "**{{payload.gate_type}}** 게이트 — **{{payload.verdict}}**"},
        {"type": "fields", "fields": [
            {"label": "대상", "value": "{{ref.work_item}}"},
            {"label": "사유", "value": "{{payload.resolution_note}}"},
        ]},
    ],
}


def upgrade() -> None:
    bind = op.get_bind()
    bind.execute(
        sa.text(
            "UPDATE event_definitions "
            "SET block_template = :block_template, version = version + 1 "
            "WHERE org_id IS NULL AND key = :key"
        ),
        {"block_template": json.dumps(_NEW_BLOCK_TEMPLATE), "key": _KEY},
    )


def downgrade() -> None:
    bind = op.get_bind()
    bind.execute(
        sa.text(
            "UPDATE event_definitions "
            "SET block_template = :block_template, version = version - 1 "
            "WHERE org_id IS NULL AND key = :key"
        ),
        {"block_template": json.dumps(_OLD_BLOCK_TEMPLATE), "key": _KEY},
    )
