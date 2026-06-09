"""DROP legacy webhook_url (team_members 뷰 컬럼 + agent_project_profiles 실 컬럼)

1bc9fbae ⑤ cutover: webhook 발송은 webhook_configs 테이블이 canonical(reader 0 확정).
team_member.webhook_url(team_members 뷰 컬럼) + agent_project_profiles.webhook_url(실 컬럼)
레거시를 제거한다.

⚠️ breaking — 뷰 재정의 + 실 컬럼 DROP. reader 0(canonical=webhook_configs)이라 안전하나
deploy-before-migrate 순서 준수: 코드(webhook_url 미참조)가 먼저 배포된 뒤 마이그레이션 적용.

team_members 뷰는 0096(_VIEW_WITH_MODE)에서 webhook_url 2컬럼만 제거해 재생성한다
(나머지 컬럼/순서/JOIN/WHERE/message_policy_mode 전부 동일 유지).

Revision ID: 0103
Revises: 0102
Create Date: 2026-06-08
"""
from alembic import op

revision = "0103"
down_revision = "0102"
branch_labels = None
depends_on = None

# 0096 _VIEW_WITH_MODE 에서 webhook_url 2컬럼(휴먼 NULL::text / 에이전트 app.webhook_url)만 제거.
_VIEW_NO_WEBHOOK = """
CREATE VIEW team_members AS
SELECT
    m.id, pa.project_id, m.org_id, m.user_id, m.type, m.name, pa.role,
    m.avatar_url, NULL::jsonb AS agent_config, m.is_active,
    pa.color, NULL::text AS agent_role, NULL::integer AS fakechat_port,
    owner.user_id AS created_by,
    NULL::timestamptz AS last_seen_at, NULL::uuid AS active_story_id, NULL::text AS agent_status,
    pa.can_manage_members, m.message_policy_mode, m.created_at, m.updated_at
FROM members m
JOIN project_access pa ON pa.member_id = m.id
LEFT JOIN members owner ON owner.id = m.owner_member_id
WHERE m.type = 'human' AND m.deleted_at IS NULL
UNION ALL
SELECT
    m.id, app.project_id, m.org_id, m.user_id, m.type, m.name, COALESCE(pa.role, 'member') AS role,
    m.avatar_url, app.agent_config, m.is_active,
    COALESCE(pa.color, '#3385f8') AS color, app.agent_role, app.fakechat_port,
    owner.user_id AS created_by,
    app.last_seen_at, app.active_story_id, app.agent_status,
    COALESCE(pa.can_manage_members, false) AS can_manage_members, m.message_policy_mode,
    m.created_at, m.updated_at
FROM members m
JOIN agent_project_profiles app ON app.member_id = m.id
LEFT JOIN project_access pa ON pa.member_id = m.id AND pa.project_id = app.project_id
LEFT JOIN members owner ON owner.id = m.owner_member_id
WHERE m.type = 'agent' AND m.deleted_at IS NULL
"""

# downgrade 복원용 — 0096 _VIEW_WITH_MODE 원본(webhook_url 2컬럼 포함).
_VIEW_WITH_MODE = """
CREATE VIEW team_members AS
SELECT
    m.id, pa.project_id, m.org_id, m.user_id, m.type, m.name, pa.role,
    m.avatar_url, NULL::jsonb AS agent_config, NULL::text AS webhook_url, m.is_active,
    pa.color, NULL::text AS agent_role, NULL::integer AS fakechat_port,
    owner.user_id AS created_by,
    NULL::timestamptz AS last_seen_at, NULL::uuid AS active_story_id, NULL::text AS agent_status,
    pa.can_manage_members, m.message_policy_mode, m.created_at, m.updated_at
FROM members m
JOIN project_access pa ON pa.member_id = m.id
LEFT JOIN members owner ON owner.id = m.owner_member_id
WHERE m.type = 'human' AND m.deleted_at IS NULL
UNION ALL
SELECT
    m.id, app.project_id, m.org_id, m.user_id, m.type, m.name, COALESCE(pa.role, 'member') AS role,
    m.avatar_url, app.agent_config, app.webhook_url, m.is_active,
    COALESCE(pa.color, '#3385f8') AS color, app.agent_role, app.fakechat_port,
    owner.user_id AS created_by,
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
    # 1) team_members 뷰 재생성 — webhook_url 2컬럼 제거
    op.execute("DROP VIEW team_members")
    op.execute(_VIEW_NO_WEBHOOK)
    # 2) agent_project_profiles 실 컬럼 DROP
    op.execute("ALTER TABLE agent_project_profiles DROP COLUMN IF EXISTS webhook_url")


def downgrade() -> None:
    # 역순: 실 컬럼 복원 → 뷰 webhook_url 포함 원복
    op.execute("ALTER TABLE agent_project_profiles ADD COLUMN webhook_url text")
    op.execute("DROP VIEW team_members")
    op.execute(_VIEW_WITH_MODE)
