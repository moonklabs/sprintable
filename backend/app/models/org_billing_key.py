"""결제②-C1(story #2492) — org당 Toss 빌링키 1건(카드 교체 = 재발급으로 대체, 이력 테이블
아님 — `toss-adapter-c-plan-v0-1` §4). `encrypted_billing_key`는 절대 평문으로 두지 않는다
(app/services/billing_key_crypto.py 경유만)."""
from __future__ import annotations

import uuid
from datetime import datetime

from sqlalchemy import DateTime, Text
from sqlalchemy.dialects.postgresql import UUID
from sqlalchemy.orm import Mapped, mapped_column

from app.core.database import Base
from app.models.base import OrgScopedMixin, TimestampMixin


class OrgBillingKey(Base, TimestampMixin, OrgScopedMixin):
    __tablename__ = "org_billing_keys"

    id: Mapped[uuid.UUID] = mapped_column(UUID(as_uuid=True), primary_key=True, default=uuid.uuid4)
    # OrgScopedMixin의 org_id(index=True만)를 재선언 — 이 테이블은 org당 정확히 1행(카드
    # 교체=재발급으로 UPDATE, 이력 아님)이라 unique 제약을 추가로 건다.
    org_id: Mapped[uuid.UUID] = mapped_column(UUID(as_uuid=True), nullable=False, unique=True)
    customer_key: Mapped[str] = mapped_column(Text, nullable=False, unique=True)
    encrypted_billing_key: Mapped[str] = mapped_column(Text, nullable=False)
    # 카드 표시정보(마스킹) — Toss 응답 그대로, 원본 카드번호 아님.
    card_issuer_code: Mapped[str | None] = mapped_column(Text, nullable=True)
    card_acquirer_code: Mapped[str | None] = mapped_column(Text, nullable=True)
    card_number_masked: Mapped[str | None] = mapped_column(Text, nullable=True)
    card_type: Mapped[str | None] = mapped_column(Text, nullable=True)
    card_owner_type: Mapped[str | None] = mapped_column(Text, nullable=True)
    status: Mapped[str] = mapped_column(Text, nullable=False, default="active")
    issued_at: Mapped[datetime] = mapped_column(DateTime(timezone=True), nullable=False)
