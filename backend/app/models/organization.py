import uuid
from datetime import datetime

from sqlalchemy import DateTime, Text, func
from sqlalchemy.dialects.postgresql import UUID
from sqlalchemy.orm import Mapped, mapped_column

from app.core.database import Base


class Organization(Base):
    __tablename__ = "organizations"

    id: Mapped[uuid.UUID] = mapped_column(UUID(as_uuid=True), primary_key=True, default=uuid.uuid4)
    name: Mapped[str] = mapped_column(Text, nullable=False)
    slug: Mapped[str] = mapped_column(Text, nullable=False, unique=True)
    plan: Mapped[str] = mapped_column(Text, nullable=False, default="free")
    # story 46da6450(Phase1·BE·소형) — IANA 타임존 이름, nullable(기본 null·백필 없음).
    # 캘린더(#3422)·예약 시각 표기(§11-2)의 tz 정본 — 저장/표시만, 서버 시각 처리(scheduled_at
    # 검증·next_retry_at)는 그대로 UTC-explicit ISO로 무변경(그라운딩 결론).
    timezone: Mapped[str | None] = mapped_column(Text, nullable=True, default=None)
    # story #3953(블루프린트 §1-5) — agent_session.py::suspended_at·github_installation.py
    # ::suspended_at와 동형 관례(존재=중지 中인지의 불리언 + "언제부터"를 컬럼 하나로
    # 겸함). owner가 조직 전체 외부 발행을 멈출 때만 채워진다 — 백필 0(과거엔 이
    # 개념 자체가 없었다는 게 정직한 사실).
    external_publish_paused_at: Mapped[datetime | None] = mapped_column(DateTime(timezone=True), nullable=True)
    external_publish_paused_by: Mapped[uuid.UUID | None] = mapped_column(UUID(as_uuid=True), nullable=True)
    external_publish_pause_reason: Mapped[str | None] = mapped_column(Text, nullable=True)
    created_at: Mapped[datetime] = mapped_column(
        DateTime(timezone=True), server_default=func.now(), nullable=False
    )
    updated_at: Mapped[datetime] = mapped_column(
        DateTime(timezone=True), server_default=func.now(), onupdate=func.now(), nullable=False
    )
