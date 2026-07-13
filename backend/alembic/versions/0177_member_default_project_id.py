"""E-MCP-OPT(story ff6cb90d·doc mcp-multiproject-scoping-design §3) — members.default_project_id.

Revision ID: 0177
Revises: 0176
Create Date: 2026-07-13

멀티프로젝트 MCP 키의 "기본 프로젝트" 서버 저장(감사 가능). 순수 additive nullable FK —
기존 member 전부 무영향. FK 부여(P0-03의 human_owner_member_id와 달리 이번엔 타당 — projects는
VIEW/멀티테이블 해소가 아닌 안정된 단일 물리 테이블, member_id도 anchor로 안정).
"""
from __future__ import annotations

from alembic import op
import sqlalchemy as sa
from sqlalchemy.dialects import postgresql

revision = "0177"
down_revision = "0176"
branch_labels = None
depends_on = None


def upgrade() -> None:
    op.add_column(
        "members",
        sa.Column("default_project_id", postgresql.UUID(as_uuid=True), nullable=True),
    )
    op.create_foreign_key(
        "fk_members_default_project_id_projects",
        "members", "projects",
        ["default_project_id"], ["id"],
        ondelete="SET NULL",
    )


def downgrade() -> None:
    op.drop_constraint("fk_members_default_project_id_projects", "members", type_="foreignkey")
    op.drop_column("members", "default_project_id")
