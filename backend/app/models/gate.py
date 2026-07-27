"""E-CAGE-REFEREE P3: HITL Gate 1급 객체.

상태기계(``is_valid_transition``/``transition_gate``/``void_gate``/``hold_gate`` — 사람·admin이
주체인 명시적 액션 축): pending → approved | rejected (human 해소)
         auto_passed → (불변, config allow_auto 시 즉시)
         approved | rejected → (이 축에서는 불변 — is_valid_transition에 rejected/approved발
         전이가 없다. void/override/hold 전부 ``status=="pending"`` 강제)

⚠️story #2150: 위 축과 **별개로**, ``gate_service.create_gate()``의 멱등 조회는 rejected 게이트를
재제출(work_item 동일 키로 재호출) 시 **같은 row를 재사용해 새 평가 사이클로 리셋**한다(사람의
명시적 전이가 아니라 시스템의 재평가 — is_valid_transition을 거치지 않는다. approved/voided는
이 리셋 대상이 아니다 — 근거는 gate_service._reopen_rejected_gate 참조). 즉 "rejected는 절대
안 바뀐다"는 이 파일의 서술은 **resolver 액션 축**에서만 참이고, 재제출 축에서는 참이 아니다 —
둘을 혼동하지 않을 것.

neutral_facts: 관찰 사실만 (touches_migration, diff_size 등).
               판정 아님 — 플랫폼은 위험도 판단 안 함.
"""
import uuid
from datetime import datetime

from sqlalchemy import Boolean, DateTime, String, Text, func, text
from sqlalchemy.dialects.postgresql import JSONB, UUID
from sqlalchemy.orm import Mapped, mapped_column

from app.core.database import Base

GATE_STATUSES = frozenset({"pending", "approved", "rejected", "auto_passed", "voided", "held"})

# 합법 전이: (from, to). ⭐S30: pending→voided(admin recovery·voided≠approval·step_run skipped 해소).
# ⭐S31: pending↔held(admin hold/unhold·일시정지/재개·가역). held→approved/rejected 직접 금지 —
# 재개(held→pending) 후 정상 pending 서 결정(hold와 결정 혼동 방지·4종 모델 clean).
_VALID_TRANSITIONS: set[tuple[str, str]] = {
    ("pending", "approved"),
    ("pending", "rejected"),
    ("pending", "voided"),
    ("pending", "held"),       # S31 hold(일시정지·SLA pause)
    ("held", "pending"),       # S31 unhold(재개·SLA resume)
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
    resolution_note: Mapped[str | None] = mapped_column(Text, nullable=True)
    # ⭐S31: hold 만료(시한부 보류). status='held' 일 때만 의미·무기한 hold 면 None. 0132 마이그(post-0096).
    # FE 가 gate 직독으로 held_until 배지 렌더(step_run 경유 leaky 회피)·step_run.held_until 도 SLA 동기화.
    held_until: Mapped[datetime | None] = mapped_column(DateTime(timezone=True), nullable=True)
    neutral_facts: Mapped[dict | None] = mapped_column(JSONB, nullable=True)
    # H1-S3: merge verdict gate evidence metadata (0118).
    requires_human: Mapped[bool] = mapped_column(Boolean, nullable=False, server_default=text("false"))
    evidence_status: Mapped[str | None] = mapped_column(Text, nullable=True)
    decision_basis: Mapped[str | None] = mapped_column(Text, nullable=True)
    auto_decision_reason: Mapped[str | None] = mapped_column(Text, nullable=True)
    created_at: Mapped[datetime] = mapped_column(
        DateTime(timezone=True), server_default=func.now(), nullable=False
    )
    updated_at: Mapped[datetime] = mapped_column(
        DateTime(timezone=True), server_default=func.now(), onupdate=func.now(), nullable=False
    )
