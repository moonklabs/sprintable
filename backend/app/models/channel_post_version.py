"""story #3374(Phase1·마케팅운영) — 채널 포스트 초안의 불변 버전 원장. `SitePostVersion`
(site_post_version.py)과 구조 미러 — 편집은 기존 행을 덮지 않고 새 버전을 추가한다.

`body_sha256`은 `text`·`link_url`만으로 계산한다(`gate_seal.compute_seal_hash({"text":...,
"link_url":...})`) — `channel`은 draft가 고정하는 배달 경로 속성이라(내용이 아니다) 편집
때마다 안 바뀔 값을 해시에 섞지 않는다(site_post_version의 slug/lang 미포함과 같은 논리).

`image_sha256`(story 620beefc, PO 決定 ④) — 이 버전이 봉인하는 이미지의 「나가는 파생본」
sha256(`ChannelPostImage.final_sha256`) — **`body_sha256`과 의도적으로 분리된 별도 축**.
합치면 재승인 사유(`CONTENT_CHANGED` vs `MEDIA_CHANGED`)를 서버가 다시 구별 못 한다(AC4
"판정 축 세분화"). 이미지가 없거나(텍스트만) 이전 버전에서 캐리포워드됐으면 그 값 그대로
— `create_channel_post_draft_version`이 명시 전달 안 하면 직전 버전 값을 그대로 이어간다
(text/link_url처럼 "매번 다시 보내야" 하는 필드가 아니다 — 이미지 첨부용 별도 엔드포인트가
있고, 일반 텍스트 편집이 이미지를 조용히 떨어뜨리면 안 되므로)."""
from __future__ import annotations

import uuid
from datetime import datetime

from sqlalchemy import DateTime, ForeignKey, Text, UniqueConstraint, func
from sqlalchemy.dialects.postgresql import UUID
from sqlalchemy.orm import Mapped, mapped_column

from app.core.database import Base


class ChannelPostVersion(Base):
    __tablename__ = "channel_post_versions"
    __table_args__ = (
        UniqueConstraint("draft_id", "version", name="uq_channel_post_versions_draft_version"),
    )

    id: Mapped[uuid.UUID] = mapped_column(UUID(as_uuid=True), primary_key=True, default=uuid.uuid4)
    draft_id: Mapped[uuid.UUID] = mapped_column(
        UUID(as_uuid=True), ForeignKey("channel_post_drafts.id"), nullable=False, index=True
    )
    version: Mapped[int] = mapped_column(nullable=False)
    text: Mapped[str] = mapped_column(Text, nullable=False)
    link_url: Mapped[str | None] = mapped_column(Text, nullable=True)
    body_sha256: Mapped[str] = mapped_column(Text, nullable=False)
    image_sha256: Mapped[str | None] = mapped_column(Text, nullable=True)
    author_member_id: Mapped[uuid.UUID] = mapped_column(UUID(as_uuid=True), nullable=False)
    author_kind: Mapped[str] = mapped_column(Text, nullable=False)
    created_at: Mapped[datetime] = mapped_column(
        DateTime(timezone=True), server_default=func.now(), nullable=False
    )
