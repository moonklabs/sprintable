"""agent message policy mode + allowlist (members col + team_members view recreate)

E-MSG-POLICY S1: 공용 에이전트 메시징 정책. mode(creator_only default|org_wide|list) + allowlist.

⚠️ team_members는 0088(E-MEMBER-SSOT)에서 **projection VIEW로 강등**됨(members ⋈ project_access/
agent_project_profiles). 따라서 컬럼은 canonical `members` 테이블에 추가하고, team_members 뷰를
0088 정의 그대로 + `message_policy_mode` 1컬럼만 더해 **재생성**한다(read 투명 재현).

additive: members 컬럼 NOT NULL + server_default 'creator_only'(기존 에이전트 백필=현행 동작 불변).
agent_message_allowlist는 실 테이블 신설. 기존 코드는 새 컬럼/테이블 미참조.

⚠️ 스키마 추가 + core 뷰 재생성 — deploy-before-migrate 주의. 머지 전 window-0 pre-apply.

Revision ID: 0096
Revises: 0095
Create Date: 2026-06-04
"""
import sqlalchemy as sa
from alembic import op
from sqlalchemy.dialects.postgresql import UUID

revision = "0096"
down_revision = "0095"
branch_labels = None
depends_on = None

# 0088 정의 + message_policy_mode (두 UNION 브랜치 동일 위치, can_manage_members 뒤).
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

# 0088 원본(message_policy_mode 없음) — downgrade 복원용.
_VIEW_0088 = """
CREATE VIEW team_members AS
SELECT
    m.id, pa.project_id, m.org_id, m.user_id, m.type, m.name, pa.role,
    m.avatar_url, NULL::jsonb AS agent_config, NULL::text AS webhook_url, m.is_active,
    pa.color, NULL::text AS agent_role, NULL::integer AS fakechat_port,
    owner.user_id AS created_by,
    NULL::timestamptz AS last_seen_at, NULL::uuid AS active_story_id, NULL::text AS agent_status,
    pa.can_manage_members, m.created_at, m.updated_at
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
    COALESCE(pa.can_manage_members, false) AS can_manage_members, m.created_at, m.updated_at
FROM members m
JOIN agent_project_profiles app ON app.member_id = m.id
LEFT JOIN project_access pa ON pa.member_id = m.id AND pa.project_id = app.project_id
LEFT JOIN members owner ON owner.id = m.owner_member_id
WHERE m.type = 'agent' AND m.deleted_at IS NULL
"""


def upgrade() -> None:
    # 1) canonical members에 정책 모드 (기존 행 백필 creator_only → 동작 불변)
    op.add_column(
        "members",
        sa.Column("message_policy_mode", sa.Text(), nullable=False, server_default="creator_only"),
    )
    # 2) team_members projection 뷰 재생성 (0088 + message_policy_mode)
    op.execute("DROP VIEW team_members")
    op.execute(_VIEW_WITH_MODE)
    # 3) list 모드 허용 대상 (실 테이블)
    op.create_table(
        "agent_message_allowlist",
        sa.Column("id", UUID(as_uuid=True), primary_key=True),
        sa.Column("agent_member_id", UUID(as_uuid=True), nullable=False),
        sa.Column("allowed_id", UUID(as_uuid=True), nullable=False),
        sa.Column("org_id", UUID(as_uuid=True), nullable=False),
        sa.Column("created_at", sa.DateTime(timezone=True), server_default=sa.text("now()"), nullable=False),
        sa.Column("updated_at", sa.DateTime(timezone=True), server_default=sa.text("now()"), nullable=False),
        sa.UniqueConstraint("agent_member_id", "allowed_id", name="uq_agent_message_allowlist_pair"),
    )
    op.create_index(
        "ix_agent_message_allowlist_agent", "agent_message_allowlist", ["agent_member_id"]
    )


def downgrade() -> None:
    op.drop_index("ix_agent_message_allowlist_agent", table_name="agent_message_allowlist")
    op.drop_table("agent_message_allowlist")
    op.execute("DROP VIEW team_members")
    op.execute(_VIEW_0088)
    op.drop_column("members", "message_policy_mode")
