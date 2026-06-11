from __future__ import annotations

import uuid
from datetime import datetime

from sqlalchemy import BigInteger, DateTime, Identity, Index, Text, func, text
from sqlalchemy.dialects.postgresql import ARRAY, JSONB, UUID
from sqlalchemy.orm import Mapped, mapped_column

from app.core.database import Base


class ActivityEvent(Base):
    """L1 canonical 활동 그래프 행(0116 마이그 정합). events를 정규화·dedup한 1급 활동.

    activity_seq는 Identity(DB 생성) — INSERT 시 명시 금지(0072 gateway_seq GeneratedAlways
    교훈). source_event_ids/recipient_ids는 같은 dedup_key fan-out을 누적(array union).
    """

    __tablename__ = "activity_events"

    # 0116 마이그와 정합(이름·컬럼 동일). create_all 기반 테스트·ON CONFLICT가 unique 인덱스를
    # 찾도록 모델에도 선언한다.
    __table_args__ = (
        Index("uq_activity_events_org_dedup", "org_id", "dedup_key", unique=True),
        Index("ix_activity_events_project_time", "org_id", "project_id", text("occurred_at DESC")),
        Index("ix_activity_events_actor_time", "org_id", "actor_id", text("occurred_at DESC")),
        Index("ix_activity_events_object_time", "org_id", "object_type", "object_id", text("occurred_at DESC")),
        Index("ix_activity_events_verb_time", "org_id", "verb", text("occurred_at DESC")),
    )

    activity_id: Mapped[uuid.UUID] = mapped_column(UUID(as_uuid=True), primary_key=True, default=uuid.uuid4)
    org_id: Mapped[uuid.UUID] = mapped_column(UUID(as_uuid=True), nullable=False)
    project_id: Mapped[uuid.UUID] = mapped_column(UUID(as_uuid=True), nullable=False)
    actor_id: Mapped[uuid.UUID | None] = mapped_column(UUID(as_uuid=True), nullable=True)
    verb: Mapped[str] = mapped_column(Text, nullable=False)
    object_type: Mapped[str | None] = mapped_column(Text, nullable=True)
    object_id: Mapped[uuid.UUID | None] = mapped_column(UUID(as_uuid=True), nullable=True)
    occurred_at: Mapped[datetime] = mapped_column(DateTime(timezone=True), nullable=False)
    representative_event_id: Mapped[uuid.UUID | None] = mapped_column(UUID(as_uuid=True), nullable=True)
    source_event_ids: Mapped[list[uuid.UUID]] = mapped_column(
        ARRAY(UUID(as_uuid=True)), nullable=False, server_default="{}"
    )
    recipient_ids: Mapped[list[uuid.UUID]] = mapped_column(
        ARRAY(UUID(as_uuid=True)), nullable=False, server_default="{}"
    )
    recipient_types: Mapped[list[str]] = mapped_column(ARRAY(Text), nullable=False, server_default="{}")
    payload: Mapped[dict] = mapped_column(JSONB, nullable=False, server_default=text("'{}'::jsonb"))
    dedup_key: Mapped[str] = mapped_column(Text, nullable=False)
    activity_seq: Mapped[int] = mapped_column(BigInteger, Identity(), nullable=False)
    created_at: Mapped[datetime] = mapped_column(
        DateTime(timezone=True), server_default=func.now(), nullable=False
    )
