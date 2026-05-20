"""add project_access table for per-project permission control (E-ENTITY-CLEANUP S3)

Revision ID: 0044
Revises: 0043
Create Date: 2026-05-20

기본 정책: 레코드 없음 = 접근 허용 (opt-out 모델).
기존 team_members(type=human) 데이터를 project_access로 변환.
"""
import sqlalchemy as sa
from alembic import op

revision = "0044"
down_revision = "0043"
branch_labels = None
depends_on = None


def upgrade() -> None:
    # org_members.id에 PK constraint가 없으면 추가 (Supabase 생성 테이블 보정)
    op.execute(
        """
        DO $$
        BEGIN
            IF NOT EXISTS (
                SELECT 1 FROM pg_constraint
                WHERE conrelid = 'org_members'::regclass
                  AND contype = 'p'
            ) THEN
                ALTER TABLE org_members ADD PRIMARY KEY (id);
            END IF;
        END
        $$;
        """
    )

    op.create_table(
        "project_access",
        sa.Column("id", sa.UUID(as_uuid=True), primary_key=True, server_default=sa.text("gen_random_uuid()")),
        sa.Column("project_id", sa.UUID(as_uuid=True), sa.ForeignKey("projects.id", ondelete="CASCADE"), nullable=False),
        sa.Column("org_member_id", sa.UUID(as_uuid=True), sa.ForeignKey("org_members.id", ondelete="CASCADE"), nullable=False),
        sa.Column("permission", sa.Text, nullable=False, server_default="member"),
        sa.Column("created_at", sa.DateTime(timezone=True), server_default=sa.func.now(), nullable=False),
    )
    op.create_index("ix_project_access_project_id", "project_access", ["project_id"])
    op.create_index("ix_project_access_org_member_id", "project_access", ["org_member_id"])
    op.create_unique_constraint(
        "uq_project_access_project_member", "project_access", ["project_id", "org_member_id"]
    )

    # 기존 team_members(type=human) → project_access 데이터 변환
    op.execute(
        """
        INSERT INTO project_access (project_id, org_member_id, permission, created_at)
        SELECT DISTINCT
            tm.project_id,
            om.id,
            'member',
            NOW()
        FROM team_members tm
        JOIN org_members om
            ON om.user_id = tm.user_id
            AND om.org_id = tm.org_id
            AND om.deleted_at IS NULL
        WHERE tm.type = 'human'
          AND tm.project_id IS NOT NULL
          AND tm.user_id IS NOT NULL
          AND tm.is_active = TRUE
        ON CONFLICT (project_id, org_member_id) DO NOTHING
        """
    )


def downgrade() -> None:
    op.drop_table("project_access")
