"""story #3374(Phase1·마케팅운영, 페드루 PO 확定 2026-09-03) — 채널(Threads 등) 포스트
초안 원장. `SitePostDraft`(site_post_draft.py)와 구조가 미러(초안→버전→external_publish
게이트→봉인)이지만 페이로드가 달라(단일 text·link_url·대상 channel/connection) **별도
테이블**로 연다(PO 결정 — 억지 일반화 금지).

`channel`은 `connection_id`의 파생값이다(채널 연결 서비스 골격, story #3373 — 한 채널에
여러 계정이 있을 수 있어 `channel` 자체는 독립 식별축이 아니다) — 그래서 유니크 제약은
`(org_id, work_item_id, channel)`이 아니라 `(org_id, work_item_id, connection_id)`(PO
정정, 제안 당시 스냅샷과 다름). `channel` 컬럼은 초안 생성 시 `connection_id`로 조회한
`ChannelConnection.channel`을 그대로 복사해 둔 것 — 목록·필터가 매번 조인하지 않아도 되게
하는 denormalize다(connection 삭제 후에도 "무슨 채널이었는지"가 남는다).

`source_content_item_id`(story #3437, 페드루 PO 確定 2026-09-04) — 이 채널 변형이 파생된
content_item(=SitePostDraft.id). FK 없음(이 도메인 전체 관례) — org 일치는 서비스 계층이
초안 생성 시 검증한다(다른 조직 원문 참조는 422). nullable — 소스 없는 단독 채널 초안도
기존처럼 허용(회귀, AC6)."""
from __future__ import annotations

import uuid
from datetime import datetime

from sqlalchemy import DateTime, Text, UniqueConstraint, func
from sqlalchemy.dialects.postgresql import UUID
from sqlalchemy.orm import Mapped, mapped_column

from app.core.database import Base


class ChannelPostDraft(Base):
    __tablename__ = "channel_post_drafts"
    __table_args__ = (
        UniqueConstraint(
            "org_id", "work_item_id", "connection_id", name="uq_channel_post_drafts_org_work_item_connection",
        ),
    )

    id: Mapped[uuid.UUID] = mapped_column(UUID(as_uuid=True), primary_key=True, default=uuid.uuid4)
    org_id: Mapped[uuid.UUID] = mapped_column(UUID(as_uuid=True), nullable=False, index=True)
    work_item_id: Mapped[uuid.UUID] = mapped_column(UUID(as_uuid=True), nullable=False)
    channel: Mapped[str] = mapped_column(Text, nullable=False)
    # FK 없음 — channel_connections도 FK 없음 관례(그라운딩 6766a399 §9). 존재+status=active
    # 검증은 서비스 층에서 매번(초안 생성·상신 시점) 한다.
    connection_id: Mapped[uuid.UUID] = mapped_column(UUID(as_uuid=True), nullable=False)
    status: Mapped[str] = mapped_column(Text, nullable=False, server_default="draft")
    source_content_item_id: Mapped[uuid.UUID | None] = mapped_column(
        UUID(as_uuid=True), nullable=True, index=True
    )
    created_at: Mapped[datetime] = mapped_column(
        DateTime(timezone=True), server_default=func.now(), nullable=False
    )
    updated_at: Mapped[datetime] = mapped_column(
        DateTime(timezone=True), server_default=func.now(), onupdate=func.now(), nullable=False
    )
