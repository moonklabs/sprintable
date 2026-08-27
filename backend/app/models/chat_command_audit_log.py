"""story #3143(9a5abc24, Chat ②층 P1 BE) — 서버 집행 커맨드(/done·/assign·/priority) 감사 로그.

기존 `AgentAuditLog`(agent_id NOT NULL — 휴먼 발신 커맨드를 못 담음)·`AuditLog`
(permission_audit_logs, role 변경 전용 스키마)는 둘 다 이 용도에 맞지 않는다(전자는 발신자
축이 좁고, 후자는 old_role/new_role/target_user_id가 이 도메인과 무관) — 새 테이블로 분리.

actor_type: 'human' | 'agent'(auth.claims.api_key_id 유무로 판정, gate_service.py의
동일 관례 재사용). outcome: 'executed' | 'denied' | 'not_found' | 'ambiguous' | 'invalid_args'.
before_value/after_value는 필드 하나만 다루는 커맨드 특성상 단일 스칼라 문자열로 충분
(json 값 강제 지어내지 않음 — before는 실패 케이스에서 None일 수 있다).
"""
from __future__ import annotations

import uuid
from datetime import datetime

from sqlalchemy import DateTime, Text, func
from sqlalchemy.dialects.postgresql import JSONB, UUID
from sqlalchemy.orm import Mapped, mapped_column

from app.core.database import Base


class ChatCommandAuditLog(Base):
    __tablename__ = "chat_command_audit_logs"

    id: Mapped[uuid.UUID] = mapped_column(UUID(as_uuid=True), primary_key=True, default=uuid.uuid4)
    org_id: Mapped[uuid.UUID] = mapped_column(UUID(as_uuid=True), nullable=False, index=True)
    project_id: Mapped[uuid.UUID | None] = mapped_column(UUID(as_uuid=True), nullable=True)
    conversation_id: Mapped[uuid.UUID] = mapped_column(UUID(as_uuid=True), nullable=False)
    message_id: Mapped[uuid.UUID] = mapped_column(UUID(as_uuid=True), nullable=False)
    actor_id: Mapped[uuid.UUID] = mapped_column(UUID(as_uuid=True), nullable=False)
    actor_type: Mapped[str] = mapped_column(Text, nullable=False)
    command: Mapped[str] = mapped_column(Text, nullable=False)
    raw_args: Mapped[str] = mapped_column(Text, nullable=False)
    target_type: Mapped[str | None] = mapped_column(Text, nullable=True)
    target_id: Mapped[uuid.UUID | None] = mapped_column(UUID(as_uuid=True), nullable=True)
    outcome: Mapped[str] = mapped_column(Text, nullable=False)
    before_value: Mapped[str | None] = mapped_column(Text, nullable=True)
    after_value: Mapped[str | None] = mapped_column(Text, nullable=True)
    reason: Mapped[str | None] = mapped_column(Text, nullable=True)
    audit_metadata: Mapped[dict] = mapped_column("metadata", JSONB, nullable=False, default=dict)
    created_at: Mapped[datetime] = mapped_column(
        DateTime(timezone=True), server_default=func.now(), nullable=False
    )
