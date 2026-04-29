import uuid

from sqlalchemy import ForeignKey, Integer, Text
from sqlalchemy.dialects.postgresql import JSONB, UUID
from sqlalchemy.orm import Mapped, mapped_column, relationship

from app.core.database import Base
from app.models.base import SoftDeleteMixin, TimestampMixin


class Meeting(Base, TimestampMixin, SoftDeleteMixin):
    __tablename__ = "meetings"

    id: Mapped[uuid.UUID] = mapped_column(UUID(as_uuid=True), primary_key=True, default=uuid.uuid4)
    project_id: Mapped[uuid.UUID] = mapped_column(
        UUID(as_uuid=True), ForeignKey("projects.id", ondelete="CASCADE"), nullable=False, index=True
    )
    created_by: Mapped[uuid.UUID | None] = mapped_column(
        UUID(as_uuid=True), ForeignKey("team_members.id", ondelete="SET NULL"), nullable=True
    )
    title: Mapped[str] = mapped_column(Text, nullable=False)
    meeting_type: Mapped[str] = mapped_column(Text, nullable=False, default="general")
    date: Mapped[str] = mapped_column(Text, nullable=False)
    duration_min: Mapped[int | None] = mapped_column(Integer, nullable=True)
    participants: Mapped[list] = mapped_column(JSONB, nullable=False, default=list)
    raw_transcript: Mapped[str | None] = mapped_column(Text, nullable=True)
    ai_summary: Mapped[str | None] = mapped_column(Text, nullable=True)
    decisions: Mapped[list] = mapped_column(JSONB, nullable=False, default=list)
    action_items: Mapped[list] = mapped_column(JSONB, nullable=False, default=list)

    project: Mapped["Project"] = relationship("Project", lazy="select")


from app.models.project import Project  # noqa: E402, F401
