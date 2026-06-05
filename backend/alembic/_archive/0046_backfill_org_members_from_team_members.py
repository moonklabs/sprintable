"""backfill org_members from team_members(human) — fix missing membership records (E-ENTITY-CLEANUP S7)

Revision ID: 0046
Revises: 0045
Create Date: 2026-05-20

E-ENTITY-CLEANUP으로 OrgMember가 단일 멤버십 소스가 됐으나,
기존 team_members(type=human)에만 존재하고 org_members에 없는 유저 존재.
이 migration으로 해당 유저를 org_members에 backfill.
"""
import sqlalchemy as sa
from alembic import op

revision = "0046"
down_revision = "0045"
branch_labels = None
depends_on = None


def upgrade() -> None:
    # team_members(human, active)에 있지만 org_members에 없는 유저 backfill
    op.execute(
        """
        INSERT INTO org_members (id, org_id, user_id, role, created_at)
        SELECT DISTINCT
            gen_random_uuid(),
            tm.org_id,
            tm.user_id,
            'member',
            NOW()
        FROM team_members tm
        WHERE tm.type = 'human'
          AND tm.is_active = TRUE
          AND tm.user_id IS NOT NULL
          AND NOT EXISTS (
              SELECT 1 FROM org_members om
              WHERE om.org_id = tm.org_id
                AND om.user_id = tm.user_id
          )
        ON CONFLICT (org_id, user_id) DO NOTHING
        """
    )


def downgrade() -> None:
    # backfill로 추가된 org_member는 특정 식별이 불가하여 rollback 생략
    # (기존 데이터와 구분 불가 — 수동 롤백 필요)
    pass
