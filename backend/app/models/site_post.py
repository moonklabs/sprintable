"""story #3360(발행 구조·서버, 선생님 확定 2026-09-03) — 자사(및 다른 조직) 사이트 글을 코드
저장소 커밋이 아니라 서버 행 1개로 저장한다. 발행 = 승인 게이트(external_publish) 통과한 글
1행 — 배포 0·커밋 0. unique(org_id, lang, slug) — 재발행은 같은 행 upsert(githubcommit
이력 대신 이 행 자체의 created_at/gate_id가 승인 증거가 된다, story 본문 §3)."""
from __future__ import annotations

import uuid
from datetime import datetime

from sqlalchemy import DateTime, Text, UniqueConstraint, func
from sqlalchemy.dialects.postgresql import JSONB, UUID
from sqlalchemy.orm import Mapped, mapped_column

from app.core.database import Base


class SitePost(Base):
    __tablename__ = "site_posts"
    __table_args__ = (
        UniqueConstraint("org_id", "lang", "slug", name="uq_site_posts_org_lang_slug"),
    )

    id: Mapped[uuid.UUID] = mapped_column(UUID(as_uuid=True), primary_key=True, default=uuid.uuid4)
    org_id: Mapped[uuid.UUID] = mapped_column(UUID(as_uuid=True), nullable=False, index=True)
    lang: Mapped[str] = mapped_column(Text, nullable=False)
    slug: Mapped[str] = mapped_column(Text, nullable=False)
    title: Mapped[str] = mapped_column(Text, nullable=False)
    summary: Mapped[str] = mapped_column(Text, nullable=False)
    tags: Mapped[list] = mapped_column(JSONB, nullable=False, server_default="[]")
    body_md: Mapped[str] = mapped_column(Text, nullable=False)
    published_at: Mapped[datetime] = mapped_column(DateTime(timezone=True), nullable=False)
    # work_item_id로 body에 받지만 이 스토리의 발행 대상은 항상 story라 컬럼명은 명세 그대로
    # source_story_id(다른 work_item_type이 생기면 그때 컬럼을 넓힌다 — 지금 지어내지 않음).
    source_story_id: Mapped[uuid.UUID] = mapped_column(UUID(as_uuid=True), nullable=False)
    gate_id: Mapped[uuid.UUID] = mapped_column(UUID(as_uuid=True), nullable=False)
    created_by_member_id: Mapped[uuid.UUID] = mapped_column(UUID(as_uuid=True), nullable=False)
    unpublished_at: Mapped[datetime | None] = mapped_column(DateTime(timezone=True), nullable=True)
    created_at: Mapped[datetime] = mapped_column(
        DateTime(timezone=True), server_default=func.now(), nullable=False
    )
    updated_at: Mapped[datetime] = mapped_column(
        DateTime(timezone=True), server_default=func.now(), onupdate=func.now(), nullable=False
    )
