"""story #3487(Phase1·마케팅운영·소형, 페드루 PO 決定 2026-09-05) — preset.gate.verdict
payload_schema에 gate_id(선택) 필드를 연다.

[[no-pr-for-data]] 게이트 — 프리셋 표현/스키마 변경(0251/0301/0303/0309 선례와 동일 규칙,
병합 전 선생님 확認 필요할 수 있음).

배경(페드루 PO 決定, 2026-09-05) — story #3478(gate.scope_key)이 착지하면 같은 work_item
에 목적지가 다른 external_publish 게이트가 둘 이상 있을 수 있다. `_render_gate_verdict_
message`(events.py)의 기존 게이트 재조회(`(org_id, work_item_id, work_item_type,
gate_type, status==verdict)` + `order_by(resolved_at desc).limit(1)`)는 그런 상황에서
"가장 최근 resolved"인 게이트 하나만 골라 그 문맥(draft_id·목적지)을 보여준다 — 지금
막 승인/반려된 그 게이트가 아니라 다른 게이트의 정보가 섞일 수 있다. 이벤트가 판정된
그 gate_id를 직접 들고 오면 렌더가 그 행만 정확히 읽을 수 있다(재조회 자체가 불요해진다).

payload_schema는 `additionalProperties: false`라 이 필드가 스키마에 없으면 발행 자체가
422로 거부된다 — 0303/0309 선례와 동일한 additive-only 변경(선택 필드, required엔
안 넣는다 — 이 발행 호출부는 항상 채우지만, 스키마 자체는 과거 이력 호환을 위해
필수로 강제하지 않는다).

Revision ID: 0330
Revises: 0329
Create Date: 2026-09-05

⚠️번호 재부여 — 최초 0329로 열었으나 미르코군 #3836(story #3475, 발행 계측 API)이
같은 번호를 먼저 잡아(페드루 PO 조정으로 0329는 #3836 소유) 0330으로 재부여했다
(0309 선례와 동형 사고 — 도메인이 달라 순서 자체는 무의미, 체인만 선형으로 맞춘다)."""
from __future__ import annotations

import json

import sqlalchemy as sa

from alembic import op

revision = "0330"
down_revision = "0329"
branch_labels = None
depends_on = None

_KEY = "preset.gate.verdict"

# 0309 이후 현행 그대로(무손실 보존, 0301/0303/0309와 동일 스타일 — 전체 리터럴 교체로
# 드리프트 방지).
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
        "gate_requester_member_id": {"type": "string", "format": "uuid"},
        "gate_draft_author_member_id": {"type": "string", "format": "uuid"},
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
        "gate_requester_member_id": {"type": "string", "format": "uuid"},
        "gate_draft_author_member_id": {"type": "string", "format": "uuid"},
        # story #3487 — 선택 필드(required엔 안 넣는다, 0303/0309와 동일 원칙). 판정된
        # 그 gate 행을 정확히 재조회하기 위한 축(story #3478 dual-destination 이후
        # (work_item, gate_type)만으로는 게이트가 더 이상 유일하지 않다).
        "gate_id": {"type": "string", "format": "uuid"},
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
