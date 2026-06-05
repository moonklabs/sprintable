"""E-MEMBER-SSOT AC3-4 2-2: team_members 물리테이블 → members 기반 projection 뷰 강등.

곱연산 물리 소거. team_members를 team_members_legacy로 rename하고, members/project_access/
agent_project_profiles 기반 VIEW로 재정의. 2-1 dual-write로 anchor가 이미 최신이라 안전. READ는 뷰로
투명 동작(19컬럼 전 재현). write는 코드에서 anchor-only로 전환(같은 PR).

뷰 멤버십(의도된 SSOT): 휴먼=project_access 보유분(grant-only 출현·access 회수 시 live 제외),
에이전트=agent_project_profiles per-project(1:1). created_by = owner.user_id(D1: 옛 auth.user_id 동일값
재현, FE 소유자 배지 무변경).

⚠️ 가역(G5): downgrade = DROP VIEW + team_members_legacy → team_members rename 복원.

Revision ID: 0088
Revises: 0087
Create Date: 2026-06-04
"""
from __future__ import annotations

from alembic import op

revision = "0088"
down_revision = "0087"
branch_labels = None
depends_on = None

# team_members 19 식별/속성 컬럼 + created_at/updated_at = 21. 모델 컬럼명과 동일해야 ORM 매핑.
_CREATE_VIEW = """
CREATE VIEW team_members AS
-- 휴먼: members ⋈ project_access (per-project). agent 런타임 컬럼은 NULL.
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
-- 에이전트: members ⋈ agent_project_profiles (per-project runtime) LEFT JOIN project_access (role/color).
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
    op.execute("ALTER TABLE team_members RENAME TO team_members_legacy")
    op.execute(_CREATE_VIEW)


def downgrade() -> None:
    # G5 가역: 뷰 제거 후 물리테이블 복원.
    op.execute("DROP VIEW IF EXISTS team_members")
    op.execute("ALTER TABLE team_members_legacy RENAME TO team_members")
