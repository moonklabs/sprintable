"""story 91404248(C2a): org_member_trust_snapshots 테이블 신설(org-c2-trust-persistence-design §1).

Revision ID: 0187
Revises: 0186
Create Date: 2026-07-15

member×role 신뢰 스냅샷 append-only 이력(entity_slug_history와 동형: update 없음).
compute_member_trust_scores()의 role별 score dict를 metrics JSONB로 verbatim 저장 —
산식 불변·저장만 추가(compute_and_snapshot() wrapper가 lazy write-through로 적재).
순수 additive — 기존 스키마 무회귀.
"""
from __future__ import annotations

from alembic import op
import sqlalchemy as sa
from sqlalchemy.dialects import postgresql

revision = "0187"
down_revision = "0186"
branch_labels = None
depends_on = None


def upgrade() -> None:
    op.create_table(
        "org_member_trust_snapshots",
        sa.Column("id", postgresql.UUID(as_uuid=True), primary_key=True),
        sa.Column("org_id", postgresql.UUID(as_uuid=True), nullable=False),
        sa.Column("member_id", postgresql.UUID(as_uuid=True), nullable=False),
        sa.Column("role_key", sa.String(length=50), nullable=False),
        sa.Column("window_days", sa.Integer(), nullable=False),
        sa.Column("metrics", postgresql.JSONB(), nullable=False),
        sa.Column("computed_at", sa.DateTime(timezone=True), server_default=sa.text("now()"), nullable=False),
    )
    op.create_index("ix_org_member_trust_snapshots_org_id", "org_member_trust_snapshots", ["org_id"])
    op.create_index("ix_org_member_trust_snapshots_member_id", "org_member_trust_snapshots", ["member_id"])
    op.create_index(
        "ix_org_member_trust_snapshots_computed_at", "org_member_trust_snapshots", ["computed_at"]
    )
    op.create_index(
        "ix_trust_snapshot_member_role_time",
        "org_member_trust_snapshots",
        ["org_id", "member_id", "role_key", "computed_at"],
    )


def downgrade() -> None:
    op.drop_table("org_member_trust_snapshots")
