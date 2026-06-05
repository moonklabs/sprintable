"""add project_ids to org_invites

E-ONBOARDING 정책B(초대 시 프로젝트 선택 부여): 초대 생성 시 선택한 프로젝트 ids를 저장해
accept 시 해당 프로젝트에 project_access(granted)를 부여한다. additive(nullable + server_default '[]')라
공유/기존 DB에서 breaking 아님 — 기존 초대는 '[]'(org-only).

⚠️ 스키마 추가 — deploy-before-migrate 주의. 머지 후 migrate 선행 권장.

Revision ID: 0097
Revises: 0096
Create Date: 2026-06-05
"""
import sqlalchemy as sa
from alembic import op
from sqlalchemy.dialects.postgresql import JSONB

revision = "0097"
down_revision = "0096"
branch_labels = None
depends_on = None


def upgrade() -> None:
    op.add_column(
        "org_invites",
        sa.Column("project_ids", JSONB, nullable=True, server_default=sa.text("'[]'")),
    )


def downgrade() -> None:
    op.drop_column("org_invites", "project_ids")
