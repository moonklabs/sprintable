"""team_members(human)에 있지만 org_members에 없는 사용자 backfill (S-MBR-01)

Revision ID: 0052
Revises: 0051
"""
import sqlalchemy as sa
from alembic import op

revision = "0052"
down_revision = "0051"
branch_labels = None
depends_on = None


def upgrade() -> None:
    op.execute(
        sa.text(
            """
            INSERT INTO org_members (id, org_id, user_id, role, created_at)
            SELECT DISTINCT ON (tm.org_id, tm.user_id)
                gen_random_uuid(),
                tm.org_id,
                tm.user_id,
                'member',
                NOW()
            FROM team_members tm
            WHERE
                tm.type = 'human'
                AND tm.user_id IS NOT NULL
                AND NOT EXISTS (
                    SELECT 1
                    FROM org_members om
                    WHERE om.org_id = tm.org_id
                      AND om.user_id = tm.user_id
                      AND om.deleted_at IS NULL
                )
            ON CONFLICT (org_id, user_id) DO NOTHING
            """
        )
    )


def downgrade() -> None:
    # 데이터 이관 마이그레이션 — 어떤 레코드가 이 migration으로 삽입됐는지
    # 추적 불가하므로 rollback 미지원
    pass
