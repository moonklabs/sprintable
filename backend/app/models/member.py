"""E-MEMBER-SSOT AC2-1: 신원 앵커 테이블 (additive only, 코드 cutover 없음).

blueprint-member-ssot-anchor §2/§4 Phase 1-2. 이 모델들은 마이그 0075로 생성되며,
코드는 아직 이들을 읽지/쓰지 않는다(앵커 토대). 백필로 기존 org_members/team_members
신원을 보존하며 채운다(휴먼 members.id=org_members.id, 에이전트=team_members.id).
"""
import uuid
from datetime import datetime

from sqlalchemy import (
    Boolean,
    DateTime,
    ForeignKey,
    Integer,
    Text,
    UniqueConstraint,
    func,
)
from sqlalchemy.dialects.postgresql import JSONB, UUID
from sqlalchemy.orm import Mapped, mapped_column

from app.core.database import Base


class Member(Base):
    """org-scoped 통합 신원 — 휴먼/에이전트 단일 멤버 행.

    휴먼: user_id 설정, owner_member_id NULL. 에이전트: owner_member_id(생성 휴먼) 설정.
    유니크 active (org_id, user_id) 휴먼은 마이그의 부분 유니크 인덱스로 강제.
    """
    __tablename__ = "members"

    id: Mapped[uuid.UUID] = mapped_column(UUID(as_uuid=True), primary_key=True, default=uuid.uuid4)
    org_id: Mapped[uuid.UUID] = mapped_column(
        UUID(as_uuid=True), ForeignKey("organizations.id", ondelete="CASCADE"), nullable=False, index=True
    )
    type: Mapped[str] = mapped_column(Text, nullable=False)  # 'human' | 'agent'
    user_id: Mapped[uuid.UUID | None] = mapped_column(
        UUID(as_uuid=True), ForeignKey("users.id", ondelete="SET NULL"), nullable=True, index=True
    )
    owner_member_id: Mapped[uuid.UUID | None] = mapped_column(
        UUID(as_uuid=True), ForeignKey("members.id", ondelete="SET NULL"), nullable=True, index=True
    )
    name: Mapped[str] = mapped_column(Text, nullable=False)
    avatar_url: Mapped[str | None] = mapped_column(Text, nullable=True)
    org_role: Mapped[str | None] = mapped_column(Text, nullable=True)
    # E-MSG-POLICY S1: agent DM 인가 모드(creator_only default|org_wide|list). 에이전트 단위 정책 —
    # canonical 위치(team_members 뷰가 m.message_policy_mode로 투영). 휴먼은 무의미(default 유지).
    message_policy_mode: Mapped[str] = mapped_column(
        Text, nullable=False, server_default="creator_only", default="creator_only"
    )
    # E-CHAT-CMD S1: 에이전트 런타임 종류(RuntimeType 9종). 에이전트 단위 식별 — capability
    # registry(app.services.agent_runtime) lookup 키. 휴먼/미설정은 NULL(= 커맨드 미지원).
    # 9 enum 은 앱 레이어에서 강제(네이티브 PG enum 미사용 — 신규 런타임 확장 용이).
    runtime_type: Mapped[str | None] = mapped_column(Text, nullable=True)
    is_active: Mapped[bool] = mapped_column(Boolean, nullable=False, default=True, server_default="true")
    created_at: Mapped[datetime] = mapped_column(
        DateTime(timezone=True), server_default=func.now(), nullable=False
    )
    updated_at: Mapped[datetime] = mapped_column(
        DateTime(timezone=True), server_default=func.now(), nullable=False
    )
    deleted_at: Mapped[datetime | None] = mapped_column(DateTime(timezone=True), nullable=True)


class MemberIdentityAlias(Base):
    """레거시 식별자 → canonical members.id 매핑.

    alias_id는 레거시 휴먼 team_member.id 등(자동생성 아님 — 백필이 명시 삽입).
    """
    __tablename__ = "member_identity_aliases"

    alias_id: Mapped[uuid.UUID] = mapped_column(UUID(as_uuid=True), primary_key=True)
    member_id: Mapped[uuid.UUID] = mapped_column(
        UUID(as_uuid=True), ForeignKey("members.id", ondelete="CASCADE"), nullable=False, index=True
    )
    org_id: Mapped[uuid.UUID] = mapped_column(UUID(as_uuid=True), nullable=False, index=True)
    project_id: Mapped[uuid.UUID | None] = mapped_column(UUID(as_uuid=True), nullable=True)
    alias_source: Mapped[str] = mapped_column(Text, nullable=False)  # 'human_team_member' 등


class AgentProjectProfile(Base):
    """에이전트 멤버의 per-project 런타임/설정 (member.type='agent')."""
    __tablename__ = "agent_project_profiles"
    __table_args__ = (
        UniqueConstraint("project_id", "member_id", name="uq_agent_project_profiles_proj_member"),
    )

    id: Mapped[uuid.UUID] = mapped_column(UUID(as_uuid=True), primary_key=True, default=uuid.uuid4)
    member_id: Mapped[uuid.UUID] = mapped_column(
        UUID(as_uuid=True), ForeignKey("members.id", ondelete="CASCADE"), nullable=False, index=True
    )
    project_id: Mapped[uuid.UUID] = mapped_column(
        UUID(as_uuid=True), ForeignKey("projects.id", ondelete="CASCADE"), nullable=False, index=True
    )
    agent_config: Mapped[dict | None] = mapped_column(JSONB, nullable=True)
    agent_role: Mapped[str | None] = mapped_column(Text, nullable=True)
    fakechat_port: Mapped[int | None] = mapped_column(Integer, nullable=True)
    last_seen_at: Mapped[datetime | None] = mapped_column(DateTime(timezone=True), nullable=True)
    active_story_id: Mapped[uuid.UUID | None] = mapped_column(
        UUID(as_uuid=True), ForeignKey("stories.id", ondelete="SET NULL"), nullable=True
    )
    agent_status: Mapped[str | None] = mapped_column(Text, nullable=True)
    created_at: Mapped[datetime] = mapped_column(
        DateTime(timezone=True), server_default=func.now(), nullable=False
    )
    updated_at: Mapped[datetime] = mapped_column(
        DateTime(timezone=True), server_default=func.now(), nullable=False
    )
