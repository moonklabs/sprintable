"""add attachments to stories

E-FILE S4: 보드 스토리 첨부. stories에 attachments JSONB(chat 0093과 동형) 추가.
additive(nullable + server_default '[]')라 공유 dev/prod DB에서 breaking 아님.

⚠️ 스키마 추가 — deploy-before-migrate 주의. 머지 전 윈도우0 pre-apply 권장(#1203 패턴).

Revision ID: 0095
Revises: 0094
Create Date: 2026-06-04
"""
import sqlalchemy as sa
from alembic import op
from sqlalchemy.dialects.postgresql import JSONB

revision = "0095"
down_revision = "0094"
branch_labels = None
depends_on = None


def upgrade() -> None:
    op.add_column(
        "stories",
        sa.Column("attachments", JSONB, nullable=True, server_default=sa.text("'[]'")),
    )


def downgrade() -> None:
    op.drop_column("stories", "attachments")
