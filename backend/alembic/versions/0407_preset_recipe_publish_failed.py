"""story #4258 — preset.recipe.publish_failed: 레시피 문맥의 서버 비동기 발행이 사람 손이 필요한 멈춤(dead_letter · blocked)이
됐을 때의 통지 이벤트 정의 시드.

- 발행 주체는 서버(워커 `process_due_publication_commands`가 명령 결과를 커밋한 뒤 · `recipe_publish_failure.
  notify_recipe_publish_stopped`).
- 수신자 = routing broadcast `server_derived` target `recipe_publish_failure`(event_routing_resolver) — 그 발행을 연 게이트를
  실제로 승인한 사람 ∪ 요청 stage에 바인딩된 에이전트. 이벤트를 낸 쪽과 같은 함수가 해소한다.
- 레시피는 다음 단계로 넘어가지 않는다(이 이벤트는 레시피 정의의 stage 이벤트가 아니다).

Revision ID: 0407
Revises: 0404
Create Date: 2026-09-24 — 번호는 착지 순(PO 08:51Z · 사다리): 앞 PR(0405 = 4260 · 0406 = 4249)이 먼저 들어가면 rebase 때
down_revision을 그 뒤로 옮기고 번호를 고친다.
"""
import uuid

import sqlalchemy as sa
from alembic import op
from sqlalchemy.dialects.postgresql import JSONB, UUID as PGUUID

revision = "0407"
down_revision = "0404"
branch_labels = None
depends_on = None

_EVENT_KEY = "preset.recipe.publish_failed"

_PAYLOAD_SCHEMA = {
    "type": "object",
    "additionalProperties": False,
    "required": [
        "work_item_type", "work_item_id", "definition_key", "stage", "command_id", "content_kind", "stop_kind",
    ],
    "properties": {
        "work_item_type": {"type": "string"},
        "work_item_id": {"type": "string", "format": "uuid"},
        # 멈춘 발행을 요청한 레시피(정의 key)와 그 stage — 레시피는 이 stage에 멈춰 있다.
        "definition_key": {"type": "string"},
        "stage": {"type": "string"},
        "command_id": {"type": "string", "format": "uuid"},
        "content_kind": {"type": "string", "enum": ["newsletter_send", "channel_post", "site_post"]},
        # dead_letter = 재시도를 포기함(사람이 다시 시도) · blocked = 연결이 끊겨 멈춤(다시 연결하면 이어짐).
        "stop_kind": {"type": "string", "enum": ["dead_letter", "blocked"]},
        "reason_code": {"type": ["string", "null"]},
        # 명령의 실패 분류(connection · needs_check · transient) — needs_check면 «밖에 나갔는지 모름»(발행물 목록 배지와 같은 판정).
        "failure_kind": {"type": ["string", "null"]},
    },
}

_ROUTING = {
    "escalation": {"kind": "server_derived", "target": "none"},
    "broadcast": {"kind": "server_derived", "target": "recipe_publish_failure"},
}

# 시스템 이벤트 카드 관례(`{{t.*}}` — FE event-block-card가 eventCard 낱말 표로 로케일 해석 · 문안 = 유나).
_BLOCK_TEMPLATE = {
    "blocks": [
        {"type": "header", "text": "{{t.recipePublishFailedHeader}}"},
        {"type": "fields", "fields": [
            {"label": "{{t.targetLabel}}", "value": "{{label.work_item_target}}", "optional": True},
        ]},
    ],
}

_NAME = "레시피 발행 멈춤"
_DESCRIPTION = "레시피가 서버에 맡긴 발행(뉴스레터 발송 · 채널 발행 · 블로그 발행)이 사람 손이 필요한 상태로 멈췄어요."

event_definitions = sa.table(
    "event_definitions",
    sa.column("id", PGUUID(as_uuid=True)),
    sa.column("key", sa.Text),
    sa.column("org_id", PGUUID(as_uuid=True)),
    sa.column("name", sa.Text),
    sa.column("description", sa.Text),
    sa.column("payload_schema", JSONB),
    sa.column("routing", JSONB),
    sa.column("block_template", JSONB),
    sa.column("enabled", sa.Boolean),
    sa.column("version", sa.Integer),
)


def upgrade() -> None:
    bind = op.get_bind()
    if bind.execute(
        sa.text("SELECT 1 FROM event_definitions WHERE key = :key AND org_id IS NULL"), {"key": _EVENT_KEY},
    ).first() is not None:
        return
    op.bulk_insert(event_definitions, [{
        "id": uuid.uuid4(), "key": _EVENT_KEY, "org_id": None, "name": _NAME, "description": _DESCRIPTION,
        "payload_schema": _PAYLOAD_SCHEMA, "routing": _ROUTING, "block_template": _BLOCK_TEMPLATE,
        "enabled": True, "version": 1,
    }])


def downgrade() -> None:
    op.execute(sa.text("DELETE FROM event_definitions WHERE key = :key AND org_id IS NULL").bindparams(key=_EVENT_KEY))
