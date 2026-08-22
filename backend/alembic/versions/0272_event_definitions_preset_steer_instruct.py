"""story #2935(설계 doc steer-event-axis-design-2927 §1 확定분) — preset.steer.instruct
event_definition 신규 시드.

0245(event_definitions 테이블+프리셋 4종)·0249(block_template 시드) 패턴을 그대로 계승 —
이건 5번째 preset key 추가일 뿐 새 체계가 아니다(doc §0). payload_schema/routing/
block_template은 doc §1 초안을 그대로 옮긴다 — action_auth는 이번 판 없음(사람·에이전트
둘 다 발행 가능해야 하므로 무제한, doc §2).

⚠️용어 충돌(doc addendum, PO 확定 2026-08-22): "steer"라는 key 접두는 2026-07-11 옛
"로드맵 조타" doc(be-design-roadmap-steer-ortega-events-96b19bc3, 미구현 draft)과 다른
개념이다 — 이름은 방향서 캐논 어휘(STEER=composer 챗 1급 동작)를 그대로 쓰기로 PO가 확定
했고, 옛 doc 쪽에 혼동방지 배너를 부착했다. `preset.roadmap.*`류가 실제로 필요해지면 그건
별도 네임스페이스를 쓸 것 — 이 마이그와 충돌하지 않는다.

Revision ID: 0272
Revises: 0271
Create Date: 2026-08-22
"""
from __future__ import annotations

import uuid

import sqlalchemy as sa
from alembic import op
from sqlalchemy.dialects import postgresql

revision = "0272"
down_revision = "0271"
branch_labels = None
depends_on = None

_KEY = "preset.steer.instruct"

_PAYLOAD_SCHEMA = {
    "type": "object",
    "additionalProperties": False,
    "required": ["work_item_type", "work_item_id", "target_member_id", "instruction"],
    "properties": {
        "work_item_type": {"type": "string"},
        "work_item_id": {"type": "string", "format": "uuid"},
        "target_member_id": {"type": "string", "format": "uuid"},
        "instruction": {"type": "string", "minLength": 1},
        "issued_by_member_id": {"type": ["string", "null"], "format": "uuid"},
    },
}

# preset.work.assigned(0245:94-102)의 payload_field/server_derived 조합을 그대로 복제 —
# escalation=지시가 실제로 도달해야 하는 대상 1인, broadcast=같은 work item 이해관계자 공람.
_ROUTING = {
    "escalation": {
        "kind": "payload_field", "target": "steer_target",
        "member_id_field": "target_member_id",
    },
    "broadcast": {
        "kind": "server_derived", "target": "work_item_stakeholders",
        "inherit_conversation_scope": True,
    },
}

# actions 블록 없음 — 0249 선례와 동일 이유("눌러도 뭘 하는지 모르는 버튼보다 없는 게 낫다").
_BLOCK_TEMPLATE = {
    "blocks": [
        {"type": "header", "text": "방향 전환"},
        {"type": "text", "text": "{{payload.instruction}}"},
        {"type": "fields", "fields": [
            {"label": "대상", "value": "{{payload.work_item_id}}"},
            {"label": "지시 대상자", "value": "{{payload.target_member_id}}"},
        ]},
    ],
}

_event_definitions = sa.table(
    "event_definitions",
    sa.column("id", postgresql.UUID(as_uuid=True)),
    sa.column("key", sa.Text),
    sa.column("org_id", postgresql.UUID(as_uuid=True)),
    sa.column("payload_schema", postgresql.JSONB),
    sa.column("routing", postgresql.JSONB),
    sa.column("block_template", postgresql.JSONB),
    sa.column("action_auth", postgresql.JSONB),
    sa.column("enabled", sa.Boolean),
    sa.column("version", sa.Integer),
    sa.column("created_by", postgresql.UUID(as_uuid=True)),
)


def upgrade() -> None:
    op.bulk_insert(
        _event_definitions,
        [{
            "id": uuid.uuid4(),
            "key": _KEY,
            "org_id": None,
            "payload_schema": _PAYLOAD_SCHEMA,
            "routing": _ROUTING,
            "block_template": _BLOCK_TEMPLATE,
            "action_auth": None,
            "enabled": True,
            "version": 1,
            "created_by": None,
        }],
    )


def downgrade() -> None:
    bind = op.get_bind()
    bind.execute(
        sa.text("DELETE FROM event_definitions WHERE org_id IS NULL AND key = :key"),
        {"key": _KEY},
    )
