"""story #3354(마케팅자동화·측정, 페드루 PO 확定 2026-09-03) — 공개 글 페이지 조회수 일별
집계. (org_id, path, day) 축으로 upsert(standup.py의 (member, date) unique와 동형 골격) —
UA/IP/쿠키는 여기 안 온다(dedup은 순수 in-memory/redis 레이트리밋 키로만, 영속 저장 0 —
개인정보 0 원칙, PO AC)."""
from __future__ import annotations

import uuid
from datetime import date as date_type
from datetime import datetime

from sqlalchemy import Date, DateTime, Index, Integer, Text, UniqueConstraint, func, text
from sqlalchemy.dialects.postgresql import UUID
from sqlalchemy.orm import Mapped, mapped_column

from app.core.database import Base


class OrgPageviewDaily(Base):
    __tablename__ = "org_pageview_daily"
    __table_args__ = (
        UniqueConstraint("org_id", "path", "day", name="uq_org_pageview_daily_org_path_day"),
        Index("ix_org_pageview_daily_org_path", "org_id", "path"),
    )

    id: Mapped[uuid.UUID] = mapped_column(UUID(as_uuid=True), primary_key=True, default=uuid.uuid4)
    org_id: Mapped[uuid.UUID] = mapped_column(UUID(as_uuid=True), nullable=False)
    path: Mapped[str] = mapped_column(Text, nullable=False)
    day: Mapped[date_type] = mapped_column(Date, nullable=False)
    count: Mapped[int] = mapped_column(Integer, nullable=False, server_default=text("0"))
    created_at: Mapped[datetime] = mapped_column(
        DateTime(timezone=True), server_default=func.now(), nullable=False
    )
    updated_at: Mapped[datetime] = mapped_column(
        DateTime(timezone=True), server_default=func.now(), onupdate=func.now(), nullable=False
    )
