"""E-LOOP-LEDGER P1-S1: 폴리모픽 embeddings 테이블(Context Pack 파운데이션, 블루프린트 §P1).

Gate(work_item_type/work_item_id)·AssetLink(source_type/source_id) 폴리모픽 참조 패턴을
미러 — entity_type/entity_id로 hypothesis/loop/loop_artifact를 가리킨다(DB FK 불가·참조
무결성은 앱 레벨. orphan 정리는 write-path 스토리(P1-S4) 스코프).

모델/차원: 초기값 gemini-embedding-001 @ outputDimensionality=768(오르테가 PO 확정, 2026-07-01).
model_version/dimension 컬럼을 별도로 둬서 향후 모델 업그레이드(예: 3072/halfvec)가 기존 행과
공존 가능하게 한다 — re-embed(cron)로 점진 이관, 빅뱅 마이그 불필요.

status 라이프사이클: pending(생성 직후, embedding NULL) → processing(cron이 집음) →
ready(embedding 채워짐) 또는 failed(error_message 채움, 재시도는 cron이 pending으로 되돌림 —
P1-S3 스코프). 이 스토리(S1)는 순수 스키마만 — client/cron 없음.
"""
from __future__ import annotations

import uuid
from datetime import datetime

from pgvector.sqlalchemy import Vector
from sqlalchemy import (
    CheckConstraint,
    ForeignKey,
    Index,
    Integer,
    String,
    Text,
    UniqueConstraint,
    event,
    text,
)
from sqlalchemy.dialects.postgresql import UUID
from sqlalchemy.orm import Mapped, mapped_column

from app.models.base import Base, OrgScopedMixin, TimestampMixin

# fresh-runnable(Base.metadata.create_all) 경로는 baseline.sql을 안 거치므로 pgvector
# extension이 없다 — vector 컬럼이 있는 테이블 생성 시 "type vector does not exist"로 실패한다
# (alembic upgrade head 경로는 baseline의 CREATE EXTENSION IF NOT EXISTS vector를 거쳐 무관).
# create_all() 호출 직전 자동으로 extension을 보장해 모든 기존 create_all 기반 테스트가
# 이 테이블 추가만으로 깨지지 않게 한다.
@event.listens_for(Base.metadata, "before_create")
def _ensure_vector_extension(target, connection, **kw):
    connection.execute(text("CREATE EXTENSION IF NOT EXISTS vector"))

EMBEDDING_ENTITY_TYPES = frozenset({"hypothesis", "loop", "loop_artifact"})
EMBEDDING_STATUSES = frozenset({"pending", "processing", "ready", "failed"})
EMBEDDING_DIMENSION = 768


class Embedding(Base, OrgScopedMixin, TimestampMixin):
    __tablename__ = "embeddings"

    id: Mapped[uuid.UUID] = mapped_column(UUID(as_uuid=True), primary_key=True, default=uuid.uuid4)
    project_id: Mapped[uuid.UUID] = mapped_column(
        UUID(as_uuid=True), ForeignKey("projects.id", ondelete="CASCADE"), nullable=False
    )
    entity_type: Mapped[str] = mapped_column(Text, nullable=False)
    entity_id: Mapped[uuid.UUID] = mapped_column(UUID(as_uuid=True), nullable=False)

    # embedding_text: 임베딩 생성에 쓴 원문(재현/디버그/재임베딩 판단용). content_hash로 staleness 감지
    # (원본 엔티티 텍스트가 바뀌었는데 아직 재임베딩 안 된 상태를 write-path 스토리가 식별).
    embedding_text: Mapped[str] = mapped_column(Text, nullable=False)
    content_hash: Mapped[str] = mapped_column(Text, nullable=False)

    # NULL until status='ready'(cron이 채움, P1-S3 스코프).
    embedding: Mapped[list[float] | None] = mapped_column(Vector(EMBEDDING_DIMENSION), nullable=True)
    model_version: Mapped[str | None] = mapped_column(Text, nullable=True)
    dimension: Mapped[int | None] = mapped_column(Integer, nullable=True)

    status: Mapped[str] = mapped_column(String(16), nullable=False, server_default="pending")
    error_message: Mapped[str | None] = mapped_column(Text, nullable=True)

    created_by_member_id: Mapped[uuid.UUID | None] = mapped_column(UUID(as_uuid=True), nullable=True)

    __table_args__ = (
        CheckConstraint(
            "entity_type IN ('hypothesis','loop','loop_artifact')",
            name="ck_embeddings_entity_type",
        ),
        CheckConstraint(
            "status IN ('pending','processing','ready','failed')",
            name="ck_embeddings_status",
        ),
        # 엔티티당 embedding row 1개(재임베딩=UPDATE, 새 row 아님 — 이력 보관 불요·현재값만 유의미).
        UniqueConstraint("entity_type", "entity_id", name="uq_embeddings_entity"),
        # cron backlog 조회(P1-S3): status='pending' 배치 스캔.
        Index("ix_embeddings_status_pending", "status", postgresql_where=text("status = 'pending'")),
        # 테넌트 스코프 pre-filter(까심/codex 지적 — org_id+ANN 조합 recall 저하 완화 보조 인덱스).
        Index("ix_embeddings_org_project_entity_type", "org_id", "project_id", "entity_type"),
        # HNSW — cosine distance(agent_long_term_memories의 죽은 ivfflat 안 미러. 신규 org가
        # 거의 0 데이터로 시작하는 멀티테넌트엔 HNSW가 적합 — training step 불요, 빈 테이블에도 구축).
        Index(
            "ix_embeddings_embedding_hnsw",
            "embedding",
            postgresql_using="hnsw",
            postgresql_with={"m": 16, "ef_construction": 64},
            postgresql_ops={"embedding": "vector_cosine_ops"},
        ),
    )
