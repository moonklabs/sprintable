"""E-CAGE-REFEREE P3: HITL Gate 1급 객체.

상태기계: pending → approved | rejected (human 해소)
         auto_passed → (불변, config allow_auto 시 즉시)
         approved | rejected → (불변)

neutral_facts: 관찰 사실만 (touches_migration, diff_size 등).
               판정 아님 — 플랫폼은 위험도 판단 안 함.
"""
import uuid
from datetime import datetime
from typing import Any

from sqlalchemy import DateTime, ForeignKey, String, func
from sqlalchemy.dialects.postgresql import JSONB, UUID
from sqlalchemy.orm import Mapped, mapped_column

from app.core.database import Base

GATE_STATUSES = frozenset({"pending", "approved", "rejected", "auto_passed"})

# 합법 전이: (from, to)
_VALID_TRANSITIONS: set[tuple[str, str]] = {
    ("pending", "approved"),
    ("pending", "rejected"),
}


def is_valid_transition(from_status: str, to_status: str) -> bool:
    return (from_status, to_status) in _VALID_TRANSITIONS


class Gate(Base):
    __tablename__ = "gate"

    id: Mapped[uuid.UUID] = mapped_column(UUID(as_uuid=True), primary_key=True, default=uuid.uuid4)
    org_id: Mapped[uuid.UUID] = mapped_column(UUID(as_uuid=True), nullable=False, index=True)
    work_item_id: Mapped[uuid.UUID] = mapped_column(UUID(as_uuid=True), nullable=False, index=True)
    work_item_type: Mapped[str] = mapped_column(String(20), nullable=False)
    gate_type: Mapped[str] = mapped_column(String(50), nullable=False)
    status: Mapped[str] = mapped_column(String(20), nullable=False, server_default="pending")
    resolver_id: Mapped[uuid.UUID | None] = mapped_column(UUID(as_uuid=True), nullable=True)
    resolved_at: Mapped[datetime | None] = mapped_column(DateTime(timezone=True), nullable=True)
    neutral_facts: Mapped[dict | None] = mapped_column(JSONB, nullable=True)
    created_at: Mapped[datetime] = mapped_column(
        DateTime(timezone=True), server_default=func.now(), nullable=False
    )
    updated_at: Mapped[datetime] = mapped_column(
        DateTime(timezone=True), server_default=func.now(), onupdate=func.now(), nullable=False
    )
