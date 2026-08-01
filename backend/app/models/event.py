from __future__ import annotations

import uuid
from datetime import datetime

from sqlalchemy import DateTime, Enum, ForeignKey, Text, func
from sqlalchemy.dialects.postgresql import JSONB, UUID
from sqlalchemy.orm import Mapped, mapped_column

from app.core.database import Base
from app.models.base import OrgScopedMixin

import enum


class EventType(str, enum.Enum):
    # story #2379 — memo_created/memo_replied 제거(2026-08-01). 전수 grep(프로덕션+테스트)
    # 결과 `EventType.memo_created`/`EventType.memo_replied` 속성 접근이 어디에도 없었다 —
    # events.event_type 컬럼 자체가 Text(native enum 아님)라 역직렬화 경로도 없다. 살아 있는
    # memo 기능(SaaS webhook 발송 등)은 이 enum을 거치지 않으므로 영향 없음.
    dispatched = "dispatched"
    status_changed = "status_changed"


class EventSourceEntityType(str, enum.Enum):
    memo = "memo"
    story = "story"
    epic = "epic"
    doc = "doc"
    sprint = "sprint"


class EventRecipientType(str, enum.Enum):
    agent = "agent"
    human = "human"


class EventStatus(str, enum.Enum):
    pending = "pending"
    delivered = "delivered"
    failed = "failed"


class Event(Base, OrgScopedMixin):
    __tablename__ = "events"

    id: Mapped[uuid.UUID] = mapped_column(UUID(as_uuid=True), primary_key=True, default=uuid.uuid4)
    project_id: Mapped[uuid.UUID] = mapped_column(
        UUID(as_uuid=True), ForeignKey("projects.id", ondelete="CASCADE"), nullable=False, index=True
    )
    event_type: Mapped[str] = mapped_column(Text, nullable=False)
    source_entity_type: Mapped[str | None] = mapped_column(Text, nullable=True)
    source_entity_id: Mapped[uuid.UUID | None] = mapped_column(UUID(as_uuid=True), nullable=True)
    sender_id: Mapped[uuid.UUID | None] = mapped_column(
        UUID(as_uuid=True), ForeignKey("team_members.id", ondelete="SET NULL"), nullable=True
    )
    recipient_id: Mapped[uuid.UUID] = mapped_column(
        UUID(as_uuid=True), ForeignKey("team_members.id", ondelete="CASCADE"), nullable=False
    )
    recipient_type: Mapped[str] = mapped_column(Text, nullable=False)
    payload: Mapped[dict] = mapped_column(JSONB, nullable=False, default=dict)
    status: Mapped[str] = mapped_column(Text, nullable=False, default=EventStatus.pending.value)
    recipient_seq: Mapped[int | None] = mapped_column(nullable=True)
    created_at: Mapped[datetime] = mapped_column(
        DateTime(timezone=True), server_default=func.now(), nullable=False
    )
    delivered_at: Mapped[datetime | None] = mapped_column(DateTime(timezone=True), nullable=True)
    read_at: Mapped[datetime | None] = mapped_column(DateTime(timezone=True), nullable=True)
