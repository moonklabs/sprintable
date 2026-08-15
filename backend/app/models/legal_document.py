"""약관/개인정보처리방침/환불정책 버전 이력(story #2606) — legal_document_versions.

pricing_versions(app/models/pricing_version.py)와 동형 append-only 이력: 콘텐츠가 담긴 행은
절대 UPDATE되지 않는다. 새 버전이 생기면 새 행을 INSERT하고, 직전 "열린"(effective_to IS
NULL) 행의 effective_to를 새 행의 effective_from으로 닫는다 — 콘텐츠 값 자체는 불변.

쓰기(admin CRUD)는 sprintable-admin/internal-api가 담당(pricing_versions와 동일 두-레포
배선 — 마이그레이션은 이 메인 repo가 SSOT, internal-api는 같은 DB를 보는 별도 모델+서비스).
이 repo는 공개 read-only 엔드포인트(GET /api/v2/legal/{doc_type})만 제공한다."""
from __future__ import annotations

import uuid
from datetime import datetime

from sqlalchemy import CheckConstraint, DateTime, Index, Text, func
from sqlalchemy.dialects.postgresql import UUID
from sqlalchemy.orm import Mapped, mapped_column

from app.core.database import Base


class LegalDocumentVersion(Base):
    __tablename__ = "legal_document_versions"
    __table_args__ = (
        CheckConstraint(
            "doc_type = ANY (ARRAY['terms'::text, 'privacy'::text, 'refund_policy'::text])",
            name="legal_document_versions_doc_type_check",
        ),
        CheckConstraint(
            "locale = ANY (ARRAY['ko'::text, 'en'::text])",
            name="legal_document_versions_locale_check",
        ),
        CheckConstraint(
            "content_format = ANY (ARRAY['markdown'::text, 'html'::text])",
            name="legal_document_versions_content_format_check",
        ),
        CheckConstraint(
            "effective_to IS NULL OR effective_to > effective_from",
            name="legal_document_versions_effective_range_check",
        ),
        Index("ix_legal_document_versions_type_effective_from", "doc_type", "locale", "effective_from"),
    )

    id: Mapped[uuid.UUID] = mapped_column(UUID(as_uuid=True), primary_key=True, default=uuid.uuid4)
    doc_type: Mapped[str] = mapped_column(Text, nullable=False)
    locale: Mapped[str] = mapped_column(Text, nullable=False, default="ko")
    content: Mapped[str] = mapped_column(Text, nullable=False)
    content_format: Mapped[str] = mapped_column(Text, nullable=False, default="markdown")
    effective_from: Mapped[datetime] = mapped_column(DateTime(timezone=True), nullable=False)
    effective_to: Mapped[datetime | None] = mapped_column(DateTime(timezone=True), nullable=True)
    created_by: Mapped[str] = mapped_column(Text, nullable=False)
    created_at: Mapped[datetime] = mapped_column(
        DateTime(timezone=True), server_default=func.now(), nullable=False
    )
