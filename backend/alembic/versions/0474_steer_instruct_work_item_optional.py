"""story 4920 (owner's report 11-13: «스토리 선택 안하면 메시지 전송조차 안되는지?») — `preset.steer.instruct`:
the work item is optional context, not a required field.

A direction instruction is «to whom · what»: the target (`target_member_id`) and the text (`instruction`). 0274 seeded it with
`work_item_type` + `work_item_id` also required, so the composer could not send one without picking a story (or any doc).
This rewrites the platform definition row (org_id IS NULL) in place:

- `payload_schema.required` loses `work_item_type` · `work_item_id` (they stay in `properties` — the card still reads
  `{{payload.work_item_id}}`, and the registry cross-check needs the property to exist).
- the card's «대상» line becomes `optional: true` — it is left out when no work item was given (the renderer's own
  «optional single-variable line» rule, story #3881), and rendered exactly as before when one was.
- routing is unchanged: `escalation` = the target; `broadcast` = `work_item_stakeholders`, which the resolver already answers
  with an empty set when the payload has no work item — so an instruction without one reaches the target alone, and one with
  a work item reaches the same people as before.

Only the platform row is touched (an org's own copy of the key, if any, is its own definition).

Revision ID: 0474
Revises: 0473
Create Date: 2026-11-13
"""
from __future__ import annotations

import json

import sqlalchemy as sa
from alembic import op

revision = "0474"
down_revision = "0473"
branch_labels = None
depends_on = None

_KEY = "preset.steer.instruct"

_PROPERTIES = {
    "work_item_type": {"type": "string"},
    "work_item_id": {"type": "string", "format": "uuid"},
    "target_member_id": {"type": "string", "format": "uuid"},
    "instruction": {"type": "string", "minLength": 1},
    "issued_by_member_id": {"type": ["string", "null"], "format": "uuid"},
}

# after: a work item is optional
_PAYLOAD_SCHEMA_AFTER = {
    "type": "object",
    "additionalProperties": False,
    "required": ["target_member_id", "instruction"],
    "properties": _PROPERTIES,
}
_BLOCK_TEMPLATE_AFTER = {
    "blocks": [
        {"type": "header", "text": "방향 전환"},
        {"type": "text", "text": "{{payload.instruction}}"},
        {"type": "fields", "fields": [
            {"label": "대상", "value": "{{payload.work_item_id}}", "optional": True},
            {"label": "지시 대상자", "value": "{{payload.target_member_id}}"},
        ]},
    ],
}

# before: exactly what 0274 seeded (restored by downgrade)
_PAYLOAD_SCHEMA_BEFORE = {
    "type": "object",
    "additionalProperties": False,
    "required": ["work_item_type", "work_item_id", "target_member_id", "instruction"],
    "properties": _PROPERTIES,
}
_BLOCK_TEMPLATE_BEFORE = {
    "blocks": [
        {"type": "header", "text": "방향 전환"},
        {"type": "text", "text": "{{payload.instruction}}"},
        {"type": "fields", "fields": [
            {"label": "대상", "value": "{{payload.work_item_id}}"},
            {"label": "지시 대상자", "value": "{{payload.target_member_id}}"},
        ]},
    ],
}



def upgrade() -> None:
    # written in upgrade() itself, on one line, so the promotion's migration reading (deploy/vm/CUTOVER-prod.md G1a) lists it: a data-only UPDATE of the platform row
    op.execute(sa.text("UPDATE event_definitions SET payload_schema = CAST(:s AS jsonb), block_template = CAST(:t AS jsonb) WHERE org_id IS NULL AND key = :k").bindparams(s=json.dumps(_PAYLOAD_SCHEMA_AFTER), t=json.dumps(_BLOCK_TEMPLATE_AFTER), k=_KEY))


def downgrade() -> None:
    op.execute(sa.text("UPDATE event_definitions SET payload_schema = CAST(:s AS jsonb), block_template = CAST(:t AS jsonb) WHERE org_id IS NULL AND key = :k").bindparams(s=json.dumps(_PAYLOAD_SCHEMA_BEFORE), t=json.dumps(_BLOCK_TEMPLATE_BEFORE), k=_KEY))
