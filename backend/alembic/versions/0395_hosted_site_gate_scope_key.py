"""story #4189(E-RECIPE-2·P1) — 기존 자사 블로그(hosted_site) 초안 게이트를 "" 슬롯에서 "hosted_site"로.

코드(site_posts.site_post_gate_scope_key)가 이제 자사 블로그 게이트를 "hosted_site" 슬롯에서 찾으므로,
이 마이그레이션 전에 "" 슬롯에 만들어진 행을 그대로 두면 이미 승인된 자사 블로그 글이 발행 조회에서
안 잡힌다(재제출해야 함 · 옛 행은 방치). 그래서 한 번만 옮긴다.

- 대상 판별: gate_type='external_publish' · scope_key='' · neutral_facts.destination='hosted_site' ·
  neutral_facts에 draft_id — site post 제출만 쓰는 키(site_posts.py submit의 neutral_facts). 레시피
  게이트는 triggered_by_event·stage를 갖고 destination·draft_id가 없어 대상 밖.
- 레시피 게이트와 한 행을 나눠 쓰다 덮인 행(이 버그의 결과)은 이미 site post 키만 남아 있어 자사 블로그
  게이트로 옮겨진다 — 레시피는 다음 stage 발행 때 "" 슬롯에 게이트를 새로 연다(recipe_gate_hooks).
- 충돌 없음: UNIQUE(org, work_item, work_item_type, gate_type, scope_key) WHERE pr_number IS NULL인데
  "hosted_site"를 쓰는 코드는 이 PR 전엔 없었다. 그래도 NOT EXISTS로 막는다.
- downgrade는 같은 work_item의 "" 슬롯이 비어 있을 때만 되돌린다(그 사이 레시피 게이트가 생겼으면 둔다).

Revision ID: 0395
Revises: 0394
Create Date: 2026-09-23
"""
from __future__ import annotations

import sqlalchemy as sa
from alembic import op

revision = "0395"
down_revision = "0394"
branch_labels = None
depends_on = None

_MOVE = """
UPDATE gate AS g
SET scope_key = :to_scope
WHERE g.gate_type = 'external_publish'
  AND g.pr_number IS NULL
  AND g.scope_key = :from_scope
  AND g.neutral_facts->>'destination' = 'hosted_site'
  AND g.neutral_facts ? 'draft_id'
  AND NOT EXISTS (
    SELECT 1 FROM gate o
    WHERE o.org_id = g.org_id AND o.work_item_id = g.work_item_id AND o.work_item_type = g.work_item_type
      AND o.gate_type = g.gate_type AND o.scope_key = :to_scope AND o.pr_number IS NULL
  )
"""


def upgrade() -> None:
    op.get_bind().execute(sa.text(_MOVE), {"from_scope": "", "to_scope": "hosted_site"})


def downgrade() -> None:
    op.get_bind().execute(sa.text(_MOVE), {"from_scope": "hosted_site", "to_scope": ""})
