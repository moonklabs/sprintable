"""add fakechat_port to team_members (S-D3)

Revision ID: 0037
Revises: 0036
Create Date: 2026-05-15
"""
import sqlalchemy as sa
from alembic import op

revision = "0037"
down_revision = "0036"
branch_labels = None
depends_on = None


def upgrade() -> None:
    op.add_column("team_members", sa.Column("fakechat_port", sa.Integer(), nullable=True))
    # AC2: project 내 중복 port 방지 (agent type + non-null port)
    op.create_index(
        "uq_team_members_project_fakechat_port",
        "team_members",
        ["project_id", "fakechat_port"],
        unique=True,
        postgresql_where=sa.text("fakechat_port IS NOT NULL"),
    )


def downgrade() -> None:
    op.drop_index("uq_team_members_project_fakechat_port", table_name="team_members")
    op.drop_column("team_members", "fakechat_port")
