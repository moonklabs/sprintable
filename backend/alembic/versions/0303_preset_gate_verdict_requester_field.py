"""story #3340(선생님 4바퀴 실사고, 페드루 PO GO 2026-09-02) — preset.gate.verdict
payload_schema에 gate_requester_member_id(선택) 필드를 연다.

[[no-pr-for-data]] 게이트 — 프리셋 표현/스키마 변경(0166/0167/0240/0249/0251/0301
선례와 동일 규칙, 병합 전 선생님 확認 필요할 수 있음).

Revision ID: 0303
Revises: 0302
Create Date: 2026-09-02

배경: work_item_stakeholders(assignee·human owner) 해석이 빈 집합이면(work item 미배정)
게이트 판정 통지가 "시스템 발행" 혼자만 있는 group으로 가 실행자에게 안 닿았다
(4바퀴 실사고 — gate 11a86235 반려). gate_service.py::_publish_gate_verdict_notification이
게이트를 만든 stage 이벤트 발행자(neutral_facts.requested_by_member_id)를 이 새 payload
키로 실어 보내면, event_routing_resolver.py::_resolve_work_item_stakeholders가 그 값을
이해관계자 집합에 합류시킨다.

payload_schema는 `additionalProperties: false`라 이 필드가 스키마에 없으면 발행 자체가
422로 거부된다 — 0251(work_item_title 추가) 선례와 동일한 additive-only 변경.
"""
from __future__ import annotations

import json

import sqlalchemy as sa
from alembic import op

revision = "0303"
down_revision = "0302"
branch_labels = None
depends_on = None

_KEY = "preset.gate.verdict"

# 0251 이후 현행 그대로(무손실 보존, 0301/0251과 동일 스타일 — 전체 리터럴 교체로 드리프트
# 방지). work_item_title은 nullable(0251 원문 그대로).
_OLD_PAYLOAD_SCHEMA = {
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
        # story #3340 — 선택 필드(required엔 안 넣는다, 0251의 work_item_title과 동일 원칙).
        "gate_requester_member_id": {"type": "string", "format": "uuid"},
    },
}


def upgrade() -> None:
    bind = op.get_bind()
    bind.execute(
        sa.text(
            "UPDATE event_definitions "
            "SET payload_schema = :payload_schema, version = version + 1 "
            "WHERE org_id IS NULL AND key = :key"
        ),
        {"payload_schema": json.dumps(_NEW_PAYLOAD_SCHEMA), "key": _KEY},
    )


def downgrade() -> None:
    bind = op.get_bind()
    bind.execute(
        sa.text(
            "UPDATE event_definitions "
            "SET payload_schema = :payload_schema, version = version - 1 "
            "WHERE org_id IS NULL AND key = :key"
        ),
        {"payload_schema": json.dumps(_OLD_PAYLOAD_SCHEMA), "key": _KEY},
    )
