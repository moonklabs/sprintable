import uuid
from datetime import datetime

from sqlalchemy import Boolean, DateTime, ForeignKey, Text, UniqueConstraint, func, text
from sqlalchemy.dialects.postgresql import ARRAY, JSONB, UUID
from sqlalchemy.orm import Mapped, mapped_column, relationship

from app.core.database import Base
from app.models.base import OrgScopedMixin, SoftDeleteMixin, TimestampMixin


class Conversation(Base, OrgScopedMixin, TimestampMixin):
    __tablename__ = "conversations"

    id: Mapped[uuid.UUID] = mapped_column(UUID(as_uuid=True), primary_key=True, default=uuid.uuid4)
    project_id: Mapped[uuid.UUID] = mapped_column(
        UUID(as_uuid=True), ForeignKey("projects.id", ondelete="CASCADE"), nullable=False, index=True
    )
    type: Mapped[str] = mapped_column(Text, nullable=False, default="group")  # dm | group
    title: Mapped[str | None] = mapped_column(Text, nullable=True)
    # 179db213: DM 1-pair=1-DM — 정렬된 member-pair `min|max`(type='dm'만). partial unique index
    # uq_conversations_dm_pair(org,project,dm_pair_key WHERE type='dm')로 레이스/중복 차단.
    dm_pair_key: Mapped[str | None] = mapped_column(Text, nullable=True)
    created_by: Mapped[uuid.UUID | None] = mapped_column(
        UUID(as_uuid=True), ForeignKey("team_members.id", ondelete="SET NULL"), nullable=True
    )
    status: Mapped[str] = mapped_column(Text, nullable=False, default="open")  # open | resolved
    resolved_by: Mapped[uuid.UUID | None] = mapped_column(
        UUID(as_uuid=True), ForeignKey("team_members.id", ondelete="SET NULL"), nullable=True
    )
    resolved_at: Mapped[datetime | None] = mapped_column(
        DateTime(timezone=True), nullable=True
    )
    # story #2603 P0(delivery-contract-blueprint-v0-1) AC2: 대화 스코프 옵트아웃 — true면 이
    # 대화의 에이전트 recipient는 mentions 기본계약이 all로 완화된다(단 회원 자신의 명시
    # mute는 이걸로 안 뒤집힘 — channel_router.py 참조). 기본 false(무회귀).
    free_response: Mapped[bool] = mapped_column(Boolean, nullable=False, default=False)

    participants: Mapped[list["ConversationParticipant"]] = relationship(
        "ConversationParticipant", back_populates="conversation", lazy="select"
    )
    messages: Mapped[list["ConversationMessage"]] = relationship(
        "ConversationMessage", back_populates="conversation", lazy="select"
    )


class ConversationParticipant(Base):
    __tablename__ = "conversation_participants"
    __table_args__ = (
        UniqueConstraint("conversation_id", "member_id", name="uq_conversation_participant"),
    )

    id: Mapped[uuid.UUID] = mapped_column(UUID(as_uuid=True), primary_key=True, default=uuid.uuid4)
    conversation_id: Mapped[uuid.UUID] = mapped_column(
        UUID(as_uuid=True), ForeignKey("conversations.id", ondelete="CASCADE"), nullable=False, index=True
    )
    member_id: Mapped[uuid.UUID] = mapped_column(
        UUID(as_uuid=True), ForeignKey("team_members.id", ondelete="CASCADE"), nullable=False
    )
    joined_at: Mapped[datetime] = mapped_column(
        DateTime(timezone=True), server_default=func.now(), nullable=False
    )
    # 270c87e6: per-대화 알림 mute. set=무음·null=알림 ON. 참여자 지위·가시성·수신은 불변(알림만).
    muted_at: Mapped[datetime | None] = mapped_column(DateTime(timezone=True), nullable=True)
    # story #1976 (E-CHAT-REALTIME 트랙A): read state 서버 truth. NULL=한 번도 안 읽음
    # (과거 참가자 전원 포함 — 마이그 시점 전량 NULL, 백필 없음). unread_count 계산 기준선
    # (last_read_at 이후 메시지 중 sender IS DISTINCT FROM 나). muted_at과 동형(수동 mark 컬럼).
    last_read_at: Mapped[datetime | None] = mapped_column(DateTime(timezone=True), nullable=True)

    conversation: Mapped[Conversation] = relationship("Conversation", back_populates="participants")


class ConversationMessage(Base, TimestampMixin, SoftDeleteMixin):
    """⚠️story #2319 — SoftDeleteMixin(deleted_at)이지만 Doc/Story와 다르게 읽는다.
    Doc/Story의 관례(`.deleted_at.is_(None)`으로 목록·조회에서 통째로 걸러냄)를 여기 그대로
    옮기지 않는다 — PO 결정(tombstone)은 「행이 남아 그 자리에서 삭제됨으로 보인다」이지
    「안 보인다」가 아니다. list_messages/get_message는 deleted_at 무관하게 그대로 반환하고,
    content만 DELETE 핸들러가 지운다. 이 테이블에 `.deleted_at.is_(None)` 필터를 추가하면
    조용히 스레드에서 메시지가 사라져 이 결정을 뒤집는다 — 추가하지 말 것."""

    __tablename__ = "conversation_messages"

    id: Mapped[uuid.UUID] = mapped_column(UUID(as_uuid=True), primary_key=True, default=uuid.uuid4)
    conversation_id: Mapped[uuid.UUID] = mapped_column(
        UUID(as_uuid=True), ForeignKey("conversations.id", ondelete="CASCADE"), nullable=False, index=True
    )
    sender_id: Mapped[uuid.UUID | None] = mapped_column(
        UUID(as_uuid=True), ForeignKey("team_members.id", ondelete="SET NULL"), nullable=True
    )
    content: Mapped[str] = mapped_column(Text, nullable=False)
    mentioned_ids: Mapped[list[uuid.UUID]] = mapped_column(
        ARRAY(UUID(as_uuid=True)), nullable=False, default=list
    )
    thread_id: Mapped[uuid.UUID | None] = mapped_column(
        UUID(as_uuid=True),
        ForeignKey("conversation_messages.id", ondelete="SET NULL"),
        nullable=True,
        index=True,
    )
    reply_count: Mapped[int] = mapped_column(nullable=False, default=0)
    last_reply_at: Mapped[datetime | None] = mapped_column(
        DateTime(timezone=True), nullable=True
    )
    review_type: Mapped[str | None] = mapped_column(Text, nullable=True)
    msg_metadata: Mapped[dict | None] = mapped_column("metadata", JSONB, nullable=True)
    # E-FILE S2: 첨부 목록. additive(nullable + server_default '[]') — 0093 마이그와 정합.
    attachments: Mapped[list | None] = mapped_column(
        JSONB, nullable=True, server_default=text("'[]'"), default=list
    )

    conversation: Mapped[Conversation] = relationship("Conversation", back_populates="messages")
