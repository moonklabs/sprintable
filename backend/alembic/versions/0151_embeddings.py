"""E-LOOP-LEDGER P1-S1(story 2b9c8b06): 폴리모픽 embeddings 테이블(Context Pack 파운데이션).

Revision ID: 0151
Revises: 0150
Create Date: 2026-07-02

블루프린트 §P1. Gate(work_item_type/id)·AssetLink(source_type/id) 폴리모픽 참조 패턴 미러 —
entity_type/entity_id로 hypothesis/loop/loop_artifact를 가리킨다(DB FK 불가 — 폴리모픽).

모델/차원: gemini-embedding-001 @ outputDimensionality=768(PO 확정, 2026-07-01) — vector(768).
인덱스는 HNSW(agent_long_term_memories의 죽은 ivfflat 안 미러 — 신규 org가 거의 0 데이터로
시작하는 멀티테넌트엔 HNSW가 적합, training step 불요·빈 테이블에도 구축 가능).

이 스토리는 순수 스키마만 — embed client/cron은 P1-S2/S3.

idempotent: 테이블 단위 inspect 가드(0113/0149/0150 선례와 동일 클래스).
"""
from __future__ import annotations

import sqlalchemy as sa
from alembic import op
from sqlalchemy.dialects.postgresql import UUID

revision = "0151"
down_revision = "0150"
branch_labels = None
depends_on = None

_EMBEDDING_DIM = 768


def upgrade() -> None:
    conn = op.get_bind()
    insp = sa.inspect(conn)
    existing = set(insp.get_table_names())

    if "embeddings" in existing:
        return

    op.create_table(
        "embeddings",
        sa.Column("id", UUID(as_uuid=True), primary_key=True),
        sa.Column("org_id", UUID(as_uuid=True), nullable=False),
        sa.Column(
            "project_id",
            UUID(as_uuid=True),
            sa.ForeignKey("projects.id", ondelete="CASCADE"),
            nullable=False,
        ),
        sa.Column("entity_type", sa.Text(), nullable=False),
        sa.Column("entity_id", UUID(as_uuid=True), nullable=False),
        sa.Column("embedding_text", sa.Text(), nullable=False),
        sa.Column("content_hash", sa.Text(), nullable=False),
        # embedding vector(768) — pgvector 컬럼은 raw DDL로 추가(SQLAlchemy Column 타입이 아닌
        # Postgres 고유 타입이라 op.create_table의 sa.Column으로 표현 불가).
        sa.Column("model_version", sa.Text(), nullable=True),
        sa.Column("dimension", sa.Integer(), nullable=True),
        sa.Column("status", sa.String(16), nullable=False, server_default="pending"),
        sa.Column("error_message", sa.Text(), nullable=True),
        sa.Column("created_by_member_id", UUID(as_uuid=True), nullable=True),
        sa.Column(
            "created_at", sa.DateTime(timezone=True), server_default=sa.func.now(), nullable=False
        ),
        sa.Column(
            "updated_at",
            sa.DateTime(timezone=True),
            server_default=sa.func.now(),
            onupdate=sa.func.now(),
            nullable=False,
        ),
        sa.CheckConstraint(
            "entity_type IN ('hypothesis','loop','loop_artifact')",
            name="ck_embeddings_entity_type",
        ),
        sa.CheckConstraint(
            "status IN ('pending','processing','ready','failed')",
            name="ck_embeddings_status",
        ),
        sa.UniqueConstraint("entity_type", "entity_id", name="uq_embeddings_entity"),
    )
    # pgvector 컬럼(raw DDL — op.create_table의 sa.Column enum엔 vector 타입이 없음).
    op.execute(f"ALTER TABLE embeddings ADD COLUMN embedding vector({_EMBEDDING_DIM})")

    op.create_index("ix_embeddings_org_id", "embeddings", ["org_id"])
    op.create_index(
        "ix_embeddings_org_project_entity_type", "embeddings", ["org_id", "project_id", "entity_type"]
    )
    # cron backlog 조회(P1-S3): status='pending' 배치 스캔.
    op.create_index(
        "ix_embeddings_status_pending", "embeddings", ["status"],
        postgresql_where=sa.text("status = 'pending'"),
    )
    # HNSW cosine — m/ef_construction은 pgvector 기본 권장값(16/64).
    op.execute(
        "CREATE INDEX ix_embeddings_embedding_hnsw ON embeddings "
        "USING hnsw (embedding vector_cosine_ops) WITH (m = 16, ef_construction = 64)"
    )


def downgrade() -> None:
    conn = op.get_bind()
    insp = sa.inspect(conn)
    if "embeddings" in set(insp.get_table_names()):
        op.drop_table("embeddings")
