"""story #4341 — 플랫폼 운영 알림 한 건(사람이 받는 곳 = 설정된 운영 대화). 멱등(같은 사건 한 번)과 재시도(비종결)를 이 표가 쥔다 —
부르는 쪽(결제 · 발행)은 전달 결과만 받는다. 전달은 `app.services.operator_alerts`만 쓴다.

- `dedupe_key` unique — 같은 사건을 두 번 불러도 행 1 · 메시지 1.
- `status`: pending(아직 전달 안 됨 — 미설정 · 실패 포함, 재시도 대상) / delivered(메시지 행이 커밋됨). 종결 실패 상태는 없다.
- `target` · `facts`는 거른 값만(uuid · 금액 · 코드 · 시각) — 카드 번호 · 결제 키 · 토큰 · 이메일 원문은 들어오지 않는다.
마이그 0411이 정본 · 이 모델은 미러(billing_order.py 관례)."""
from __future__ import annotations

import uuid
from datetime import datetime

from sqlalchemy import CheckConstraint, DateTime, Index, Integer, Text
from sqlalchemy.dialects.postgresql import JSONB, UUID
from sqlalchemy.orm import Mapped, mapped_column

from app.core.database import Base
from app.models.base import TimestampMixin


class OperatorAlert(Base, TimestampMixin):
    __tablename__ = "operator_alerts"
    __table_args__ = (
        CheckConstraint("status IN ('pending', 'delivered')", name="ck_operator_alerts_status"),
        CheckConstraint("attempt_count >= 0", name="ck_operator_alerts_attempt_count"),
        # 재시도 스윕: pending 중 next_attempt_at이 된 것부터.
        Index("ix_operator_alerts_pending_due", "next_attempt_at", postgresql_where="status = 'pending'"),
    )

    id: Mapped[uuid.UUID] = mapped_column(UUID(as_uuid=True), primary_key=True, default=uuid.uuid4)
    dedupe_key: Mapped[str] = mapped_column(Text, nullable=False, unique=True)
    kind: Mapped[str] = mapped_column(Text, nullable=False)
    # 대상 조직(없을 수 있다 — 조직 밖 플랫폼 사건). FK 없음: 알림은 대상이 지워져도 남아야 하는 운영 기록.
    target_org_id: Mapped[uuid.UUID | None] = mapped_column(UUID(as_uuid=True), nullable=True)
    target: Mapped[dict] = mapped_column(JSONB, nullable=False, default=dict)
    facts: Mapped[dict] = mapped_column(JSONB, nullable=False, default=dict)
    status: Mapped[str] = mapped_column(Text, nullable=False, default="pending")
    attempt_count: Mapped[int] = mapped_column(Integer, nullable=False, default=0)
    next_attempt_at: Mapped[datetime] = mapped_column(DateTime(timezone=True), nullable=False)
    # 마지막 실패 사유 코드(예: not_configured · http_404 · OperationalError) — 예외 본문은 싣지 않는다.
    last_error: Mapped[str | None] = mapped_column(Text, nullable=True)
    message_id: Mapped[uuid.UUID | None] = mapped_column(UUID(as_uuid=True), nullable=True)
    delivered_at: Mapped[datetime | None] = mapped_column(DateTime(timezone=True), nullable=True)
