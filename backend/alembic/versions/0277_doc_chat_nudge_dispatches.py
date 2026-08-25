"""story #2747 QA delta(카디르·페드루, 2026-08-25) — draft doc 채팅넛지 1회성 anchor.

최초 구현(DM 메시지 로그 SSOT)이 키 축 오류(DM당 1회≠작성자당 전역 1회)+동시성 미보장
(SELECT→INSERT SAVEPOINT는 격리가 아님)이었음 — uq(org_id, doc_id) UNIQUE 제약으로
"이 doc에 넛지를 발송하겠다"는 사실 자체를 원자적 reservation row로 만든다.

Revision ID: 0277
Revises: 0276
Create Date: 2026-08-25
"""
from __future__ import annotations

import sqlalchemy as sa
from alembic import op
from sqlalchemy.dialects import postgresql

revision = "0277"
down_revision = "0276"
branch_labels = None
depends_on = None


def upgrade() -> None:
    op.create_table(
        "doc_chat_nudge_dispatches",
        sa.Column("id", postgresql.UUID(as_uuid=True), primary_key=True),
        sa.Column(
            "org_id", postgresql.UUID(as_uuid=True),
            sa.ForeignKey("organizations.id", ondelete="CASCADE"), nullable=False,
        ),
        sa.Column(
            "doc_id", postgresql.UUID(as_uuid=True),
            sa.ForeignKey("docs.id", ondelete="CASCADE"), nullable=False,
        ),
        sa.Column("author_id", postgresql.UUID(as_uuid=True), nullable=False),
        sa.Column("conversation_id", postgresql.UUID(as_uuid=True), nullable=True),
        sa.Column("message_id", postgresql.UUID(as_uuid=True), nullable=True),
        sa.Column("created_at", sa.DateTime(timezone=True), nullable=False, server_default=sa.func.now()),
        sa.UniqueConstraint("org_id", "doc_id", name="uq_doc_chat_nudge_dispatch_org_doc"),
    )
    op.create_index(
        "ix_doc_chat_nudge_dispatches_org_id", "doc_chat_nudge_dispatches", ["org_id"],
    )


def downgrade() -> None:
    op.drop_index("ix_doc_chat_nudge_dispatches_org_id", table_name="doc_chat_nudge_dispatches")
    op.drop_table("doc_chat_nudge_dispatches")
