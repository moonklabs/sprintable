"""grandfather 정책 — 어떤 org가 어떤 offering_version에 «묶였는지» + 그 묶임을 다루는
규칙을 데이터로 표현한다(#2471 A1, 선생님 04:11Z 추가 요건).

org_subscriptions.offering_version_id는 "지금 이 org가 실제로 쓰는 offering_version"을
가리키는 단순 현재값 포인터다(pricing_version_id와 동일 패턴). 이 테이블은 그 위의 정책
계층이다 — "이 org를 새 offering_version이 나와도 자동으로 옮길지, 언제까지 옛 버전에
묶어 둘지"를 어드민이 편집 가능한 데이터로 관리한다(어드민 API/UI 자체는 후속 별 스토리).

append-only 이력 — 정책이 바뀌면 새 행, effective_to로 이전 행을 "닫는다"(pricing_versions·
offering_versions와 동일 규약).

⛔이 스토리는 그릇만 만든다. 어떤 트리거로 이 테이블을 읽고/쓰고 실제로 org를 이전시키는
로직은 범위 밖(B 이후 · 어드민 API 스토리)."""
from __future__ import annotations

import uuid
from datetime import datetime

from sqlalchemy import Boolean, DateTime, ForeignKey, Integer, Text, func
from sqlalchemy.dialects.postgresql import UUID
from sqlalchemy.orm import Mapped, mapped_column

from app.core.database import Base


class GrandfatherPolicy(Base):
    __tablename__ = "grandfather_policies"

    id: Mapped[uuid.UUID] = mapped_column(UUID(as_uuid=True), primary_key=True, default=uuid.uuid4)
    org_id: Mapped[uuid.UUID] = mapped_column(UUID(as_uuid=True), nullable=False)
    offering_version_id: Mapped[uuid.UUID] = mapped_column(
        UUID(as_uuid=True), ForeignKey("offering_versions.id"), nullable=False
    )
    # 새 offering_version(같은 tier·currency)이 발행돼도 이 org를 자동으로 옮길지.
    auto_migrate_on_new_version: Mapped[bool] = mapped_column(Boolean, nullable=False, default=False)
    # NULL = 무기한 고정(수동 개입 전까지 옛 버전 유지). N일 = 새 버전 발행 후 N일 뒤 강제 이전.
    grace_period_days: Mapped[int | None] = mapped_column(Integer, nullable=True)
    # signup·plan_change·admin_grandfather_grant·forced_migration 등 — 왜 이 정책이 생겼는지.
    reason: Mapped[str] = mapped_column(Text, nullable=False)
    effective_from: Mapped[datetime] = mapped_column(DateTime(timezone=True), nullable=False)
    effective_to: Mapped[datetime | None] = mapped_column(DateTime(timezone=True), nullable=True)
    created_by: Mapped[str] = mapped_column(Text, nullable=False)
    created_at: Mapped[datetime] = mapped_column(
        DateTime(timezone=True), server_default=func.now(), nullable=False
    )
