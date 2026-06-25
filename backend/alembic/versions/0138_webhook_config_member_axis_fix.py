"""webhook_configs.member_id 축 보정: users.id → org_member.id (휴먼 config)

#1726 의 `_get_caller_member_id` 가 `canonicalize(auth.user_id)` = **users.id** 축으로 휴먼 webhook
config 를 저장/스코프해, 디스패치(conversation_participants.member_id = org_member.id 축)와 불일치 →
webhook silent 미배달. 코드는 `resolve_member().id`(휴먼=org_member.id) 로 수정. 이 마이그는 그 사이
users.id 축으로 저장된 휴먼 config 를 org_member.id 로 **1회 보정**한다.

⚠️ unique 충돌 처리(산티아고 RC·prod-blocker): baseline partial unique 가 있다 —
  - `idx_webhook_configs_default`: UNIQUE(org_id, member_id)              WHERE project_id IS NULL
  - `idx_webhook_configs_unique` : UNIQUE(org_id, member_id, project_id) WHERE project_id IS NOT NULL
같은 (org, user, scope) 에 ①과거 canonical(org_member.id) + ②#1726 後 회귀(users.id) 가 **공존**하면,
②→org_member.id 단순 UPDATE 가 ①과 충돌해 alembic 실패(fresh-DB CI 미검출). 따라서:

  1. **is_active OR-merge**: 충돌 시 ②(회귀)가 active 였으면 ①(canonical)도 active 로(배달 의도 보존).
  2. **회귀 dup DELETE**: canonical 이 이미 있으면 ②(회귀·미배달이던 dup)를 삭제(canonical 유지가 안전).
  3. **UPDATE 나머지**: canonical 이 없는 회귀만 org_member.id 로 보정(NOT EXISTS 가드로 충돌 0).

scope 동일성은 `project_id IS NOT DISTINCT FROM`(NULL=NULL·default 인덱스, 정확일치·unique 인덱스 양립).
- **idempotent**: 보정 후 member_id=org_member.id 라 `om.user_id=wc.member_id` 재매칭 0.
- **에이전트 무접촉**: agent config(member_id=team_member.id)는 org_members.user_id(=users.id) 안 맞아 0행.
- **prod 사실상 no-op**: 회귀는 develop-only·prod config 전부 canonical(배달中) → users.id row 0.

Revision ID: 0138
Revises: 0137
"""
from alembic import op

revision = "0138"
down_revision = "0137"
branch_labels = None
depends_on = None

# ① is_active OR-merge: 충돌하는 active 회귀의 의도를 canonical 에 보존.
_OR_MERGE_ACTIVE = """
UPDATE webhook_configs canon
SET is_active = TRUE
FROM org_members om, webhook_configs reg
WHERE om.id = canon.member_id
  AND om.org_id = canon.org_id
  AND om.user_id = reg.member_id            -- reg = 회귀(member_id = users.id)
  AND reg.org_id = canon.org_id
  AND reg.id <> canon.id
  AND reg.project_id IS NOT DISTINCT FROM canon.project_id
  AND reg.is_active
  AND NOT canon.is_active
"""

# ② canonical 이 이미 있는 회귀 dup 삭제(미배달이던 회귀 제거·canonical 유지).
_DELETE_COLLIDING_REGRESSED = """
DELETE FROM webhook_configs reg
USING org_members om, webhook_configs canon
WHERE om.user_id = reg.member_id
  AND om.org_id = reg.org_id
  AND canon.org_id = reg.org_id
  AND canon.member_id = om.id
  AND canon.id <> reg.id
  AND canon.project_id IS NOT DISTINCT FROM reg.project_id
"""

# ③ canonical 없는 회귀만 org_member.id 로 보정(NOT EXISTS 가드 = 충돌 0·방어).
_UPDATE_REMAINING = """
UPDATE webhook_configs reg
SET member_id = om.id
FROM org_members om
WHERE om.user_id = reg.member_id
  AND om.org_id = reg.org_id
  AND NOT EXISTS (
    SELECT 1 FROM webhook_configs c2
    WHERE c2.org_id = reg.org_id
      AND c2.member_id = om.id
      AND c2.project_id IS NOT DISTINCT FROM reg.project_id
      AND c2.id <> reg.id
  )
"""


def upgrade() -> None:
    op.execute(_OR_MERGE_ACTIVE)
    op.execute(_DELETE_COLLIDING_REGRESSED)
    op.execute(_UPDATE_REMAINING)


def downgrade() -> None:
    # 데이터 보정 — 원 users.id 가 소실되어 역보정 불가. forward-only no-op.
    pass
