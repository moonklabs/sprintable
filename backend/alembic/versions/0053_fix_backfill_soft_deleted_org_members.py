"""0052 backfill 보정 — soft-deleted org_members 복구 포함 (S-MBR-01 fix)

Revision ID: 0053
Revises: 0052

0052는 ON CONFLICT DO NOTHING 때문에 soft-deleted 레코드가 unique constraint와
충돌하면 INSERT를 건너뜀. 이 migration에서 soft-deleted 레코드를 복구하고
신규 레코드도 INSERT.
"""
import sqlalchemy as sa
from alembic import op

revision = "0053"
down_revision = "0052"
branch_labels = None
depends_on = None


def upgrade() -> None:
    conn = op.get_bind()

    # soft-deleted 레코드 복구: deleted_at → NULL
    result = conn.execute(
        sa.text(
            """
            UPDATE org_members om
            SET deleted_at = NULL
            FROM team_members tm
            WHERE om.org_id = tm.org_id
              AND om.user_id = tm.user_id
              AND om.deleted_at IS NOT NULL
              AND tm.type = 'human'
              AND tm.user_id IS NOT NULL
            """
        )
    )
    if result.rowcount:
        print(f"[0053] restored {result.rowcount} soft-deleted org_member(s)")

    # 0052가 놓쳤을 수 있는 신규 레코드 INSERT (멱등)
    result2 = conn.execute(
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
            ON CONFLICT (org_id, user_id) DO NOTHING
            """
        )
    )
    if result2.rowcount:
        print(f"[0053] inserted {result2.rowcount} missing org_member(s)")


def downgrade() -> None:
    pass
