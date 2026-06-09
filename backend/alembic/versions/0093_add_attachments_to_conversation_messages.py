"""add attachments to conversation_messages

E-FILE S2: 채팅 메시지 첨부 저장용 attachments JSONB 컬럼 추가.
additive(nullable + server_default '[]')라 공유 dev/prod DB에서 breaking 아님 —
기존 행은 server_default로 '[]' 채워지고, 구버전 앱 코드도 attachments 미지정 INSERT 안전.

story 첨부(stories 컬럼 vs story_attachments 테이블)는 E-FILE S4 모델 확정 후
sibling rev로 별도 추가 (PO 지침).

Revision ID: 0093
Revises: 0092
Create Date: 2026-06-04
"""
import sqlalchemy as sa
from alembic import op
from sqlalchemy.dialects.postgresql import JSONB

revision = "0093"
down_revision = "0092"
branch_labels = None
depends_on = None


def upgrade() -> None:
    op.add_column(
        "conversation_messages",
        sa.Column("attachments", JSONB, nullable=True, server_default=sa.text("'[]'")),
    )


def downgrade() -> None:
    op.drop_column("conversation_messages", "attachments")
