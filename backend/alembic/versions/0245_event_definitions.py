"""story #2632(이벤트 레지스트리 P1a): event_definitions 테이블 + 프리셋 시드 4종.

Revision ID: 0245
Revises: 0244
Create Date: 2026-08-13

doc event-registry-core-p1-plan §2-1·§2-5. key 네임스페이스(preset.*/org.{slug}.*)를
CHECK로 1차 방어(모양만 — slug가 호출자 자신의 것인지는 app 레이어, event_definition_
registry.py가 강제). org_id NULL=프리셋 전역 유일·org_id NOT NULL=org당 유일(부분 unique
index 2개, WebhookConfig의 project_id-nullable-scope 패턴과 동형).
"""
from __future__ import annotations

import uuid

import sqlalchemy as sa
from alembic import op
from sqlalchemy.dialects import postgresql

revision = "0245"
down_revision = "0244"
branch_labels = None
depends_on = None

# (key, payload_schema, routing) — payload_schema는 전부 additionalProperties: false 명시
# (모델 docstring 참조 — 스키마 저작 시점의 책임, AC3).
_SEED = [
    (
        "preset.gate.verdict",
        {
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
        },
        # 잠정 — 실 해석은 #2633(도달 3층 해석기)의 몫. verdict는 이미 일어난 결과 통지라
        # escalation(개입 요청) 대상은 없고, 그 work_item의 이해관계자에게만 전파.
        {
            "escalation": {"target": "none"},
            "broadcast": {"target": "work_item_stakeholders", "inherit_conversation_scope": True},
        },
    ),
    (
        "preset.work.status_changed",
        {
            "type": "object",
            "additionalProperties": False,
            "required": ["work_item_type", "work_item_id", "from_status", "to_status"],
            "properties": {
                "work_item_type": {"type": "string"},
                "work_item_id": {"type": "string", "format": "uuid"},
                "from_status": {"type": "string"},
                "to_status": {"type": "string"},
                "changed_by_member_id": {"type": "string", "format": "uuid"},
                "note": {"type": ["string", "null"]},
            },
        },
        {
            "escalation": {"target": "none"},
            "broadcast": {"target": "work_item_stakeholders", "inherit_conversation_scope": True},
        },
    ),
    (
        "preset.work.assigned",
        {
            "type": "object",
            "additionalProperties": False,
            "required": ["work_item_type", "work_item_id", "assignee_member_id"],
            "properties": {
                "work_item_type": {"type": "string"},
                "work_item_id": {"type": "string", "format": "uuid"},
                "assignee_member_id": {"type": "string", "format": "uuid"},
                "assigned_by_member_id": {"type": ["string", "null"], "format": "uuid"},
            },
        },
        # 배정 대상이 바로 개입(작업 착수)을 요청받는 사람 — escalation target=assignee.
        {
            "escalation": {"target": "assignee"},
            "broadcast": {"target": "work_item_stakeholders", "inherit_conversation_scope": True},
        },
    ),
    (
        "preset.goal.measured",
        {
            "type": "object",
            "additionalProperties": False,
            "required": ["goal_id", "metric_value"],
            "properties": {
                "goal_id": {"type": "string", "format": "uuid"},
                "metric_value": {"type": "number"},
                "metric_unit": {"type": ["string", "null"]},
                "source": {
                    "type": ["string", "null"],
                    "description": "실측치 출처(예: GA4·GitHub·수동) — 커넥터 없는 외부 연동의 관문(P1 플랜 §1.5).",
                },
                "measured_at": {"type": ["string", "null"], "format": "date-time"},
            },
        },
        {
            "escalation": {"target": "none"},
            "broadcast": {"target": "goal_owner", "inherit_conversation_scope": False},
        },
    ),
]

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
    op.create_table(
        "event_definitions",
        sa.Column("id", postgresql.UUID(as_uuid=True), primary_key=True),
        sa.Column("key", sa.Text(), nullable=False),
        sa.Column("org_id", postgresql.UUID(as_uuid=True), nullable=True),
        sa.Column("payload_schema", postgresql.JSONB(), nullable=False),
        sa.Column("routing", postgresql.JSONB(), nullable=False),
        sa.Column("block_template", postgresql.JSONB(), nullable=True),
        sa.Column("action_auth", postgresql.JSONB(), nullable=True),
        sa.Column("enabled", sa.Boolean(), nullable=False, server_default="true"),
        sa.Column("version", sa.Integer(), nullable=False, server_default="1"),
        sa.Column("created_by", postgresql.UUID(as_uuid=True), nullable=True),
        sa.Column("created_at", sa.DateTime(timezone=True), server_default=sa.text("now()"), nullable=False),
        sa.Column("updated_at", sa.DateTime(timezone=True), server_default=sa.text("now()"), nullable=False),
        sa.CheckConstraint(
            r"(org_id IS NULL AND key ~ '^preset\.[a-z0-9_]+(\.[a-z0-9_]+)+$')"
            r" OR (org_id IS NOT NULL AND key ~ '^org\.[a-z0-9-]+\.[a-z0-9_]+(\.[a-z0-9_]+)*$')",
            name="ck_event_definitions_key_namespace",
        ),
    )
    op.create_index("ix_event_definitions_org_id", "event_definitions", ["org_id"])
    op.create_index(
        "uq_event_definitions_preset_key", "event_definitions", ["key"],
        unique=True, postgresql_where=sa.text("org_id IS NULL"),
    )
    op.create_index(
        "uq_event_definitions_org_key", "event_definitions", ["org_id", "key"],
        unique=True, postgresql_where=sa.text("org_id IS NOT NULL"),
    )

    op.bulk_insert(
        _event_definitions,
        [
            {
                "id": uuid.uuid4(),
                "key": key,
                "org_id": None,
                "payload_schema": payload_schema,
                "routing": routing,
                "block_template": None,
                "action_auth": None,
                "enabled": True,
                "version": 1,
                "created_by": None,
            }
            for key, payload_schema, routing in _SEED
        ],
    )


def downgrade() -> None:
    op.drop_index("uq_event_definitions_org_key", table_name="event_definitions")
    op.drop_index("uq_event_definitions_preset_key", table_name="event_definitions")
    op.drop_index("ix_event_definitions_org_id", table_name="event_definitions")
    op.drop_table("event_definitions")
