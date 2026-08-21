import uuid
from datetime import datetime

from sqlalchemy import DateTime, func, text
from sqlalchemy.dialects.postgresql import UUID
from sqlalchemy.orm import Mapped, mapped_column

from app.core.database import Base

# story #2874/#3291(카디르 QA rework, 2026-08-21): 낙관적 동시성 CAS가 ms-절삭 updated_at을
# 토큰으로 쓰는데(false-409 방지, 카디르 probe), 같은 밀리초 버킷 안에서 write가 두 번 겹치면
# 그 절삭값이 «퇴화»해 낡은 expected가 통과하는 SQL 레벨 결정적 재현이 나왔다(타이밍 운 아님).
# 처방: 매 write가 직전 값보다 최소 1ms는 반드시 전진하게 onupdate 자체를 이 식으로 강제 —
# `updated_at`을 CAS 토큰으로 쓰는 모델(Story·Doc, app/models/pm.py·doc.py)이 이 상수를
# import해 컬럼을 override한다. 한 곳(이 상수)만 선언하면 그 모델의 일반 update()(setattr+
# flush, onupdate 자동 적용)와 BaseRepository.update_with_cas() 둘 다 같은 불변식을 타므로
# "CAS 경로만 고치면 반쪽" 클래스를 원천 차단(update_with_cas는 updated_at을 explicit으로
# SET하지 않는다 — 이 onupdate가 유일한 경로).
MONOTONIC_UPDATED_AT_ONUPDATE = text("GREATEST(clock_timestamp(), updated_at + interval '1 millisecond')")


class TimestampMixin:
    created_at: Mapped[datetime] = mapped_column(
        DateTime(timezone=True), server_default=func.now(), nullable=False
    )
    updated_at: Mapped[datetime] = mapped_column(
        DateTime(timezone=True), server_default=func.now(), onupdate=func.now(), nullable=False
    )


class SoftDeleteMixin:
    deleted_at: Mapped[datetime | None] = mapped_column(DateTime(timezone=True), nullable=True)


class OrgScopedMixin:
    """org_id가 있는 테이블의 공통 mixin — BaseRepository tenant 필터용."""
    org_id: Mapped[uuid.UUID] = mapped_column(UUID(as_uuid=True), nullable=False, index=True)


__all__ = ["Base", "TimestampMixin", "SoftDeleteMixin", "OrgScopedMixin"]
