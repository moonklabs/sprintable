"""story #2829(loop-closure P0, doc loop-closure-first-class-signal-design §1) — 「닫히지
않은 루프」 신호: measure_after 도과 hypothesis(active·measuring)/goal(active) 도과 시
preset.loop.measure_due 발행 대상 컬럼 + 프리셋 정의 시드.

Revision ID: 0264
Revises: 0263
Create Date: 2026-08-20
"""
from __future__ import annotations

import uuid

import sqlalchemy as sa
from alembic import op
from sqlalchemy.dialects import postgresql

revision = "0264"
down_revision = "0263"
branch_labels = None
depends_on = None

_KEY = "preset.loop.measure_due"

# routing: kind=payload_field(owner) — 이 이벤트를 발행하는 자리(cron job)가 이미 goal_owner/
# hypothesis owner_member_id를 알고 있으므로(스캔 쿼리 자체가 그 값을 읽는다) server_derived
# 신규 해석기(SERVER_DERIVED_TARGETS 확장)를 추가하는 대신 기존 payload_field 부류를 그대로
# 쓴다 — preset.work.assigned(0245)와 동일 판단(설계 doc의 "새 규칙 발명 금지" 정신).
_ROUTING = {
    "escalation": {
        "kind": "payload_field", "target": "owner", "member_id_field": "owner_member_id",
    },
    "broadcast": {"kind": "server_derived", "target": "none"},
}

_PAYLOAD_SCHEMA = {
    "type": "object",
    "additionalProperties": False,
    "required": ["work_item_type", "work_item_id", "owner_member_id", "reason"],
    "properties": {
        # "epic"= 실체 Goal의 work_item_type 리터럴(B1 rename 前 이름이 project 해소 계통
        # 전체의 SSOT로 그대로 남아 있음 — gate_service.resolve_work_item_project_id 참조,
        # 새 리터럴 "goal"을 추가하면 그 해소기가 못 풀어 발행이 400으로 죽는다).
        "work_item_type": {"type": "string", "enum": ["epic", "hypothesis"]},
        "work_item_id": {"type": "string", "format": "uuid"},
        "owner_member_id": {"type": "string", "format": "uuid"},
        # done_without_outcome 케이스(§1 대상 2류)는 measure_after가 애초에 없을 수 있어
        # nullable — "도과"와 "outcome 없이 done"은 다른 판정 축이라 FE 배지도 갈린다.
        "measure_after": {"type": ["string", "null"], "format": "date-time"},
        "overdue_days": {"type": ["number", "null"]},
        "reason": {"type": "string", "enum": ["measure_after_overdue", "done_without_outcome"]},
    },
}

_event_definitions = sa.table(
    "event_definitions",
    sa.column("id", postgresql.UUID(as_uuid=True)),
    sa.column("key", sa.Text),
    sa.column("org_id", postgresql.UUID(as_uuid=True)),
    sa.column("name", sa.Text),
    sa.column("payload_schema", postgresql.JSONB),
    sa.column("routing", postgresql.JSONB),
    sa.column("enabled", sa.Boolean),
    sa.column("version", sa.Integer),
    sa.column("created_by", postgresql.UUID(as_uuid=True)),
)


def upgrade() -> None:
    op.add_column(
        "hypotheses",
        sa.Column("loop_measure_due_notified_at", sa.DateTime(timezone=True), nullable=True),
    )
    op.add_column(
        "goals",
        sa.Column("loop_measure_due_notified_at", sa.DateTime(timezone=True), nullable=True),
    )
    op.bulk_insert(
        _event_definitions,
        [{
            "id": uuid.uuid4(),
            "key": _KEY,
            "org_id": None,
            "name": "측정 기한 도과",
            "payload_schema": _PAYLOAD_SCHEMA,
            "routing": _ROUTING,
            "enabled": True,
            "version": 1,
            "created_by": None,
        }],
    )


def downgrade() -> None:
    op.execute(sa.text("DELETE FROM event_definitions WHERE key = :key AND org_id IS NULL").bindparams(key=_KEY))
    op.drop_column("goals", "loop_measure_due_notified_at")
    op.drop_column("hypotheses", "loop_measure_due_notified_at")
