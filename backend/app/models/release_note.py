"""릴리즈 노트 모델(E-POLISH 53bc0945·선생님 직접) — 하드코딩 RELEASE_NOTES 배열 de-hardcode.

릴노트는 **제품 전역**(전 org 동일)이라 org_id 없는 글로벌 테이블. `note_key`(text unique)는 FE
localStorage seen-key("2026-06-v1-4")와 동일 값 — 가시성 비교 무회귀 핵심. 정렬은 `published_at`
(timestamp) desc = newest-first. `display_period`("2026년 6월")는 표시용. CRUD = org owner/admin
(platform-admin 롤 부재·v1).
"""
from __future__ import annotations

import uuid
from datetime import datetime

from sqlalchemy import Boolean, DateTime, Text, text
from sqlalchemy.dialects.postgresql import JSONB, UUID
from sqlalchemy.orm import Mapped, mapped_column

from app.models.base import Base, TimestampMixin


class ReleaseNote(Base, TimestampMixin):
    """릴리즈 노트 1건(제품 전역·org 무관)."""

    __tablename__ = "release_notes"

    id: Mapped[uuid.UUID] = mapped_column(
        UUID(as_uuid=True), primary_key=True, default=uuid.uuid4
    )
    # FE localStorage seen-key 와 동일 문자열("2026-06-v1-4") — 가시성 비교 무회귀. unique.
    note_key: Mapped[str] = mapped_column(Text, nullable=False, unique=True)
    version: Mapped[str] = mapped_column(Text, nullable=False)
    # 정렬 기준(newest-first). display_period 는 표시 전용(정렬 불가 "2026년 6월").
    published_at: Mapped[datetime] = mapped_column(
        DateTime(timezone=True), nullable=False, index=True
    )
    display_period: Mapped[str] = mapped_column(Text, nullable=False)
    title: Mapped[str] = mapped_column(Text, nullable=False)
    summary: Mapped[str] = mapped_column(Text, nullable=False, server_default="", default="")
    # [{text: str, href?: str}, ...]
    items: Mapped[list] = mapped_column(
        JSONB, nullable=False, server_default=text("'[]'::jsonb"), default=list
    )
    is_published: Mapped[bool] = mapped_column(
        Boolean, nullable=False, server_default=text("true"), default=True, index=True
    )
