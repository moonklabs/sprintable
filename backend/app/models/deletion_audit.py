"""E-SECURITY SEC-S1(story 70c9e92c): hard-delete 감사 — 삭제 경로 흔적 0 해소.

기존 audit 테이블은 전부 부적합: `permission_audit_logs`(role 변경 shape)·`story_activities`
(story_id FK ondelete=CASCADE라 삭제 자체와 함께 사라져 감사 목적 무의미)·`agent_audit_logs`
(agent_id NOT NULL — 삭제는 이제 휴먼 전용이라 안 맞음). entity_type 범용이라 story 외 삭제
경로 확장 시(향후) 재사용 가능."""
import uuid
from datetime import datetime

from sqlalchemy import DateTime, Text, func
from sqlalchemy.dialects.postgresql import UUID
from sqlalchemy.orm import Mapped, mapped_column

from app.core.database import Base


class DeletionAuditLog(Base):
    __tablename__ = "deletion_audit_logs"

    id: Mapped[uuid.UUID] = mapped_column(UUID(as_uuid=True), primary_key=True, default=uuid.uuid4)
    org_id: Mapped[uuid.UUID] = mapped_column(UUID(as_uuid=True), nullable=False, index=True)
    actor_id: Mapped[uuid.UUID] = mapped_column(UUID(as_uuid=True), nullable=False)
    entity_type: Mapped[str] = mapped_column(Text, nullable=False)
    entity_id: Mapped[uuid.UUID] = mapped_column(UUID(as_uuid=True), nullable=False, index=True)
    entity_title: Mapped[str | None] = mapped_column(Text, nullable=True)
    created_at: Mapped[datetime] = mapped_column(
        DateTime(timezone=True), server_default=func.now(), nullable=False
    )
