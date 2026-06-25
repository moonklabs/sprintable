"""OB-4: onboarding_events 모델 (append-only funnel 계측).

측정계약 doc §2/§5. 키 평문 미저장(key_prefix prefix-only). server_ts=권위 시각(서버 스탬프).
"""
from __future__ import annotations

import uuid
from datetime import datetime

from sqlalchemy import DateTime, Text, func
from sqlalchemy.dialects.postgresql import JSONB, UUID
from sqlalchemy.orm import Mapped, mapped_column

from app.core.database import Base


class OnboardingEvent(Base):
    __tablename__ = "onboarding_events"

    id: Mapped[uuid.UUID] = mapped_column(UUID(as_uuid=True), primary_key=True, default=uuid.uuid4)
    event: Mapped[str] = mapped_column(Text, nullable=False)
    # session_id = FE wizard 조인 키(pre-auth↔post-auth 연결). agent_id = 발급 이후만.
    session_id: Mapped[uuid.UUID | None] = mapped_column(UUID(as_uuid=True), nullable=True)
    agent_id: Mapped[uuid.UUID | None] = mapped_column(UUID(as_uuid=True), nullable=True)
    org_id: Mapped[uuid.UUID | None] = mapped_column(UUID(as_uuid=True), nullable=True)
    project_id: Mapped[uuid.UUID | None] = mapped_column(UUID(as_uuid=True), nullable=True)
    runtime: Mapped[str | None] = mapped_column(Text, nullable=True)
    env: Mapped[str | None] = mapped_column(Text, nullable=True)
    transport: Mapped[str | None] = mapped_column(Text, nullable=True)
    key_prefix: Mapped[str | None] = mapped_column(Text, nullable=True)  # prefix-only(≤12)·평문키 금지
    failure_reason: Mapped[str | None] = mapped_column(Text, nullable=True)
    client_ts: Mapped[datetime | None] = mapped_column(DateTime(timezone=True), nullable=True)
    meta: Mapped[dict] = mapped_column(JSONB, nullable=False, default=dict)
    server_ts: Mapped[datetime] = mapped_column(
        DateTime(timezone=True), server_default=func.now(), nullable=False
    )
