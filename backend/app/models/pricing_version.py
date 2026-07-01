"""가격 버전 이력(E-ADMIN B1, story 553fc58d) — team/pro 유료 tier의 가격 변경 이력.

**append-only**: 가격 값이 담긴 행은 절대 UPDATE되지 않는다. 가격이 바뀌면 새 행을
INSERT하고, 직전 "열린"(effective_to IS NULL) 행의 effective_to를 새 행의 effective_from
으로 닫는다(행을 닫는 것뿐 — price_cents 등 가격 값 자체는 불변).

free tier는 가격이 항상 0이라 버전 이력 대상에서 제외(tier CHECK가 team/pro/overage만 허용).

grandfather: org_subscriptions.pricing_version_id가 가입(플랜변경) 시점의 이 테이블 행을
참조 — 이후 가격이 바뀌어도 기존 구독은 그 시점 행의 price_cents를 유지한다.

currency: Polar가 USD/KRW를 별개 price 객체(각자 polar_price_id)로 관리해 (tier,
billing_cycle, currency)가 계보 키다 — 통화별 독립 grandfather. price_cents는 그 통화의
최소단위 그대로(USD=센트·KRW=원, Polar 자체 규칙과 동일)."""
from __future__ import annotations

import uuid
from datetime import datetime

from sqlalchemy import DateTime, Integer, Text, func
from sqlalchemy.dialects.postgresql import UUID
from sqlalchemy.orm import Mapped, mapped_column

from app.core.database import Base


class PricingVersion(Base):
    __tablename__ = "pricing_versions"

    id: Mapped[uuid.UUID] = mapped_column(UUID(as_uuid=True), primary_key=True, default=uuid.uuid4)
    tier: Mapped[str] = mapped_column(Text, nullable=False)
    billing_cycle: Mapped[str] = mapped_column(Text, nullable=False)
    currency: Mapped[str] = mapped_column(Text, nullable=False, default="usd")
    price_cents: Mapped[int] = mapped_column(Integer, nullable=False)
    polar_price_id: Mapped[str] = mapped_column(Text, nullable=False)
    effective_from: Mapped[datetime] = mapped_column(DateTime(timezone=True), nullable=False)
    effective_to: Mapped[datetime | None] = mapped_column(DateTime(timezone=True), nullable=True)
    created_by: Mapped[str] = mapped_column(Text, nullable=False)
    created_at: Mapped[datetime] = mapped_column(
        DateTime(timezone=True), server_default=func.now(), nullable=False
    )
