"""story #1993(E-KNOWLEDGE-LINK S1) — mentions 정규화 테이블. 근본 설계 doc
design-org-knowledge-mentions-backlinks §1. source(chat_message|doc)가 target(doc·
story/epic CHECK 여지만 열어둠·gate 제외)을 멘션한 사실을 기록하는 순수 링크 테이블.
백링크 조회(ix_mentions_target)·source 정합(ix_mentions_source)·UNIQUE(source,target)
로 중복 방지. 이번 스토리의 write-path 파서는 target_type='doc'만 실제로 채운다
(story/epic 은 스키마 레벨 여지만 — 파서 미구현, 과확장 금지).

Revision ID: 0200
Revises: 0199
Create Date: 2026-07-18
"""
from __future__ import annotations

from alembic import op
import sqlalchemy as sa
from sqlalchemy.dialects import postgresql

revision = "0200"
down_revision = "0199"
branch_labels = None
depends_on = None


def upgrade() -> None:
    op.create_table(
        "mentions",
        sa.Column("id", postgresql.UUID(as_uuid=True), primary_key=True),
        sa.Column("org_id", postgresql.UUID(as_uuid=True), nullable=False),
        sa.Column("source_type", sa.Text(), nullable=False),
        sa.Column("source_id", postgresql.UUID(as_uuid=True), nullable=False),
        sa.Column("target_type", sa.Text(), nullable=False),
        sa.Column("target_id", postgresql.UUID(as_uuid=True), nullable=False),
        sa.Column("created_by", postgresql.UUID(as_uuid=True), nullable=True),
        sa.Column("created_at", sa.DateTime(timezone=True), server_default=sa.func.now(), nullable=False),
        sa.UniqueConstraint(
            "source_type", "source_id", "target_type", "target_id",
            name="uq_mentions_source_target",
        ),
        sa.CheckConstraint(
            "source_type IN ('chat_message', 'doc')", name="ck_mentions_source_type",
        ),
        sa.CheckConstraint(
            "target_type IN ('doc', 'story', 'epic')", name="ck_mentions_target_type",
        ),
    )
    op.create_index("ix_mentions_org_id", "mentions", ["org_id"])
    # 백링크 조회용(target doc 이 자신을 멘션한 source 들을 최신순으로): target_type+target_id+created_at DESC.
    op.create_index(
        "ix_mentions_target", "mentions",
        ["target_type", "target_id", sa.text("created_at DESC")],
    )
    # source 정합(한 chat_message/doc 이 만든 mentions 재조회 — doc diff reconcile 의 existing-set 조회 축).
    op.create_index("ix_mentions_source", "mentions", ["source_type", "source_id"])


def downgrade() -> None:
    op.drop_index("ix_mentions_source", table_name="mentions")
    op.drop_index("ix_mentions_target", table_name="mentions")
    op.drop_index("ix_mentions_org_id", table_name="mentions")
    op.drop_table("mentions")
