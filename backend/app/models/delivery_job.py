"""story #2460(§6 봉합②): 웹훅/푸시 배달 트랜잭셔널 아웃박스.

`fire_webhooks`/`_deliver_personal_webhooks`/`deliver_expo_push`(request 경로)가 caller의
AsyncSession 을 물고 동기 HTTP 배달(웹훅 3회재시도·10s·Expo push)을 하던 것을 이 테이블
insert 로 대체한다 — 실 배달은 `delivery_dispatcher.py`의 워커 루프가 자기 세션으로 수행한다.
`app/models/event_outbox.py`(SSE/PG NOTIFY 전용, story #2078)와는 목적이 다른 별개 테이블이다.
"""
from __future__ import annotations

import uuid
from datetime import datetime

from sqlalchemy import CheckConstraint, DateTime, Index, Integer, Text, func, text
from sqlalchemy.dialects.postgresql import JSONB, UUID
from sqlalchemy.orm import Mapped, mapped_column

from app.core.database import Base


class DeliveryJob(Base):
    __tablename__ = "delivery_jobs"

    id: Mapped[uuid.UUID] = mapped_column(UUID(as_uuid=True), primary_key=True, default=uuid.uuid4)
    org_id: Mapped[uuid.UUID] = mapped_column(UUID(as_uuid=True), nullable=False, index=True)
    kind: Mapped[str] = mapped_column(Text, nullable=False)
    payload: Mapped[dict] = mapped_column(JSONB, nullable=False, default=dict)
    status: Mapped[str] = mapped_column(Text, nullable=False, default="pending", server_default="pending")
    attempts: Mapped[int] = mapped_column(Integer, nullable=False, default=0, server_default="0")
    last_error: Mapped[str | None] = mapped_column(Text, nullable=True)
    created_at: Mapped[datetime] = mapped_column(
        DateTime(timezone=True), server_default=func.now(), nullable=False
    )
    delivered_at: Mapped[datetime | None] = mapped_column(DateTime(timezone=True), nullable=True)
    # story #2761 — claim 시각(reaper 기준값). 'claimed' 상태로 전이할 때만 채워진다(그 밖엔 NULL).
    claimed_at: Mapped[datetime | None] = mapped_column(DateTime(timezone=True), nullable=True)

    __table_args__ = (
        CheckConstraint(
            "kind IN ('org_webhook', 'personal_webhook', 'expo_push', 'apns_push')",
            name="ck_delivery_jobs_kind",
        ),
        # story #2761 — 'claimed' 추가: claim(attempts+1)과 status 전이가 같은 원자적 UPDATE
        # 안에서 일어나야 재집기 창이 닫힌다(0256 마이그 참조 — 근본원인·prod 3중복 실사고).
        CheckConstraint(
            "status IN ('pending', 'claimed', 'delivered', 'failed')", name="ck_delivery_jobs_status"
        ),
        # 워커 폴링 축 — pending/claimed 부분 인덱스(event_outbox.ix_event_outbox_pending과 동형:
        # 대부분의 row가 곧 delivered/failed로 빠지므로 미해결 row는 항상 소수, 부분 인덱스로
        # 스캔 최소화). claimed도 포함하는 이유 — reaper가 만료된 claimed를 이 인덱스로 찾는다.
        Index(
            "ix_delivery_jobs_pending", "id",
            postgresql_where=text("status IN ('pending', 'claimed')"),
        ),
    )
