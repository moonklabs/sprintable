"""0053 backfill 재시도 — ON CONFLICT DO UPDATE로 soft-delete 차단 우회 (S-MBR-01 fix2)

Revision ID: 0054
Revises: 0053

0053은 두 단계(UPDATE 복구 → INSERT DO NOTHING)로 처리했는데 여전히 0건.
원인: soft-deleted 레코드가 unique constraint를 점유하면 ON CONFLICT DO NOTHING이
INSERT를 조용히 건너뜀.
이 migration은 DO UPDATE SET deleted_at = NULL 단일 쿼리로
신규 삽입과 soft-delete 복구를 동시에 처리한다.
"""
import sqlalchemy as sa
from alembic import op

revision = "0054"
down_revision = "0053"
branch_labels = None
depends_on = None


def upgrade() -> None:
    conn = op.get_bind()

    # UPSERT: 신규 레코드 INSERT + soft-deleted 레코드 복구를 단일 문으로 처리
    result = conn.execute(
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
                    SELECT 1 FROM org_members om
                    WHERE om.org_id = tm.org_id
                      AND om.user_id = tm.user_id
                      AND om.deleted_at IS NULL
                )
            ON CONFLICT (org_id, user_id) DO UPDATE
                SET deleted_at = NULL
            """
        )
    )
    print(f"[0054] upserted {result.rowcount} org_member(s) (insert or soft-delete restore)")


def downgrade() -> None:
    pass
