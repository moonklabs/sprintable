"""story #3506(Phase2·마케팅운영, 페드루 PO 確定 2026-09-05) — UTM 귀속 일별 집계.
`org_pageview_daily`(story #3354)의 (org_id, path, day) 골격에 utm_* 4키를 더한
그룹핑 축 — beacon이 utm_*을 실었을 때만 이 테이블에 upsert된다(적어도 하나라도
있을 때만, 순수 pageview와 분리)."""
from __future__ import annotations

import uuid
from datetime import date as date_type
from datetime import datetime

from sqlalchemy import Date, DateTime, Integer, Text, UniqueConstraint, func, text
from sqlalchemy.dialects.postgresql import UUID
from sqlalchemy.orm import Mapped, mapped_column

from app.core.database import Base


class OrgPageviewUtmDaily(Base):
    __tablename__ = "org_pageview_utm_daily"
    __table_args__ = (
        UniqueConstraint(
            "org_id", "path", "day", "utm_source", "utm_medium", "utm_campaign", "utm_content",
            name="uq_org_pageview_utm_daily_grouping",
        ),
    )

    id: Mapped[uuid.UUID] = mapped_column(UUID(as_uuid=True), primary_key=True, default=uuid.uuid4)
    org_id: Mapped[uuid.UUID] = mapped_column(UUID(as_uuid=True), nullable=False)
    path: Mapped[str] = mapped_column(Text, nullable=False)
    day: Mapped[date_type] = mapped_column(Date, nullable=False)
    # 그룹핑 키(측정값 아님 — null≠0 정규화 규약 적용 대상 아님). "이번 요청에 그 차원이
    # 없었다"는 빈 문자열로 표시한다(NULL이면 UNIQUE 제약이 매번 새 행으로 취급한다).
    utm_source: Mapped[str] = mapped_column(Text, nullable=False, server_default=text("''"))
    utm_medium: Mapped[str] = mapped_column(Text, nullable=False, server_default=text("''"))
    utm_campaign: Mapped[str] = mapped_column(Text, nullable=False, server_default=text("''"))
    utm_content: Mapped[str] = mapped_column(Text, nullable=False, server_default=text("''"))
    count: Mapped[int] = mapped_column(Integer, nullable=False, server_default=text("0"))
    created_at: Mapped[datetime] = mapped_column(
        DateTime(timezone=True), server_default=func.now(), nullable=False
    )
    updated_at: Mapped[datetime] = mapped_column(
        DateTime(timezone=True), server_default=func.now(), onupdate=func.now(), nullable=False
    )
