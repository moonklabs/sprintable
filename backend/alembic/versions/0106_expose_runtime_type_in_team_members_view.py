"""team_members projection 뷰에 members.runtime_type 노출 (E-CHAT-CMD S1b).

⚠️ team_members 는 0088 projection VIEW(members ⋈ project_access / agent_project_profiles).
0105 에서 canonical `members.runtime_type` 컬럼을 추가했으나 뷰에 미노출 → team-members GET/PATCH
경로(에이전트 read/write 표면)서 보이지 않음. message_policy_mode(0096) 선례 동형으로 뷰를 현재
(0105) 정의 그대로 + `m.runtime_type` 1컬럼만 더해 **재생성**(read 투명 재현, write 는 anchor
라우팅으로 members 에 기록).

순수 read 추가 — additive. 휴먼은 runtime_type NULL(미설정), 에이전트는 설정값. 다른 컬럼 불변.

Revision ID: 0106
Revises: 0105
Create Date: 2026-06-09
"""
from alembic import op

revision = "0106"
down_revision = "0105"
branch_labels = None
depends_on = None

# 0105 정의 + m.runtime_type (두 UNION 브랜치 동일 위치 — message_policy_mode 뒤).
_VIEW_WITH_RUNTIME = """
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

# 0105 원본(runtime_type 없음) — downgrade 복원용.
_VIEW_0105 = """
CREATE VIEW team_members AS
 SELECT m.id, pa.project_id, m.org_id, m.user_id, m.type, m.name, pa.role,
    m.avatar_url, NULL::jsonb AS agent_config, m.is_active, pa.color,
    NULL::text AS agent_role, NULL::integer AS fakechat_port, owner.user_id AS created_by,
    NULL::timestamptz AS last_seen_at, NULL::uuid AS active_story_id, NULL::text AS agent_status,
    pa.can_manage_members, m.message_policy_mode, m.created_at, m.updated_at
   FROM members m
     JOIN project_access pa ON pa.member_id = m.id
     LEFT JOIN members owner ON owner.id = m.owner_member_id
  WHERE m.type = 'human' AND m.deleted_at IS NULL
UNION ALL
 SELECT m.id, app.project_id, m.org_id, m.user_id, m.type, m.name, COALESCE(pa.role, 'member') AS role,
    m.avatar_url, app.agent_config, m.is_active, COALESCE(pa.color, '#3385f8') AS color,
    app.agent_role, app.fakechat_port, owner.user_id AS created_by,
    app.last_seen_at, app.active_story_id, app.agent_status,
    COALESCE(pa.can_manage_members, false) AS can_manage_members, m.message_policy_mode,
    m.created_at, m.updated_at
   FROM members m
     JOIN agent_project_profiles app ON app.member_id = m.id
     LEFT JOIN project_access pa ON pa.member_id = m.id AND pa.project_id = app.project_id
     LEFT JOIN members owner ON owner.id = m.owner_member_id
  WHERE m.type = 'agent' AND m.deleted_at IS NULL
"""


def upgrade() -> None:
    op.execute("DROP VIEW team_members")
    op.execute(_VIEW_WITH_RUNTIME)


def downgrade() -> None:
    op.execute("DROP VIEW team_members")
    op.execute(_VIEW_0105)
