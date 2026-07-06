import uuid
from datetime import datetime

from sqlalchemy import DateTime, Text, func
from sqlalchemy.dialects.postgresql import JSONB, UUID
from sqlalchemy.orm import Mapped, mapped_column

from app.core.database import Base


class A2ATask(Base):
    """E-A2A-POC S1(story 480e81fb): A2A Task 생명주기 저장소. PoC 스코프 — org_id/인증 없음
    (member_id로만 스코프, Phase 3서 org-scope+인증 추가 예정)."""

    __tablename__ = "a2a_tasks"

    id: Mapped[uuid.UUID] = mapped_column(UUID(as_uuid=True), primary_key=True, default=uuid.uuid4)
    # E-A2A-POC S2(story 1485217f): context_id = Sprintable conversation_id 그 자체(task-태깅
    # conversation). root_message_id = 그 conversation의 task-root 메시지 — CC가 이 메시지의
    # thread(reply_thread)에 답신하면 그게 곧 task 완료 신호(GetTask가 폴링, PO 크럭스 채택안).
    context_id: Mapped[uuid.UUID] = mapped_column(UUID(as_uuid=True), nullable=False, default=uuid.uuid4)
    root_message_id: Mapped[uuid.UUID | None] = mapped_column(UUID(as_uuid=True), nullable=True)
    member_id: Mapped[uuid.UUID] = mapped_column(UUID(as_uuid=True), nullable=False, index=True)
    state: Mapped[str] = mapped_column(Text, nullable=False, default="TASK_STATE_SUBMITTED")
    history: Mapped[list] = mapped_column(JSONB, nullable=False, default=list)
    artifacts: Mapped[list] = mapped_column(JSONB, nullable=False, default=list)
    task_metadata: Mapped[dict | None] = mapped_column(JSONB, nullable=True)
    created_at: Mapped[datetime] = mapped_column(
        DateTime(timezone=True), server_default=func.now(), nullable=False
    )
    updated_at: Mapped[datetime] = mapped_column(
        DateTime(timezone=True), server_default=func.now(), nullable=False
    )
