"""E-MEMBER-SSOT AC3-4 2-1: window agent project_access placement 백필.

AC3-4 뷰가 에이전트 role/can_manage를 project_access(placement)서 읽는다(런타임은 agent_project_profiles
LEFT JOIN). 0075 §5가 기존 agent placement를 만들었으나, 0075↔AC3-1b write-sync 사이 window agent +
write-sync에 placement 미포함이던 신규 agent는 placement 누락 가능. create write-sync(2-1)에 placement를
추가했고, 이 마이그는 기존 누락분 소급 백필(0075 §5 동형, idempotent).

조건: type='agent' active + members 존재(0082 보정분) + placement 미존재. ON CONFLICT 대신 NOT EXISTS 가드.
orphan-safe. 추가형·가역(no-op down — 정상 placement와 구분 불가).

Revision ID: 0087
Revises: 0086
Create Date: 2026-06-04
"""
from __future__ import annotations

from alembic import op

revision = "0087"
down_revision = "0086"
branch_labels = None
depends_on = None


def upgrade() -> None:
    op.execute(
        """
        INSERT INTO project_access
            (id, project_id, org_member_id, member_id, permission, role, color, can_manage_members, access_source, created_at)
        SELECT gen_random_uuid(), tm.project_id, NULL, tm.id, 'granted', tm.role, tm.color,
               tm.can_manage_members, 'direct', tm.created_at
        FROM team_members tm
        WHERE tm.type = 'agent' AND tm.is_active = true
          AND EXISTS (SELECT 1 FROM members m WHERE m.id = tm.id)
          AND NOT EXISTS (
              SELECT 1 FROM project_access pa WHERE pa.project_id = tm.project_id AND pa.member_id = tm.id
          )
        """
    )


def downgrade() -> None:
    # 데이터 백필(0075 §5 동형) — 역삭제는 정상 placement와 구분 불가. no-op.
    pass
