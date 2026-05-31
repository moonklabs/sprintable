"""E-CAGE-REFEREE P3: HITL gate config 모델.

설계 원칙: 플랫폼은 위험도 판정 안 함(risk_level 없음).
"뭐가 위험한가"는 조직 정책 — 공정한 링.

posture: conservative | balanced | permissive → default disposition 결정.
disposition: allow_auto | ask | deny.
gate_type: pr_review | qa | merge | deploy (확장 가능 String).
"""
import uuid
from datetime import datetime

from sqlalchemy import DateTime, ForeignKey, String, func
from sqlalchemy.dialects.postgresql import UUID
from sqlalchemy.orm import Mapped, mapped_column

from app.core.database import Base
from app.models.base import OrgScopedMixin

POSTURES = frozenset({"conservative", "balanced", "permissive"})
DISPOSITIONS = frozenset({"allow_auto", "ask", "deny"})
GATE_TYPES = frozenset({"pr_review", "qa", "merge", "deploy"})

_POSTURE_DEFAULT: dict[str, str] = {
    "conservative": "ask",
    "balanced": "ask",
    "permissive": "allow_auto",
}
SYSTEM_DEFAULT_DISPOSITION = "ask"


def posture_to_disposition(posture: str) -> str:
    return _POSTURE_DEFAULT.get(posture, SYSTEM_DEFAULT_DISPOSITION)


class OrgGatePolicy(Base):
    """org 수준 기본 posture — org당 1행."""
    __tablename__ = "org_gate_policy"

    id: Mapped[uuid.UUID] = mapped_column(UUID(as_uuid=True), primary_key=True, default=uuid.uuid4)
    org_id: Mapped[uuid.UUID] = mapped_column(UUID(as_uuid=True), nullable=False, unique=True, index=True)
    posture: Mapped[str] = mapped_column(String(20), nullable=False, server_default="balanced")
    created_at: Mapped[datetime] = mapped_column(
        DateTime(timezone=True), server_default=func.now(), nullable=False
    )
    updated_at: Mapped[datetime] = mapped_column(
        DateTime(timezone=True), server_default=func.now(), onupdate=func.now(), nullable=False
    )


class OrgGateOverride(Base):
    """org 수준 역할(role) × gate_type 오버라이드."""
    __tablename__ = "org_gate_override"

    id: Mapped[uuid.UUID] = mapped_column(UUID(as_uuid=True), primary_key=True, default=uuid.uuid4)
    org_id: Mapped[uuid.UUID] = mapped_column(UUID(as_uuid=True), nullable=False, index=True)
    role_id: Mapped[uuid.UUID] = mapped_column(
        UUID(as_uuid=True), ForeignKey("participation_role.id", ondelete="CASCADE"), nullable=False
    )
    gate_type: Mapped[str] = mapped_column(String(50), nullable=False)
    disposition: Mapped[str] = mapped_column(String(20), nullable=False)
    created_at: Mapped[datetime] = mapped_column(
        DateTime(timezone=True), server_default=func.now(), nullable=False
    )


class MemberGateOverride(Base):
    """개별 member × gate_type 예외 — org override보다 우선."""
    __tablename__ = "member_gate_override"

    id: Mapped[uuid.UUID] = mapped_column(UUID(as_uuid=True), primary_key=True, default=uuid.uuid4)
    org_id: Mapped[uuid.UUID] = mapped_column(UUID(as_uuid=True), nullable=False, index=True)
    member_id: Mapped[uuid.UUID] = mapped_column(
        UUID(as_uuid=True), ForeignKey("team_members.id", ondelete="CASCADE"), nullable=False
    )
    gate_type: Mapped[str] = mapped_column(String(50), nullable=False)
    disposition: Mapped[str] = mapped_column(String(20), nullable=False)
    created_at: Mapped[datetime] = mapped_column(
        DateTime(timezone=True), server_default=func.now(), nullable=False
    )
