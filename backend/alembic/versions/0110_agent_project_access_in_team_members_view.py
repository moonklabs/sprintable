"""team_members 뷰 — 에이전트 project_access grant surface (18073a52 A안).

기존(0106) agent 브랜치는 프로젝트 소속을 `agent_project_profiles`(app)에서만 도출 → grant만 주고
profile 없는 프로젝트는 뷰에 안 떠서 chat 참가자 발견·list_members·dispatch assignee resolve 누락
(한쪽만 전환 트랩). A안=grant이 SSOT·뷰는 surface만 → **agent-grant-only 3번째 UNION 브랜치** 추가:
project_access(granted)는 있으나 그 프로젝트에 profile 없는 에이전트도 뷰 행 emit(런타임 컬럼 NULL·
role 'member'). profile+grant 동시 존재 시 기존 2번 브랜치가 처리하고 3번은 `app.project_id IS NULL`로
배제 → 중복 0. **profile 행 증식 0**(곱연산 패턴 회피·선생님 의도 정합).

+ partial unique `(project_id, member_id) WHERE member_id IS NOT NULL` — 에이전트 grant 1프로젝트 1행
보장(휴먼은 member_id=org_member_id가 이미 uq_project_access_project_member로 유일이라 충돌 0·additive).

순수 additive·backward-safe(기존 행 제거 0·grant-only 행만 추가). 마이그-first prod 안전.

Revision ID: 0110
Revises: 0109
Create Date: 2026-06-10
"""
import sqlalchemy as sa
from alembic import op

revision = "0110"
down_revision = "0109"
branch_labels = None
depends_on = None

# 0106(human ∪ agent-profile) + agent-grant-only 3번째 브랜치. 컬럼 순서/타입 전 브랜치 동일.
_VIEW_WITH_GRANT = """
CREATE VIEW team_members AS
 SELECT m.id, pa.project_id, m.org_id, m.user_id, m.type, m.name, pa.role,
    m.avatar_url, NULL::jsonb AS agent_config, m.is_active, pa.color,
    NULL::text AS agent_role, NULL::integer AS fakechat_port, owner.user_id AS created_by,
    NULL::timestamptz AS last_seen_at, NULL::uuid AS active_story_id, NULL::text AS agent_status,
    pa.can_manage_members, m.message_policy_mode, m.runtime_type, m.created_at, m.updated_at
   FROM members m
     JOIN project_access pa ON pa.member_id = m.id
     LEFT JOIN members owner ON owner.id = m.owner_member_id
  WHERE m.type = 'human' AND m.deleted_at IS NULL
UNION ALL
 SELECT m.id, app.project_id, m.org_id, m.user_id, m.type, m.name, COALESCE(pa.role, 'member') AS role,
    m.avatar_url, app.agent_config, m.is_active, COALESCE(pa.color, '#3385f8') AS color,
    app.agent_role, app.fakechat_port, owner.user_id AS created_by,
    app.last_seen_at, app.active_story_id, app.agent_status,
    COALESCE(pa.can_manage_members, false) AS can_manage_members, m.message_policy_mode, m.runtime_type,
    m.created_at, m.updated_at
   FROM members m
     JOIN agent_project_profiles app ON app.member_id = m.id
     LEFT JOIN project_access pa ON pa.member_id = m.id AND pa.project_id = app.project_id
     LEFT JOIN members owner ON owner.id = m.owner_member_id
  WHERE m.type = 'agent' AND m.deleted_at IS NULL
UNION ALL
 SELECT m.id, pa.project_id, m.org_id, m.user_id, m.type, m.name, COALESCE(pa.role, 'member') AS role,
    m.avatar_url, NULL::jsonb AS agent_config, m.is_active, COALESCE(pa.color, '#3385f8') AS color,
    NULL::text AS agent_role, NULL::integer AS fakechat_port, owner.user_id AS created_by,
    NULL::timestamptz AS last_seen_at, NULL::uuid AS active_story_id, NULL::text AS agent_status,
    COALESCE(pa.can_manage_members, false) AS can_manage_members, m.message_policy_mode, m.runtime_type,
    m.created_at, m.updated_at
   FROM members m
     JOIN project_access pa ON pa.member_id = m.id AND pa.permission = 'granted'
     LEFT JOIN agent_project_profiles app ON app.member_id = m.id AND app.project_id = pa.project_id
     LEFT JOIN members owner ON owner.id = m.owner_member_id
  WHERE m.type = 'agent' AND m.deleted_at IS NULL AND app.project_id IS NULL
"""

# 0106 원본(human ∪ agent-profile) — downgrade 복원용.
_VIEW_0106 = """
CREATE VIEW team_members AS
 SELECT m.id, pa.project_id, m.org_id, m.user_id, m.type, m.name, pa.role,
    m.avatar_url, NULL::jsonb AS agent_config, m.is_active, pa.color,
    NULL::text AS agent_role, NULL::integer AS fakechat_port, owner.user_id AS created_by,
    NULL::timestamptz AS last_seen_at, NULL::uuid AS active_story_id, NULL::text AS agent_status,
    pa.can_manage_members, m.message_policy_mode, m.runtime_type, m.created_at, m.updated_at
   FROM members m
     JOIN project_access pa ON pa.member_id = m.id
     LEFT JOIN members owner ON owner.id = m.owner_member_id
  WHERE m.type = 'human' AND m.deleted_at IS NULL
UNION ALL
 SELECT m.id, app.project_id, m.org_id, m.user_id, m.type, m.name, COALESCE(pa.role, 'member') AS role,
    m.avatar_url, app.agent_config, m.is_active, COALESCE(pa.color, '#3385f8') AS color,
    app.agent_role, app.fakechat_port, owner.user_id AS created_by,
    app.last_seen_at, app.active_story_id, app.agent_status,
    COALESCE(pa.can_manage_members, false) AS can_manage_members, m.message_policy_mode, m.runtime_type,
    m.created_at, m.updated_at
   FROM members m
     JOIN agent_project_profiles app ON app.member_id = m.id
     LEFT JOIN project_access pa ON pa.member_id = m.id AND pa.project_id = app.project_id
     LEFT JOIN members owner ON owner.id = m.owner_member_id
  WHERE m.type = 'agent' AND m.deleted_at IS NULL
"""


def upgrade() -> None:
    op.execute("DROP VIEW team_members")
    op.execute(_VIEW_WITH_GRANT)
    op.create_index(
        "uq_project_access_project_member_id",
        "project_access",
        ["project_id", "member_id"],
        unique=True,
        postgresql_where=sa.text("member_id IS NOT NULL"),
    )


def downgrade() -> None:
    op.drop_index("uq_project_access_project_member_id", table_name="project_access")
    op.execute("DROP VIEW team_members")
    op.execute(_VIEW_0106)
