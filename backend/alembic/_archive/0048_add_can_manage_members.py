"""team_members 테이블에 can_manage_members 컬럼 추가 (E-AGENT-PERMISSION AP-S1)

Revision ID: 0048
Revises: 0047
"""
from alembic import op
import sqlalchemy as sa

revision = "0048"
down_revision = "0047"
branch_labels = None
depends_on = None


def upgrade() -> None:
    op.add_column(
        "team_members",
        sa.Column("can_manage_members", sa.Boolean(), nullable=False, server_default="false"),
    )


def downgrade() -> None:
    op.drop_column("team_members", "can_manage_members")
