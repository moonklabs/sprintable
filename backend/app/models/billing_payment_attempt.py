"""story #4335 — 결제 시도(checkout · change-tier) 한 번 = 행 하나(마이그 0410이 정본 · 이 모델은 미러).

요청은 시도를 만들고 곧바로 돌려준다. 결과는 이 행으로 확정한다 — 응답 뒤 작업이 느려지거나 인스턴스와 함께 사라져도
조회 대사(`billing_payment_attempt.reconcile_attempt`)가 `order_id`로 Toss를 조회해 마무리한다. 경합 규칙은
`app/services/billing_payment_attempt.py` 모듈 설명."""
from __future__ import annotations

import uuid
from datetime import datetime

from sqlalchemy import BigInteger, Boolean, CheckConstraint, DateTime, Text, UniqueConstraint, text
from sqlalchemy.dialects.postgresql import UUID
from sqlalchemy.orm import Mapped, mapped_column

from app.core.database import Base
from app.models.base import OrgScopedMixin, TimestampMixin

ATTEMPT_KINDS = ("checkout", "change_tier")
ATTEMPT_STATUSES = ("processing", "succeeded", "declined", "failed", "voided")
ATTEMPT_STAGES = ("received", "key_issued", "charge_started", "charged")


class BillingPaymentAttempt(Base, TimestampMixin, OrgScopedMixin):
    __tablename__ = "billing_payment_attempts"
    __table_args__ = (
        CheckConstraint("kind IN ('checkout', 'change_tier')", name="ck_billing_payment_attempts_kind"),
        CheckConstraint(
            "status IN ('processing', 'succeeded', 'declined', 'failed', 'voided')", name="ck_billing_payment_attempts_status",
        ),
        CheckConstraint(
            "stage IN ('received', 'key_issued', 'charge_started', 'charged')", name="ck_billing_payment_attempts_stage",
        ),
        CheckConstraint(
            "refund_status IS NULL OR refund_status IN ('pending', 'confirmed', 'failed')",
            name="ck_billing_payment_attempts_refund_status",
        ),
        UniqueConstraint("order_id", name="uq_billing_payment_attempts_order_id"),
    )

    id: Mapped[uuid.UUID] = mapped_column(UUID(as_uuid=True), primary_key=True)
    requested_by: Mapped[uuid.UUID | None] = mapped_column(UUID(as_uuid=True), nullable=True)
    kind: Mapped[str] = mapped_column(Text, nullable=False)
    tier: Mapped[str] = mapped_column(Text, nullable=False)
    billing_cycle: Mapped[str | None] = mapped_column(Text, nullable=True)
    status: Mapped[str] = mapped_column(Text, nullable=False, default="processing")
    stage: Mapped[str] = mapped_column(Text, nullable=False, default="received")
    order_id: Mapped[str] = mapped_column(Text, nullable=False)
    lease_token: Mapped[uuid.UUID | None] = mapped_column(UUID(as_uuid=True), nullable=True)
    lease_expires_at: Mapped[datetime | None] = mapped_column(DateTime(timezone=True), nullable=True)
    charge_started_at: Mapped[datetime | None] = mapped_column(DateTime(timezone=True), nullable=True)
    claim_value: Mapped[datetime | None] = mapped_column(DateTime(timezone=True), nullable=True)
    new_offering_id: Mapped[uuid.UUID | None] = mapped_column(UUID(as_uuid=True), nullable=True)
    refund_target_order_id: Mapped[str | None] = mapped_column(Text, nullable=True)
    reason: Mapped[str | None] = mapped_column(Text, nullable=True)
    reauth_required: Mapped[bool] = mapped_column(Boolean, nullable=False, default=False, server_default=text("false"))
    finished_at: Mapped[datetime | None] = mapped_column(DateTime(timezone=True), nullable=True)
    refund_status: Mapped[str | None] = mapped_column(Text, nullable=True)
    refund_amount_minor: Mapped[int | None] = mapped_column(BigInteger, nullable=True)
    base_offering_version_id: Mapped[uuid.UUID | None] = mapped_column(UUID(as_uuid=True), nullable=True)
    next_check_at: Mapped[datetime | None] = mapped_column(DateTime(timezone=True), nullable=True)
    refund_lease_until: Mapped[datetime | None] = mapped_column(DateTime(timezone=True), nullable=True)
