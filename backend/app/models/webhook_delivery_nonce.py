"""story e4fc29fa(Phase1·마케팅운영, 페드루 PO 確定 2026-09-04, 조각④) — signed webhook
재전송(replay) 거부 원장. `(connection_id, nonce)` UNIQUE — 수신측이 같은 조합을 다시
보면 409(재전송)로 거부한다. FK 없음(그라운딩 §9 도메인 전체 관례)."""
from __future__ import annotations

import uuid
from datetime import datetime

from sqlalchemy import DateTime, Text, UniqueConstraint, func
from sqlalchemy.dialects.postgresql import UUID
from sqlalchemy.orm import Mapped, mapped_column

from app.core.database import Base


class WebhookDeliveryNonce(Base):
    __tablename__ = "webhook_delivery_nonces"
    __table_args__ = (
        UniqueConstraint("connection_id", "nonce", name="uq_webhook_delivery_nonces_connection_nonce"),
    )

    id: Mapped[uuid.UUID] = mapped_column(UUID(as_uuid=True), primary_key=True, default=uuid.uuid4)
    connection_id: Mapped[uuid.UUID] = mapped_column(UUID(as_uuid=True), nullable=False, index=True)
    nonce: Mapped[str] = mapped_column(Text, nullable=False)
    received_at: Mapped[datetime] = mapped_column(DateTime(timezone=True), server_default=func.now(), nullable=False)
