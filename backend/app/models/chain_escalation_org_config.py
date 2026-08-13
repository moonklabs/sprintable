"""story #2626: 무감독 연쇄 알림(에피소드 기반)의 org 설정 표면.

`OrgGatePolicy`(hitl_config.py)와 동형 패턴 — org당 1행, 없으면 코드 기본값 폴백. #3016
글로벌 killswitch(`settings.chain_escalation_notify_enabled`)를 이 org-level `enabled`가
대체·은퇴한다(반쪽 은퇴 방지 — PO 조건①).
"""
import uuid
from datetime import datetime

from sqlalchemy import Boolean, DateTime, Integer, func
from sqlalchemy.dialects.postgresql import UUID
from sqlalchemy.orm import Mapped, mapped_column

from app.core.database import Base

# 실측 근거(pgstat-probe-dev, 무인간 대화 44개·7일·3123메시지): 5분 윈도우 내 최대 메시지수
# p50=3·p90=6·p99=8·관측 max=8. 기본 임계는 관측 max의 ~2배 여유(PO 승인 2026-08-13).
DEFAULT_WINDOW_SECONDS = 300
DEFAULT_THRESHOLD = 15


class ChainEscalationOrgConfig(Base):
    """org 수준 무감독 연쇄 알림 설정 — org당 1행. 없으면 위 DEFAULT_* 폴백."""
    __tablename__ = "chain_escalation_org_config"

    id: Mapped[uuid.UUID] = mapped_column(UUID(as_uuid=True), primary_key=True, default=uuid.uuid4)
    org_id: Mapped[uuid.UUID] = mapped_column(UUID(as_uuid=True), nullable=False, unique=True, index=True)
    enabled: Mapped[bool] = mapped_column(Boolean, nullable=False, server_default="true")
    window_seconds: Mapped[int] = mapped_column(
        Integer, nullable=False, server_default=str(DEFAULT_WINDOW_SECONDS)
    )
    threshold: Mapped[int] = mapped_column(Integer, nullable=False, server_default=str(DEFAULT_THRESHOLD))
    created_at: Mapped[datetime] = mapped_column(
        DateTime(timezone=True), server_default=func.now(), nullable=False
    )
    updated_at: Mapped[datetime] = mapped_column(
        DateTime(timezone=True), server_default=func.now(), onupdate=func.now(), nullable=False
    )
