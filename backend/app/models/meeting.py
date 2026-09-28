import uuid
from datetime import datetime

from sqlalchemy import DateTime, Enum, ForeignKey, Integer, Text, func
from sqlalchemy.dialects.postgresql import JSONB, UUID
from sqlalchemy.orm import Mapped, mapped_column, relationship

from app.core.database import Base
from app.models.base import SoftDeleteMixin, TimestampMixin


# story #4337 — DB enum `meeting_type`의 라벨(순서 포함) **한 곳**. 모델 매핑과 요청 스키마(`MeetingType`)가 둘 다 여기서 뽑는다 —
# DB 라벨과 같은지는 테스트가 대조(test_4337_nullable_schema_not_null_realdb). MCP 도구의 값은 4329 계약 가드가 이 값과 대조.
MEETING_TYPES = ("standup", "retro", "general", "review")


class Meeting(Base, TimestampMixin, SoftDeleteMixin):
    __tablename__ = "meetings"

    id: Mapped[uuid.UUID] = mapped_column(UUID(as_uuid=True), primary_key=True, default=uuid.uuid4)
    project_id: Mapped[uuid.UUID] = mapped_column(
        UUID(as_uuid=True), ForeignKey("projects.id", ondelete="CASCADE"), nullable=False, index=True
    )
    created_by: Mapped[uuid.UUID | None] = mapped_column(
        UUID(as_uuid=True), nullable=True
    )
    title: Mapped[str] = mapped_column(Text, nullable=False)
    # story #4329 — DB 컬럼은 PG enum `meeting_type`(alembic/baseline/schema.sql)인데 모델이 `Text`라 ORM이 varchar로 보내
    # 삽입 · 거름이 `meeting_type = character varying`으로 500이었다. 값 넷은 DB enum과 같은 순서.
    meeting_type: Mapped[str] = mapped_column(
        Enum(*MEETING_TYPES, name="meeting_type"), nullable=False, default="general",
    )
    date: Mapped[datetime] = mapped_column(DateTime(timezone=True), nullable=False, server_default=func.now())
    duration_min: Mapped[int | None] = mapped_column(Integer, nullable=True)
    participants: Mapped[list] = mapped_column(JSONB, nullable=False, default=list)
    raw_transcript: Mapped[str | None] = mapped_column(Text, nullable=True)
    ai_summary: Mapped[str | None] = mapped_column(Text, nullable=True)
    decisions: Mapped[list] = mapped_column(JSONB, nullable=False, default=list)
    action_items: Mapped[list] = mapped_column(JSONB, nullable=False, default=list)

    project: Mapped["Project"] = relationship("Project", lazy="select")


from app.models.project import Project  # noqa: E402, F401
