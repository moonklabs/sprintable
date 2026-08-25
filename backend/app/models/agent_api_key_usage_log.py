"""story #2087([BE] 에이전트 API 키 사용 이력 감사 트레일 부재) — 성공 인증 요청마다 1행.

story cd10e123 계열(mcp-dev AGENT_API_KEY 유출 인시던트, 2026-07-21) 조사 중 "악용 여부"를
증명도 반증도 못 한 근본원인 — 이 원장이 그 갭을 메운다.

append-only. FK 미부여(AgentAuthFailure와 동일 원칙) — 키가 회전/폐기되거나 멤버가 삭제돼도
그 시점까지의 사용 이력은 감사 목적상 그대로 남아야 한다(CASCADE로 지워지면 감사 트레일의
존재 이유 자체가 무너진다).

⚠️스로틀 없음(의도적, `_touch_api_key_last_used`(story #2457, 5분 스로틀)와 다름) — 그
스로틀은 last_used_at 값 자체가 대략적 시각이면 충분해 볼륨 절감이 이득이었지만, 이
원장의 존재 이유는 「모든 호출」의 완전성이다(오늘 실제로 이 완전성 부재 때문에 조사가
막혔다) — 샘플링하면 원장의 목적 자체가 무효화된다."""
from __future__ import annotations

import uuid
from datetime import datetime

from sqlalchemy import DateTime, Index, Text, func
from sqlalchemy.dialects.postgresql import UUID
from sqlalchemy.orm import Mapped, mapped_column

from app.core.database import Base


class AgentApiKeyUsageLog(Base):
    __tablename__ = "agent_api_key_usage_logs"
    __table_args__ = (
        Index("ix_agent_api_key_usage_logs_key_occurred", "api_key_id", "occurred_at"),
    )

    id: Mapped[uuid.UUID] = mapped_column(UUID(as_uuid=True), primary_key=True, default=uuid.uuid4)
    api_key_id: Mapped[uuid.UUID] = mapped_column(UUID(as_uuid=True), nullable=False, index=True)
    # invalid 판정 없이(성공 인증만 기록) 항상 알려진 값이나, AgentAuthFailure와 동일하게
    # nullable로 둔다 — org 해소 자체가 실패해도(방어적) 기록 자체는 남아야 하므로.
    org_id: Mapped[uuid.UUID | None] = mapped_column(UUID(as_uuid=True), nullable=True, index=True)
    member_id: Mapped[uuid.UUID | None] = mapped_column(UUID(as_uuid=True), nullable=True)
    endpoint: Mapped[str] = mapped_column(Text, nullable=False)
    method: Mapped[str] = mapped_column(Text, nullable=False)
    remote_ip: Mapped[str | None] = mapped_column(Text, nullable=True)
    occurred_at: Mapped[datetime] = mapped_column(
        DateTime(timezone=True), server_default=func.now(), nullable=False
    )
