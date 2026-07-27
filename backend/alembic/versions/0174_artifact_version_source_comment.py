"""E-CANVAS C3-S7(story 940266db): artifact_versions.source_comment_id — 코멘트→편집 결과
연결(closed-loop: C2 코멘트가 C3 편집을 낳은 계보만 기록, resolve와는 독립).

Revision ID: 0174
Revises: 0173
Create Date: 2026-07-11

순수 additive — nullable 컬럼 1개. 기존 스키마 무회귀. ON DELETE SET NULL(코멘트 삭제되어도
버전 이력 자체는 유지, 링크만 소실).
"""
from __future__ import annotations

from alembic import op
import sqlalchemy as sa
from sqlalchemy.dialects import postgresql

revision = "0174"
down_revision = "0173"
branch_labels = None
depends_on = None


def upgrade() -> None:
    op.add_column(
        "artifact_versions",
        sa.Column(
            "source_comment_id", postgresql.UUID(as_uuid=True),
            sa.ForeignKey("artifact_comments.id", ondelete="SET NULL"), nullable=True,
        ),
    )
    op.create_index(
        "ix_artifact_versions_source_comment_id", "artifact_versions", ["source_comment_id"],
    )


def downgrade() -> None:
    op.drop_index("ix_artifact_versions_source_comment_id", table_name="artifact_versions")
    op.drop_column("artifact_versions", "source_comment_id")
