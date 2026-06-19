"""E-DECISION-GATE workflow line ORM models.

Decision Gate(org-configurable 결재/핸드오프 라인)의 config 거버넌스 모델. 스키마는 S1
마이그(0126)에서 생성됐고, 본 모듈은 그 테이블을 ORM 으로 표면화한다(컬럼/기본값은 0126 SSOT).
S2 범위 = config lifecycle/approval/lint. 엔진(읽기 모델·workflow_line_steps materialize)은 S3.

enum류는 text 컬럼 + 앱 레벨 validator(아래 상수)로 표현한다(0126 설계 일관 — DB CHECK/native
enum 미사용).
"""
import uuid
from datetime import datetime

from sqlalchemy import Boolean, DateTime, Integer, Text, func
from sqlalchemy.dialects.postgresql import JSONB, UUID
from sqlalchemy.orm import Mapped, mapped_column

from app.core.database import Base

# ── 앱 레벨 enum (text 컬럼 validator) ────────────────────────────────────────
ENTITY_TYPES = frozenset({"story", "doc", "hypothesis", "epic", "sprint"})
DEFINITION_SOURCES = frozenset({"system_default", "org_config", "project_override"})
VERSION_STATUSES = frozenset({"draft", "pending_review", "published", "retired", "rejected"})
LINT_STATUSES = frozenset({"not_run", "passed", "failed"})

# version 상태 전이 규칙(거버넌스 lifecycle). published/retired/rejected = terminal-ish.
VALID_VERSION_TRANSITIONS: dict[str, frozenset[str]] = {
    "draft": frozenset({"pending_review", "retired"}),
    "pending_review": frozenset({"published", "rejected", "draft", "retired"}),
    "published": frozenset({"retired"}),
    "rejected": frozenset({"draft", "retired"}),
    "retired": frozenset(),
}


def is_valid_version_transition(old: str, new: str) -> bool:
    return new in VALID_VERSION_TRANSITIONS.get(old, frozenset())


class WorkflowLineDefinition(Base):
    """활성 라인 포인터(org/project overlay). org/project/entity 당 active 1개(0126 split unique)."""

    __tablename__ = "workflow_line_definitions"

    id: Mapped[uuid.UUID] = mapped_column(UUID(as_uuid=True), primary_key=True, default=uuid.uuid4)
    org_id: Mapped[uuid.UUID] = mapped_column(UUID(as_uuid=True), nullable=False, index=True)
    project_id: Mapped[uuid.UUID | None] = mapped_column(UUID(as_uuid=True), nullable=True, index=True)
    entity_type: Mapped[str] = mapped_column(Text, nullable=False)
    name: Mapped[str] = mapped_column(Text, nullable=False)
    version: Mapped[int] = mapped_column(Integer, nullable=False, server_default="1")
    is_active: Mapped[bool] = mapped_column(Boolean, nullable=False, server_default="true")
    source: Mapped[str] = mapped_column(Text, nullable=False, server_default="org_config")
    created_by_member_id: Mapped[uuid.UUID | None] = mapped_column(UUID(as_uuid=True), nullable=True)
    published_at: Mapped[datetime | None] = mapped_column(DateTime(timezone=True), nullable=True)
    retired_at: Mapped[datetime | None] = mapped_column(DateTime(timezone=True), nullable=True)
    config_hash: Mapped[str | None] = mapped_column(Text, nullable=True)
    created_at: Mapped[datetime] = mapped_column(DateTime(timezone=True), server_default=func.now(), nullable=False)
    updated_at: Mapped[datetime] = mapped_column(
        DateTime(timezone=True), server_default=func.now(), onupdate=func.now(), nullable=False
    )


class WorkflowLineDefinitionVersion(Base):
    """라인 config 버전(P0-4 거버넌스). draft→pending_review→published/rejected→retired."""

    __tablename__ = "workflow_line_definition_versions"

    id: Mapped[uuid.UUID] = mapped_column(UUID(as_uuid=True), primary_key=True, default=uuid.uuid4)
    line_definition_id: Mapped[uuid.UUID | None] = mapped_column(UUID(as_uuid=True), nullable=True)
    org_id: Mapped[uuid.UUID] = mapped_column(UUID(as_uuid=True), nullable=False, index=True)
    project_id: Mapped[uuid.UUID | None] = mapped_column(UUID(as_uuid=True), nullable=True, index=True)
    entity_type: Mapped[str] = mapped_column(Text, nullable=False)
    version: Mapped[int] = mapped_column(Integer, nullable=False)
    status: Mapped[str] = mapped_column(Text, nullable=False, server_default="draft")
    config: Mapped[dict] = mapped_column(JSONB, nullable=False, server_default="{}")
    config_hash: Mapped[str] = mapped_column(Text, nullable=False)
    lint_status: Mapped[str] = mapped_column(Text, nullable=False, server_default="not_run")
    lint_errors: Mapped[list] = mapped_column(JSONB, nullable=False, server_default="[]")
    created_by_member_id: Mapped[uuid.UUID] = mapped_column(UUID(as_uuid=True), nullable=False)
    reviewed_by_member_id: Mapped[uuid.UUID | None] = mapped_column(UUID(as_uuid=True), nullable=True)
    review_gate_id: Mapped[uuid.UUID | None] = mapped_column(UUID(as_uuid=True), nullable=True)
    published_at: Mapped[datetime | None] = mapped_column(DateTime(timezone=True), nullable=True)
    created_at: Mapped[datetime] = mapped_column(DateTime(timezone=True), server_default=func.now(), nullable=False)
    updated_at: Mapped[datetime] = mapped_column(
        DateTime(timezone=True), server_default=func.now(), onupdate=func.now(), nullable=False
    )
