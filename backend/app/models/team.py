import uuid
from datetime import datetime

from sqlalchemy import Boolean, DateTime, ForeignKey, String, Text, UniqueConstraint
from sqlalchemy.dialects.postgresql import JSONB, UUID
from sqlalchemy.orm import Mapped, mapped_column, relationship

from app.core.database import Base
from app.models.base import OrgScopedMixin, TimestampMixin


class TeamMember(Base, OrgScopedMixin, TimestampMixin):
    __tablename__ = "team_members"

    id: Mapped[uuid.UUID] = mapped_column(UUID(as_uuid=True), primary_key=True, default=uuid.uuid4)
    project_id: Mapped[uuid.UUID] = mapped_column(
        UUID(as_uuid=True), ForeignKey("projects.id", ondelete="CASCADE"), nullable=False, index=True
    )
    user_id: Mapped[uuid.UUID | None] = mapped_column(UUID(as_uuid=True), nullable=True)
    type: Mapped[str] = mapped_column(String(20), nullable=False)  # 'human' | 'agent'
    name: Mapped[str] = mapped_column(Text, nullable=False)
    role: Mapped[str] = mapped_column(String(50), nullable=False, default="member")
    avatar_url: Mapped[str | None] = mapped_column(Text, nullable=True)
    agent_config: Mapped[dict | None] = mapped_column(JSONB, nullable=True)
    is_active: Mapped[bool] = mapped_column(Boolean, nullable=False, default=True)
    color: Mapped[str] = mapped_column(Text, nullable=False, default="#3385f8")
    agent_role: Mapped[str | None] = mapped_column(Text, nullable=True)
    # E-MSG-POLICY S1: agent DM 인가 모드 — creator_only(default·기존 동작) | org_wide | list.
    # 휴먼↔에이전트만 게이팅, agent↔agent는 enforcement에서 항상 skip(팀 comms 불변).
    message_policy_mode: Mapped[str] = mapped_column(
        Text, nullable=False, server_default="creator_only", default="creator_only"
    )
    fakechat_port: Mapped[int | None] = mapped_column(nullable=True)
    created_by: Mapped[uuid.UUID | None] = mapped_column(
        UUID(as_uuid=True), ForeignKey("users.id", ondelete="SET NULL"), nullable=True
    )
    # S2-1: Presence 컬럼
    last_seen_at: Mapped[datetime | None] = mapped_column(
        DateTime(timezone=True), nullable=True
    )
    active_story_id: Mapped[uuid.UUID | None] = mapped_column(
        UUID(as_uuid=True), ForeignKey("stories.id", ondelete="SET NULL"), nullable=True
    )
    agent_status: Mapped[str | None] = mapped_column(String(20), nullable=True)
    can_manage_members: Mapped[bool] = mapped_column(Boolean, nullable=False, default=False)

    project: Mapped["Project"] = relationship("Project", back_populates="team_members")


class AgentMessageAllowlist(Base, OrgScopedMixin, TimestampMixin):
    """E-MSG-POLICY S1: list 모드 agent의 메시지 허용 대상.

    (agent_member_id, allowed_id) unique. allowed_id = 허용 휴먼의 member_id(team_member/org_member).
    list 모드에서 이 목록(+creator) 외 휴먼이 agent와 대화 시도하면 403.
    """
    __tablename__ = "agent_message_allowlist"

    id: Mapped[uuid.UUID] = mapped_column(UUID(as_uuid=True), primary_key=True, default=uuid.uuid4)
    agent_member_id: Mapped[uuid.UUID] = mapped_column(UUID(as_uuid=True), nullable=False, index=True)
    allowed_id: Mapped[uuid.UUID] = mapped_column(UUID(as_uuid=True), nullable=False)

    __table_args__ = (
        UniqueConstraint("agent_member_id", "allowed_id", name="uq_agent_message_allowlist_pair"),
    )


from app.models.project import Project  # noqa: E402, F401 — resolve forward ref
