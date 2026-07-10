"""E-CANVAS C1-S3(story 8bace49e): visual_artifacts/artifact_versions/artifact_nodes — 시각
산출물 1급 객체(전신 /mockups 트리 계승 + 하이브리드 html_blob 캐치올 + 보기전용 버전전환).

Revision ID: 0170
Revises: 0169
Create Date: 2026-07-10

순수 additive 신규 테이블 3개 — 기존 스키마 무회귀.
"""
from __future__ import annotations

from alembic import op
import sqlalchemy as sa
from sqlalchemy.dialects import postgresql

revision = "0170"
down_revision = "0169"
branch_labels = None
depends_on = None


def upgrade() -> None:
    op.create_table(
        "visual_artifacts",
        sa.Column("id", postgresql.UUID(as_uuid=True), primary_key=True),
        sa.Column("org_id", postgresql.UUID(as_uuid=True), nullable=False),
        sa.Column("project_id", postgresql.UUID(as_uuid=True), nullable=False),
        sa.Column("title", sa.Text(), nullable=False),
        sa.Column("story_id", postgresql.UUID(as_uuid=True), nullable=True),
        sa.Column("epic_id", postgresql.UUID(as_uuid=True), nullable=True),
        sa.Column("doc_id", postgresql.UUID(as_uuid=True), nullable=True),
        sa.Column("source", sa.Text(), nullable=False, server_default="created"),
        sa.Column("latest_version_number", sa.Integer(), nullable=False, server_default="1"),
        # 유나 §11 field-level 대조 갭①: 정본 버전(set은 C4 승인 게이트, C1은 컬럼만·null=정본없음).
        sa.Column("anchor_version", sa.Integer(), nullable=True),
        sa.Column("created_by", postgresql.UUID(as_uuid=True), nullable=True),
        sa.Column("created_at", sa.DateTime(timezone=True), server_default=sa.text("now()"), nullable=False),
        sa.Column("updated_at", sa.DateTime(timezone=True), server_default=sa.text("now()"), nullable=False),
        sa.Column("deleted_at", sa.DateTime(timezone=True), nullable=True),
    )
    op.create_index("ix_visual_artifacts_org_id", "visual_artifacts", ["org_id"])
    op.create_index("ix_visual_artifacts_project_id", "visual_artifacts", ["project_id"])
    op.create_index("ix_visual_artifacts_story_id", "visual_artifacts", ["story_id"])
    op.create_index("ix_visual_artifacts_epic_id", "visual_artifacts", ["epic_id"])
    op.create_index("ix_visual_artifacts_doc_id", "visual_artifacts", ["doc_id"])
    op.create_check_constraint(
        "ck_visual_artifacts_source",
        "visual_artifacts",
        "source IN ('created','imported')",
    )

    op.create_table(
        "artifact_versions",
        sa.Column("id", postgresql.UUID(as_uuid=True), primary_key=True),
        sa.Column(
            "artifact_id", postgresql.UUID(as_uuid=True),
            sa.ForeignKey("visual_artifacts.id", ondelete="CASCADE"), nullable=False,
        ),
        sa.Column("version_number", sa.Integer(), nullable=False),
        sa.Column("created_by", postgresql.UUID(as_uuid=True), nullable=True),
        # 유나 §11 field-level 대조 갭②: 변경 이유(커밋 요약) — lineage 서사(§6 감시-게이트 핵심).
        sa.Column("summary", sa.Text(), nullable=True),
        sa.Column("created_at", sa.DateTime(timezone=True), server_default=sa.text("now()"), nullable=False),
        sa.UniqueConstraint("artifact_id", "version_number", name="uq_artifact_versions_artifact_number"),
    )
    op.create_index("ix_artifact_versions_artifact_id", "artifact_versions", ["artifact_id"])

    op.create_table(
        "artifact_nodes",
        sa.Column("id", postgresql.UUID(as_uuid=True), primary_key=True),
        sa.Column(
            "artifact_id", postgresql.UUID(as_uuid=True),
            sa.ForeignKey("visual_artifacts.id", ondelete="CASCADE"), nullable=False,
        ),
        sa.Column(
            "version_id", postgresql.UUID(as_uuid=True),
            sa.ForeignKey("artifact_versions.id", ondelete="CASCADE"), nullable=False,
        ),
        sa.Column("type", sa.Text(), nullable=False),
        sa.Column("props", postgresql.JSONB(), nullable=False, server_default="{}"),
        sa.Column("parent_id", postgresql.UUID(as_uuid=True), nullable=True),
        sa.Column("sort_order", sa.Integer(), nullable=False, server_default="0"),
        sa.Column("created_at", sa.DateTime(timezone=True), server_default=sa.text("now()"), nullable=False),
    )
    op.create_index("ix_artifact_nodes_artifact_id", "artifact_nodes", ["artifact_id"])
    op.create_index("ix_artifact_nodes_version_id", "artifact_nodes", ["version_id"])


def downgrade() -> None:
    op.drop_table("artifact_nodes")
    op.drop_table("artifact_versions")
    op.drop_table("visual_artifacts")
