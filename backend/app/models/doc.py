import uuid
from datetime import datetime
from typing import Any, List

from sqlalchemy import Boolean, Computed, DateTime, ForeignKey, Integer, Text, UniqueConstraint, func
from sqlalchemy.dialects.postgresql import ARRAY, TSVECTOR, UUID
from sqlalchemy.orm import Mapped, mapped_column, relationship

from app.core.database import Base
from app.models.base import OrgScopedMixin, SoftDeleteMixin, TimestampMixin


class Doc(Base, OrgScopedMixin, TimestampMixin, SoftDeleteMixin):
    __tablename__ = "docs"

    id: Mapped[uuid.UUID] = mapped_column(UUID(as_uuid=True), primary_key=True, default=uuid.uuid4)
    project_id: Mapped[uuid.UUID] = mapped_column(
        UUID(as_uuid=True), ForeignKey("projects.id", ondelete="CASCADE"), nullable=False, index=True
    )
    parent_id: Mapped[uuid.UUID | None] = mapped_column(
        UUID(as_uuid=True), ForeignKey("docs.id", ondelete="SET NULL"), nullable=True, index=True
    )
    created_by: Mapped[uuid.UUID | None] = mapped_column(
        UUID(as_uuid=True), nullable=True
    )
    assignee_id: Mapped[uuid.UUID | None] = mapped_column(
        UUID(as_uuid=True), nullable=True
    )
    title: Mapped[str] = mapped_column(Text, nullable=False)
    slug: Mapped[str] = mapped_column(Text, nullable=False)
    # 4dd399c6: False=자동관리(제목 파생·untitled-* 교정 대상), True=사용자 고정(자동 교정 금지).
    slug_locked: Mapped[bool] = mapped_column(Boolean, nullable=False, default=False)
    content: Mapped[str] = mapped_column(Text, nullable=False, default="")
    icon: Mapped[str | None] = mapped_column(Text, nullable=True)
    sort_order: Mapped[int] = mapped_column(Integer, nullable=False, default=0)
    doc_type: Mapped[str] = mapped_column(Text, nullable=False, default="page")
    content_format: Mapped[str] = mapped_column(Text, nullable=False, default="markdown")
    tags: Mapped[List[str]] = mapped_column(ARRAY(Text), nullable=False, default=list)
    search_vector: Mapped[Any] = mapped_column(
        TSVECTOR,
        Computed(
            "to_tsvector('simple', coalesce(title, '') || ' ' || coalesce(content, ''))",
            persisted=True,
        ),
        nullable=True,
    )

    children: Mapped[list["Doc"]] = relationship("Doc", back_populates="parent", lazy="select")
    parent: Mapped["Doc | None"] = relationship("Doc", back_populates="children", remote_side=[id])

    @property
    def is_folder(self) -> bool:
        return self.doc_type == "folder"

    @property
    def canonical_slug(self) -> str:
        """현재 정식 slug. alias resolve 시 응답으로 FE 가 요청 slug 와 비교해 router.replace."""
        return self.slug


class DocSlugAlias(Base, OrgScopedMixin):
    """4dd399c6 AC3: 재슬러그 시 구 slug→doc_id 보존. 외부 북마크/Recents/본문 내부링크 깨짐 방지.

    `?slug=` resolve 가 docs 미스 시 alias fallback 으로 canonical doc 반환.
    """
    __tablename__ = "doc_slug_aliases"
    __table_args__ = (
        UniqueConstraint("project_id", "old_slug", name="uq_doc_slug_alias_project_old"),
    )

    id: Mapped[uuid.UUID] = mapped_column(UUID(as_uuid=True), primary_key=True, default=uuid.uuid4)
    project_id: Mapped[uuid.UUID] = mapped_column(
        UUID(as_uuid=True), ForeignKey("projects.id", ondelete="CASCADE"), nullable=False, index=True
    )
    old_slug: Mapped[str] = mapped_column(Text, nullable=False)
    doc_id: Mapped[uuid.UUID] = mapped_column(
        UUID(as_uuid=True), ForeignKey("docs.id", ondelete="CASCADE"), nullable=False, index=True
    )
    created_at: Mapped[datetime] = mapped_column(
        DateTime(timezone=True), server_default=func.now(), nullable=False
    )


class DocComment(Base, OrgScopedMixin):
    __tablename__ = "doc_comments"

    id: Mapped[uuid.UUID] = mapped_column(UUID(as_uuid=True), primary_key=True, default=uuid.uuid4)
    doc_id: Mapped[uuid.UUID] = mapped_column(
        UUID(as_uuid=True), ForeignKey("docs.id", ondelete="CASCADE"), nullable=False, index=True
    )
    project_id: Mapped[uuid.UUID] = mapped_column(
        UUID(as_uuid=True), ForeignKey("projects.id", ondelete="CASCADE"), nullable=False
    )
    content: Mapped[str] = mapped_column(Text, nullable=False)
    created_by: Mapped[uuid.UUID] = mapped_column(
        UUID(as_uuid=True), nullable=False
    )
    created_at: Mapped[datetime] = mapped_column(
        DateTime(timezone=True), server_default=func.now(), nullable=False
    )


class DocRevision(Base, OrgScopedMixin):
    __tablename__ = "doc_revisions"

    id: Mapped[uuid.UUID] = mapped_column(UUID(as_uuid=True), primary_key=True, default=uuid.uuid4)
    doc_id: Mapped[uuid.UUID] = mapped_column(
        UUID(as_uuid=True), ForeignKey("docs.id", ondelete="CASCADE"), nullable=False, index=True
    )
    project_id: Mapped[uuid.UUID] = mapped_column(
        UUID(as_uuid=True), ForeignKey("projects.id", ondelete="CASCADE"), nullable=False
    )
    content: Mapped[str] = mapped_column(Text, nullable=False, default="")
    created_by: Mapped[uuid.UUID | None] = mapped_column(
        UUID(as_uuid=True), nullable=True
    )
    created_at: Mapped[datetime] = mapped_column(
        DateTime(timezone=True), server_default=func.now(), nullable=False
    )
