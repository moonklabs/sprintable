"""E-CANVAS C2-S6(story 0edca31e): artifact_comments(요소/좌표 앵커 핀·스레드·resolve) +
artifact_nodes.description(description pane — 요소별 스펙, 에이전트 MCP 읽기).

Revision ID: 0172
Revises: 0171
Create Date: 2026-07-10

순수 additive — 신규 테이블 1개 + 기존 테이블 nullable 컬럼 1개 추가. 기존 스키마 무회귀.
"""
from __future__ import annotations

from alembic import op
import sqlalchemy as sa
from sqlalchemy.dialects import postgresql

revision = "0172"
down_revision = "0171"
branch_labels = None
depends_on = None


def upgrade() -> None:
    op.add_column("artifact_nodes", sa.Column("description", sa.Text(), nullable=True))

    op.create_table(
        "artifact_comments",
        sa.Column("id", postgresql.UUID(as_uuid=True), primary_key=True),
        sa.Column(
            "artifact_id", postgresql.UUID(as_uuid=True),
            sa.ForeignKey("visual_artifacts.id", ondelete="CASCADE"), nullable=False,
        ),
        sa.Column("org_id", postgresql.UUID(as_uuid=True), nullable=False),
        sa.Column("project_id", postgresql.UUID(as_uuid=True), nullable=False),
        # 앵커: node_id(요소 단위) 또는 anchor_x/anchor_y(자유 좌표 핀) — 둘 중 하나(또는 둘 다
        # None=artifact 전체 코멘트). 삭제된 node를 참조하면 코멘트가 orphan되지 않도록 SET NULL
        # (좌표 핀으로 폴백 표시 가능·코멘트 자체는 보존).
        sa.Column(
            "node_id", postgresql.UUID(as_uuid=True),
            sa.ForeignKey("artifact_nodes.id", ondelete="SET NULL"), nullable=True,
        ),
        sa.Column("anchor_x", sa.Float(), nullable=True),
        sa.Column("anchor_y", sa.Float(), nullable=True),
        sa.Column("content", sa.Text(), nullable=False),
        # 스레드: 최상위 코멘트는 NULL, 답글은 루트(또는 부모) 코멘트를 가리킴. 스레드 루트 삭제는
        # 이 스코프에서 미제공(삭제 API 없음)이라 CASCADE 대신 SET NULL로 방어적 설계(향후 삭제
        # 추가 시 답글이 orphan top-level로 남되 데이터 유실은 없음).
        sa.Column(
            "parent_id", postgresql.UUID(as_uuid=True),
            sa.ForeignKey("artifact_comments.id", ondelete="SET NULL"), nullable=True,
        ),
        sa.Column("resolved", sa.Boolean(), nullable=False, server_default="false"),
        sa.Column("resolved_by", postgresql.UUID(as_uuid=True), nullable=True),
        sa.Column("resolved_at", sa.DateTime(timezone=True), nullable=True),
        sa.Column("created_by", postgresql.UUID(as_uuid=True), nullable=False),
        sa.Column("created_at", sa.DateTime(timezone=True), server_default=sa.text("now()"), nullable=False),
    )
    op.create_index("ix_artifact_comments_artifact_id", "artifact_comments", ["artifact_id"])
    op.create_index("ix_artifact_comments_node_id", "artifact_comments", ["node_id"])
    op.create_index("ix_artifact_comments_parent_id", "artifact_comments", ["parent_id"])


def downgrade() -> None:
    op.drop_table("artifact_comments")
    op.drop_column("artifact_nodes", "description")
