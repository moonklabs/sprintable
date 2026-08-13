"""story #2626/#2630: 무감독 연쇄 알림(에피소드 기반) + 서킷브레이커(집행)의 org 설정 표면.

`OrgGatePolicy`(hitl_config.py)와 동형 패턴 — org당 1행, 없으면 코드 기본값 폴백. #3016
글로벌 killswitch(`settings.chain_escalation_notify_enabled`)를 이 org-level `enabled`가
대체·은퇴한다(반쪽 은퇴 방지 — PO 조건①).

story #2630: `circuit_breaker_mode`/`circuit_breaker_release_mode`는 #2626 판별자(에피소드)
위에 얹는 집행 축 — `enabled`가 false면 판별 자체가 안 도니 이 둘은 안 쓰인다(판별 없이
집행 없음). release_mode 기본이 'manual'인 근거: auto는 "차단이 만든 침묵을 해소로 오독"
하는 되먹임이 있다(차단→velocity 하락→에피소드 해소→auto 해제→폭주 재개→재차단 — 폭주가
안 죽고 듀티사이클로 산다, 페드루 판정 2026-08-13). auto는 org 옵트인.
"""
import uuid
from datetime import datetime

from sqlalchemy import Boolean, CheckConstraint, DateTime, Integer, Text, func
from sqlalchemy.dialects.postgresql import UUID
from sqlalchemy.orm import Mapped, mapped_column

from app.core.database import Base

# 실측 근거(pgstat-probe-dev, 무인간 대화 44개·7일·3123메시지): 5분 윈도우 내 최대 메시지수
# p50=3·p90=6·p99=8·관측 max=8. 기본 임계는 관측 max의 ~2배 여유(PO 승인 2026-08-13).
DEFAULT_WINDOW_SECONDS = 300
DEFAULT_THRESHOLD = 15
# story #2630: 기본 on(block) — 스토리 원문 AC3 "차단이 원 목표". notify_only는 관측만
# 하던 #2626 구모드로 되돌리는 org 옵트아웃.
DEFAULT_CIRCUIT_BREAKER_MODE = "block"
# story #2630: 기본 manual — 위 모듈 docstring의 듀티사이클 되먹임 근거.
DEFAULT_CIRCUIT_BREAKER_RELEASE_MODE = "manual"


class ChainEscalationOrgConfig(Base):
    """org 수준 무감독 연쇄 알림+서킷브레이커 설정 — org당 1행. 없으면 위 DEFAULT_* 폴백."""
    __tablename__ = "chain_escalation_org_config"
    __table_args__ = (
        CheckConstraint(
            "circuit_breaker_mode IN ('block', 'notify_only')",
            name="ck_chain_escalation_org_config_circuit_breaker_mode",
        ),
        CheckConstraint(
            "circuit_breaker_release_mode IN ('manual', 'auto')",
            name="ck_chain_escalation_org_config_circuit_breaker_release_mode",
        ),
    )

    id: Mapped[uuid.UUID] = mapped_column(UUID(as_uuid=True), primary_key=True, default=uuid.uuid4)
    org_id: Mapped[uuid.UUID] = mapped_column(UUID(as_uuid=True), nullable=False, unique=True, index=True)
    enabled: Mapped[bool] = mapped_column(Boolean, nullable=False, server_default="true")
    window_seconds: Mapped[int] = mapped_column(
        Integer, nullable=False, server_default=str(DEFAULT_WINDOW_SECONDS)
    )
    threshold: Mapped[int] = mapped_column(Integer, nullable=False, server_default=str(DEFAULT_THRESHOLD))
    circuit_breaker_mode: Mapped[str] = mapped_column(
        Text, nullable=False, server_default=DEFAULT_CIRCUIT_BREAKER_MODE
    )
    circuit_breaker_release_mode: Mapped[str] = mapped_column(
        Text, nullable=False, server_default=DEFAULT_CIRCUIT_BREAKER_RELEASE_MODE
    )
    created_at: Mapped[datetime] = mapped_column(
        DateTime(timezone=True), server_default=func.now(), nullable=False
    )
    updated_at: Mapped[datetime] = mapped_column(
        DateTime(timezone=True), server_default=func.now(), onupdate=func.now(), nullable=False
    )
