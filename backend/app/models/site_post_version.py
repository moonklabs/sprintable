"""story #3365(Phase0 S1) — 초안의 불변 버전 원장. 휴먼이 본문을 고치면 기존 행을 덮지 않고
새 버전을 추가한다(``version`` 오름차순, draft당 유일) — 에이전트 원안과 휴먼 개정본이
별도 행으로 남아 이력 조회가 항상 가능하다(AC6). `body_sha256`은 S2(승인 봉인)가 "승인한
버전=공개될 버전"을 증명하는 데 재사용할 canonical 해시 — 여기선 그냥 계산해 둔다.

필드명은 유나군 S4 화면 설계(문서 62fc03ee §4-3, 페드루 PO 확定 2026-09-03)가 요구하는
Phase 1 원장 어휘(content_version 승격 예정)에 맞춘다: ``version``·``body_sha256``·
``author_kind``·``author_member_id`` — 여기서 굳혀 두면 S2·S4가 이름을 다시 안 맞춰도 된다."""
from __future__ import annotations

import uuid
from datetime import datetime

from sqlalchemy import DateTime, ForeignKey, Text, UniqueConstraint, func
from sqlalchemy.dialects.postgresql import JSONB, UUID
from sqlalchemy.orm import Mapped, mapped_column

from app.core.database import Base


class SitePostVersion(Base):
    __tablename__ = "site_post_versions"
    __table_args__ = (
        UniqueConstraint("draft_id", "version", name="uq_site_post_versions_draft_version"),
    )

    id: Mapped[uuid.UUID] = mapped_column(UUID(as_uuid=True), primary_key=True, default=uuid.uuid4)
    draft_id: Mapped[uuid.UUID] = mapped_column(
        UUID(as_uuid=True), ForeignKey("site_post_drafts.id"), nullable=False, index=True
    )
    version: Mapped[int] = mapped_column(nullable=False)
    title: Mapped[str] = mapped_column(Text, nullable=False)
    lang: Mapped[str] = mapped_column(Text, nullable=False)
    summary: Mapped[str] = mapped_column(Text, nullable=False)
    tags: Mapped[list] = mapped_column(JSONB, nullable=False, server_default="[]")
    body_md: Mapped[str] = mapped_column(Text, nullable=False)
    body_sha256: Mapped[str] = mapped_column(Text, nullable=False)
    author_member_id: Mapped[uuid.UUID] = mapped_column(UUID(as_uuid=True), nullable=False)
    author_kind: Mapped[str] = mapped_column(Text, nullable=False)
    created_at: Mapped[datetime] = mapped_column(
        DateTime(timezone=True), server_default=func.now(), nullable=False
    )
