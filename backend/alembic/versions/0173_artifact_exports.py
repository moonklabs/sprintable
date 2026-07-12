"""E-CANVAS C1-S5(story 1f365e33): artifact_exports — F6 export(PNG/HTML) 버전 귀속 기록.

Revision ID: 0173
Revises: 0172
Create Date: 2026-07-10

순수 additive — 신규 테이블 1개. 기존 스키마 무회귀. asset_id는 기존 assets 레지스트리(S1
IStorageService 위 빌드) 재사용 — 별도 AssetLink 확장 없이 export 전용 귀속 테이블로 버전/포맷
메타를 보관한다(crux: BE는 signed write URL 발급 + complete 시 head_object 검증 후 편입만,
바이너리는 FE→GCS 직접 PUT).
"""
from __future__ import annotations

from alembic import op
import sqlalchemy as sa
from sqlalchemy.dialects import postgresql

revision = "0173"
down_revision = "0172"
branch_labels = None
depends_on = None


def upgrade() -> None:
    op.create_table(
        "artifact_exports",
        sa.Column("id", postgresql.UUID(as_uuid=True), primary_key=True),
        sa.Column(
            "artifact_id", postgresql.UUID(as_uuid=True),
            sa.ForeignKey("visual_artifacts.id", ondelete="CASCADE"), nullable=False,
        ),
        sa.Column(
            "version_id", postgresql.UUID(as_uuid=True),
            sa.ForeignKey("artifact_versions.id", ondelete="CASCADE"), nullable=False,
        ),
        sa.Column("format", sa.Text(), nullable=False),
        sa.Column(
            "asset_id", postgresql.UUID(as_uuid=True),
            sa.ForeignKey("assets.id", ondelete="CASCADE"), nullable=False,
        ),
        sa.Column("created_by", postgresql.UUID(as_uuid=True), nullable=True),
        sa.Column("created_at", sa.DateTime(timezone=True), server_default=sa.text("now()"), nullable=False),
    )
    op.create_index("ix_artifact_exports_artifact_id", "artifact_exports", ["artifact_id"])
    op.create_index("ix_artifact_exports_version_id", "artifact_exports", ["version_id"])
    op.create_check_constraint(
        "ck_artifact_exports_format",
        "artifact_exports",
        "format IN ('png','html')",
    )


def downgrade() -> None:
    op.drop_table("artifact_exports")
