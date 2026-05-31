import uuid
from datetime import datetime

from sqlalchemy import DateTime, ForeignKey, Integer, String, func
from sqlalchemy.dialects.postgresql import UUID
from sqlalchemy.orm import Mapped, mapped_column

from app.core.database import Base
from app.models.base import OrgScopedMixin


class Verdict(Base, OrgScopedMixin):
    """participation별 결과 기록 — 에이전트 신뢰 계측 데이터.

    result=null 허용: 미측정 소스는 null 유지(거짓 pass/fail 금지).
    공개 POST API 없음 — record_verdict() 내부 서비스 함수만.
    """
    __tablename__ = "verdict"

    id: Mapped[uuid.UUID] = mapped_column(UUID(as_uuid=True), primary_key=True, default=uuid.uuid4)
    participation_id: Mapped[uuid.UUID] = mapped_column(
        UUID(as_uuid=True),
        ForeignKey("participation.id", ondelete="CASCADE"),
        nullable=False,
        index=True,
    )
    # source: 확장 가능 (pr|qa|ci|design ...) — enum 하드코딩 금지
    source: Mapped[str] = mapped_column(String(50), nullable=False)
    # result: null = 미측정 (pass|fail|null)
    result: Mapped[str | None] = mapped_column(String(20), nullable=True)
    rounds: Mapped[int | None] = mapped_column(Integer, nullable=True)
    recorded_at: Mapped[datetime] = mapped_column(
        DateTime(timezone=True), server_default=func.now(), nullable=False
    )
    created_at: Mapped[datetime] = mapped_column(
        DateTime(timezone=True), server_default=func.now(), nullable=False
    )
