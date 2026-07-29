"""story #2328(C-11 ㉡층, E-CONNECT) — reference_semantic_candidates: 참조 위에 얹는 「의미
후보」층(3단계 승격의 ②③). entity_references(#2259)를 재사용하지 않는다 — 그 모델이 스스로
「의미를 여기서 저장·판정하지 않는다」고 명시했다(app/models/reference.py 참조).

순수 additive — 신규 테이블 생성뿐, 기존 테이블/데이터 손상 0.

Revision ID: 0216
Revises: 0215
Create Date: 2026-07-29
"""
from alembic import op
import sqlalchemy as sa
from sqlalchemy.dialects import postgresql

revision = "0216"
down_revision = "0215"
branch_labels = None
depends_on = None


def upgrade() -> None:
    op.create_table(
        "reference_semantic_candidates",
        sa.Column("id", postgresql.UUID(as_uuid=True), primary_key=True),
        sa.Column("org_id", postgresql.UUID(as_uuid=True), nullable=False),
        sa.Column("source_type", sa.Text(), nullable=False),
        sa.Column("source_field", sa.Text(), nullable=False),
        sa.Column("source_id", postgresql.UUID(as_uuid=True), nullable=False),
        sa.Column("target_type", sa.Text(), nullable=False),
        sa.Column("target_id", postgresql.UUID(as_uuid=True), nullable=False),
        sa.Column("form", sa.Text(), nullable=False),
        sa.Column("relation_kind", sa.Text(), nullable=True),
        sa.Column("matched_keyword", sa.Text(), nullable=True),
        sa.Column("snippet", sa.Text(), nullable=False),
        sa.Column("status", sa.Text(), nullable=False, server_default="estimated"),
        sa.Column("declared_by", postgresql.UUID(as_uuid=True), nullable=True),
        sa.Column("declared_at", sa.DateTime(timezone=True), nullable=True),
        sa.Column("created_at", sa.DateTime(timezone=True), nullable=False, server_default=sa.func.now()),
        sa.CheckConstraint(
            "relation_kind IS NULL OR relation_kind IN "
            "('낳음', '근거인용', '동종사례', '잇따름', '명시적_무관')",
            name="ck_reference_semantic_candidates_relation_kind",
        ),
        sa.CheckConstraint(
            "status IN ('estimated', 'declared')",
            name="ck_reference_semantic_candidates_status",
        ),
    )
    op.create_index(
        "ix_reference_semantic_candidates_source",
        "reference_semantic_candidates", ["org_id", "source_type", "source_id"],
    )
    op.create_index(
        "uq_reference_semantic_candidates_key",
        "reference_semantic_candidates",
        ["source_type", "source_field", "source_id", "target_type", "target_id", "form"],
        unique=True,
    )


def downgrade() -> None:
    op.drop_index("uq_reference_semantic_candidates_key", table_name="reference_semantic_candidates")
    op.drop_index("ix_reference_semantic_candidates_source", table_name="reference_semantic_candidates")
    op.drop_table("reference_semantic_candidates")
