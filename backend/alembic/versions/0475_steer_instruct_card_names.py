"""story 4921 — `preset.steer.instruct`: the card says WHO and WHAT in words, and its fixed words come from the viewer's language.

The card (0274, the work item made optional by 0474) showed the raw ids: «대상 946300bd-…» and «지시 대상자 97470487-…» (its template read `{{payload.work_item_id}}` /
`{{payload.target_member_id}}`), and its header and field labels were Korean text baked into the row — an English reader saw «방향 전환 / 대상 / 지시 대상자».
This rewrites the platform row's `block_template` in place, the way 0376 / 0377 did for the other presets:

- header and labels are `{{t.X}}` words (the viewer's language, resolved when the card is drawn);
- «대상» = `{{label.work_item_target}}` — the work item's TITLE as a link (the server already puts `refs.work_item` on every event that carries a work item, and the card turns it into this label);
- «지시 대상자» = `{{label.target_name}}` — the member's NAME, from `refs.target` (the publish route now resolves `target_member_id` like it resolves the assignee of a work assignment);
- both lines stay `optional`: a message published before this story has no `refs.target`, so its «지시 대상자» line is left out (never «unknown» — the member is simply not named there), and an instruction without a work item has no «대상» line (0474).

Only the template changes — the payload schema, the routing and every other row are untouched.

Revision ID: 0475
Revises: 0474
Create Date: 2026-11-13
"""
from __future__ import annotations

import json

import sqlalchemy as sa
from alembic import op

revision = "0475"
down_revision = "0474"
branch_labels = None
depends_on = None

_KEY = "preset.steer.instruct"

_AFTER = {
    "blocks": [
        {"type": "header", "text": "{{t.steerHeader}}"},
        {"type": "text", "text": "{{payload.instruction}}"},
        {"type": "fields", "fields": [
            {"label": "{{t.targetLabel}}", "value": "{{label.work_item_target}}", "optional": True},
            {"label": "{{t.steerTargetLabel}}", "value": "{{label.target_name}}", "optional": True},
        ]},
    ],
}

# exactly what 0474 left (restored by downgrade)
_BEFORE = {
    "blocks": [
        {"type": "header", "text": "방향 전환"},
        {"type": "text", "text": "{{payload.instruction}}"},
        {"type": "fields", "fields": [
            {"label": "대상", "value": "{{payload.work_item_id}}", "optional": True},
            {"label": "지시 대상자", "value": "{{payload.target_member_id}}"},
        ]},
    ],
}


def upgrade() -> None:
    # one line in upgrade() itself so the promotion's migration reading (deploy/vm/CUTOVER-prod.md G1a) lists it: a data-only UPDATE of the platform row
    op.execute(sa.text("UPDATE event_definitions SET block_template = CAST(:t AS jsonb) WHERE org_id IS NULL AND key = :k").bindparams(t=json.dumps(_AFTER), k=_KEY))


def downgrade() -> None:
    op.execute(sa.text("UPDATE event_definitions SET block_template = CAST(:t AS jsonb) WHERE org_id IS NULL AND key = :k").bindparams(t=json.dumps(_BEFORE), k=_KEY))
