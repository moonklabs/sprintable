import uuid
from datetime import datetime

from sqlalchemy import DateTime, ForeignKey, UniqueConstraint, func
from sqlalchemy.dialects.postgresql import UUID
from sqlalchemy.orm import Mapped, mapped_column

from app.core.database import Base
from app.models.base import OrgScopedMixin


class StoryAssignee(Base, OrgScopedMixin):
    """E-BOARD S5: 복수 assignee join 테이블.

    단일 stories.assignee_id(주담당)와 **공존**한다 — assignee_id는 유지(back-compat).
    member_id는 grant-only 휴먼(org_member.id) 할당을 허용하기 위해 FK를 부착하지 않는다
    (stories.assignee_id / participation.member_id 와 동형, E-MEMBER-SSOT FK 완화).
    """

    __tablename__ = "story_assignees"

    id: Mapped[uuid.UUID] = mapped_column(UUID(as_uuid=True), primary_key=True, default=uuid.uuid4)
    story_id: Mapped[uuid.UUID] = mapped_column(
        UUID(as_uuid=True), ForeignKey("stories.id", ondelete="CASCADE"), nullable=False, index=True
    )
    member_id: Mapped[uuid.UUID] = mapped_column(UUID(as_uuid=True), nullable=False, index=True)
    created_at: Mapped[datetime] = mapped_column(
        DateTime(timezone=True), server_default=func.now(), nullable=False
    )

    __table_args__ = (
        UniqueConstraint("story_id", "member_id", name="uq_story_assignees_story_member"),
    )
