"""story #3437(Phase1·마케팅운영, 페드루 PO 確定 2026-09-04) — 콘텐츠 원장(블루프린트 v3
§3) `campaign` 단. 여러 content_item(=site_post_drafts, story 코멘트 그라운딩
결론)을 묶는 최소 단위 — 조직·이름·기간·상태만 갖는다. FK 없음 — site_post_drafts/
channel_post_drafts를 포함한 이 도메인 전체가 FK 미사용 관례(그라운딩 §9)를 그대로 따른다.

campaign 소속은 필수가 아니다(AC3 "campaign 없는 단독 글 허용") — 이 모델 자체가 그 사실을
강제하지는 않는다(강제하는 쪽은 site_post_drafts.campaign_id가 nullable이라는 것)."""
from __future__ import annotations

import uuid
from datetime import datetime

from sqlalchemy import DateTime, Text, func
from sqlalchemy.dialects.postgresql import UUID
from sqlalchemy.orm import Mapped, mapped_column

from app.core.database import Base


class Campaign(Base):
    __tablename__ = "campaigns"

    id: Mapped[uuid.UUID] = mapped_column(UUID(as_uuid=True), primary_key=True, default=uuid.uuid4)
    org_id: Mapped[uuid.UUID] = mapped_column(UUID(as_uuid=True), nullable=False, index=True)
    name: Mapped[str] = mapped_column(Text, nullable=False)
    starts_at: Mapped[datetime | None] = mapped_column(DateTime(timezone=True), nullable=True)
    ends_at: Mapped[datetime | None] = mapped_column(DateTime(timezone=True), nullable=True)
    status: Mapped[str] = mapped_column(Text, nullable=False, server_default="active")
    created_by_member_id: Mapped[uuid.UUID] = mapped_column(UUID(as_uuid=True), nullable=False)
    created_at: Mapped[datetime] = mapped_column(
        DateTime(timezone=True), server_default=func.now(), nullable=False
    )
    updated_at: Mapped[datetime] = mapped_column(
        DateTime(timezone=True), server_default=func.now(), onupdate=func.now(), nullable=False
    )
