"""E-STORAGE-SSOT S2: asset registry — assets / asset_folders / asset_links.

S1 IStorageService 위에 빌드. 모든 업로드를 queryable한 asset row로 편입(org/project namespace +
legacy chat/story path 호환). asset_links = 자산이 어디서 참조되는지의 SSOT(catch#4·JSONB=denorm).

⚠️ created_by 는 FK 없음 — `team_members` 가 뷰라 FK 불가. resolver member id 를 보관(검증은 서비스 계층).
"""
from __future__ import annotations

import uuid

from sqlalchemy import (
    BigInteger,
    CheckConstraint,
    ForeignKey,
    Index,
    Text,
    UniqueConstraint,
    text,
)
from sqlalchemy.dialects.postgresql import UUID
from sqlalchemy.orm import Mapped, mapped_column, relationship

from app.models.base import Base, OrgScopedMixin, SoftDeleteMixin, TimestampMixin

# asset_links.source_type 허용값(catch: AC6 다형). CHECK + 서비스 가드 양쪽에서 강제.
ASSET_LINK_SOURCE_TYPES = ("conversation_message", "story", "doc", "manual")


class AssetFolder(Base, OrgScopedMixin, TimestampMixin, SoftDeleteMixin):
    """org/project 스코프 폴더 트리. parent_id NULL = 루트."""

    __tablename__ = "asset_folders"
    __table_args__ = (
        UniqueConstraint(
            "org_id", "project_id", "parent_id", "name", name="uq_asset_folders_parent_name"
        ),
        Index("ix_asset_folders_project_parent", "org_id", "project_id", "parent_id"),
    )

    id: Mapped[uuid.UUID] = mapped_column(UUID(as_uuid=True), primary_key=True, default=uuid.uuid4)
    project_id: Mapped[uuid.UUID | None] = mapped_column(
        UUID(as_uuid=True), ForeignKey("projects.id", ondelete="CASCADE"), nullable=True, index=True
    )
    parent_id: Mapped[uuid.UUID | None] = mapped_column(
        UUID(as_uuid=True),
        ForeignKey("asset_folders.id", ondelete="CASCADE"),
        nullable=True,
        index=True,
    )
    name: Mapped[str] = mapped_column(Text, nullable=False)
    created_by: Mapped[uuid.UUID | None] = mapped_column(UUID(as_uuid=True), nullable=True)


class Asset(Base, OrgScopedMixin, TimestampMixin, SoftDeleteMixin):
    """blob 1건 = asset row. container+object_path 가 storage 좌표(S1 putObject 반환)."""

    __tablename__ = "assets"
    __table_args__ = (
        # 멱등 upsert 키 — 같은 blob(=경로)은 org 내 단일 row(backfill/재업로드 중복 방지).
        # ⚠️ org_id 포함 필수(멀티테넌시): 전역 키면 타 org가 같은 object_path 재사용 시 conflict가
        # 타 org asset_id로 매핑돼 cross-org dangling link/IDOR 발생(까심 적출). project_id 는
        # object_path 가 이미 내포하므로 키 제외(nullable NULL-distinct로 org-level 멱등 깨짐 회피).
        UniqueConstraint("org_id", "container", "object_path", name="uq_assets_org_container_object_path"),
        Index(
            "ix_assets_org_project_ctype_created",
            "org_id",
            "project_id",
            "content_type",
            text("created_at DESC"),
        ),
        Index("ix_assets_folder_id", "folder_id"),
    )

    id: Mapped[uuid.UUID] = mapped_column(UUID(as_uuid=True), primary_key=True, default=uuid.uuid4)
    project_id: Mapped[uuid.UUID | None] = mapped_column(
        UUID(as_uuid=True), ForeignKey("projects.id", ondelete="CASCADE"), nullable=True, index=True
    )
    folder_id: Mapped[uuid.UUID | None] = mapped_column(
        UUID(as_uuid=True), ForeignKey("asset_folders.id", ondelete="SET NULL"), nullable=True
    )
    # storage 좌표(S1 IStorageService container + objectPath). signRead/read 시 그대로 사용.
    container: Mapped[str] = mapped_column(Text, nullable=False)
    object_path: Mapped[str] = mapped_column(Text, nullable=False)
    name: Mapped[str] = mapped_column(Text, nullable=False)
    content_type: Mapped[str | None] = mapped_column(Text, nullable=True)
    size_bytes: Mapped[int] = mapped_column(
        BigInteger, nullable=False, server_default=text("0"), default=0
    )
    created_by: Mapped[uuid.UUID | None] = mapped_column(UUID(as_uuid=True), nullable=True)

    links: Mapped[list["AssetLink"]] = relationship(
        "AssetLink", back_populates="asset", cascade="all, delete-orphan", lazy="select"
    )


class AssetLink(Base, OrgScopedMixin, TimestampMixin):
    """asset ↔ 참조원(message/story/doc/manual) 링크. catch#4 SSOT(JSONB=denorm)."""

    __tablename__ = "asset_links"
    __table_args__ = (
        UniqueConstraint(
            "asset_id", "source_type", "source_id", name="uq_asset_links_asset_source"
        ),
        CheckConstraint(
            "source_type IN ('conversation_message','story','doc','manual')",
            name="ck_asset_links_source_type",
        ),
        Index("ix_asset_links_source", "source_type", "source_id"),
    )

    id: Mapped[uuid.UUID] = mapped_column(UUID(as_uuid=True), primary_key=True, default=uuid.uuid4)
    asset_id: Mapped[uuid.UUID] = mapped_column(
        UUID(as_uuid=True), ForeignKey("assets.id", ondelete="CASCADE"), nullable=False, index=True
    )
    source_type: Mapped[str] = mapped_column(Text, nullable=False)
    # manual 링크는 source_id NULL. 그 외는 message/story/doc id.
    source_id: Mapped[uuid.UUID | None] = mapped_column(UUID(as_uuid=True), nullable=True)
    created_by: Mapped[uuid.UUID | None] = mapped_column(UUID(as_uuid=True), nullable=True)

    asset: Mapped["Asset"] = relationship("Asset", back_populates="links")
