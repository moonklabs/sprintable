"""E-SPRINT-LOOP a4acc4d0: hypothesis_sprint_links 조인 테이블 (N:1).

Revision ID: 0154
Revises: 0153
Create Date: 2026-07-03

hypothesis_epic_links/hypothesis_story_links(0113) 패턴 미러. epic/story와 달리
(hypothesis_id, target_id) 쌍이 아니라 hypothesis_id 단독 unique — 가설은 정확히
1개 sprint에만 링크된다(PO crux 2026-07-03: sprint=시간상자, cross-sprint 복리는
회수로 성립하므로 멀티링크 불요). idempotent: 테이블 단위 inspect 가드(0113 선례).
"""
from __future__ import annotations

import sqlalchemy as sa
from alembic import op
from sqlalchemy.dialects.postgresql import UUID

revision = "0154"
down_revision = "0153"
branch_labels = None
depends_on = None


def upgrade() -> None:
    conn = op.get_bind()
    insp = sa.inspect(conn)
    existing = set(insp.get_table_names())

    if "hypothesis_sprint_links" not in existing:
        op.create_table(
            "hypothesis_sprint_links",
            sa.Column("id", UUID(as_uuid=True), primary_key=True),
            sa.Column(
                "hypothesis_id",
                UUID(as_uuid=True),
                sa.ForeignKey("hypotheses.id", ondelete="CASCADE"),
                nullable=False,
            ),
            sa.Column(
                "sprint_id",
                UUID(as_uuid=True),
                sa.ForeignKey("sprints.id", ondelete="CASCADE"),
                nullable=False,
            ),
            sa.Column("link_type", sa.String(24), nullable=False, server_default="declared"),
            sa.Column(
                "created_at",
                sa.DateTime(timezone=True),
                server_default=sa.func.now(),
                nullable=False,
            ),
            sa.UniqueConstraint("hypothesis_id", name="uq_hypothesis_sprint_links_hypothesis"),
        )
        op.create_index(
            "ix_hypothesis_sprint_links_sprint",
            "hypothesis_sprint_links",
            ["sprint_id"],
        )


def downgrade() -> None:
    conn = op.get_bind()
    insp = sa.inspect(conn)
    existing = set(insp.get_table_names())

    if "hypothesis_sprint_links" in existing:
        op.drop_table("hypothesis_sprint_links")
