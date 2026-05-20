"""fix project_access permission values: member→allowed, blocked→denied (E-ENTITY-CLEANUP S3 spec)

Revision ID: 0045
Revises: 0044
Create Date: 2026-05-20

0044에서 permission DEFAULT 'member' / 'blocked' 값을 사용했으나
S3 전체 스펙 기준은 'allowed' | 'denied' (DEFAULT 'allowed').
"""
import sqlalchemy as sa
from alembic import op

revision = "0045"
down_revision = "0044"
branch_labels = None
depends_on = None


def upgrade() -> None:
    # 기존 데이터 변환: member → allowed, blocked → denied
    op.execute("UPDATE project_access SET permission = 'allowed' WHERE permission = 'member'")
    op.execute("UPDATE project_access SET permission = 'denied' WHERE permission = 'blocked'")
    # 컬럼 서버 기본값 변경
    op.alter_column(
        "project_access",
        "permission",
        server_default="allowed",
        existing_type=sa.Text,
        existing_nullable=False,
    )


def downgrade() -> None:
    op.execute("UPDATE project_access SET permission = 'member' WHERE permission = 'allowed'")
    op.execute("UPDATE project_access SET permission = 'blocked' WHERE permission = 'denied'")
    op.alter_column(
        "project_access",
        "permission",
        server_default="member",
        existing_type=sa.Text,
        existing_nullable=False,
    )
