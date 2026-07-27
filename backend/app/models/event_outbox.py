"""E-ARCH S3(story #2078): 트랜잭셔널 아웃박스 스캐폴딩.

3a단계(현재) — `EventBroker` 호출부(20곳, 전부 `session.commit()` 이후 fire-and-forget)의
타이밍은 그대로 두고, `event_outbox` row insert만 얹어 durable·재시도 가능한 큐를 얻는다.
아직 진짜 atomic outbox는 아니다(insert가 caller의 commit과 별 트랜잭션) — 3b단계에서
콜사이트를 "커밋 전 insert"로 하나씩 이관해야 진짜 원자성이 선다(설계 문서 참조).
"""
from __future__ import annotations

import uuid
from datetime import datetime

from sqlalchemy import DateTime, Index, Text, func, text
from sqlalchemy.dialects.postgresql import JSONB, UUID
from sqlalchemy.orm import Mapped, mapped_column

from app.core.database import Base


class EventOutbox(Base):
    __tablename__ = "event_outbox"

    id: Mapped[uuid.UUID] = mapped_column(UUID(as_uuid=True), primary_key=True, default=uuid.uuid4)
    org_id: Mapped[uuid.UUID] = mapped_column(UUID(as_uuid=True), nullable=False, index=True)
    target: Mapped[str] = mapped_column(Text, nullable=False)  # "org" | "agent"
    target_id: Mapped[uuid.UUID] = mapped_column(UUID(as_uuid=True), nullable=False)
    event_type: Mapped[str] = mapped_column(Text, nullable=False)
    payload: Mapped[dict] = mapped_column(JSONB, nullable=False, default=dict)
    created_at: Mapped[datetime] = mapped_column(
        DateTime(timezone=True), server_default=func.now(), nullable=False
    )
    published_at: Mapped[datetime | None] = mapped_column(DateTime(timezone=True), nullable=True)

    __table_args__ = (
        # dispatcher 폴링 축 — published_at IS NULL 부분 인덱스(대부분 즉시 pending→published라
        # 실제 unpublished row는 항상 소수, 부분 인덱스로 스캔 비용 최소화).
        Index("ix_event_outbox_pending", "id", postgresql_where=text("published_at IS NULL")),
    )
