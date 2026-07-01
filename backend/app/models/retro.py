import uuid
from datetime import datetime

from sqlalchemy import DateTime, ForeignKey, Integer, Text, func
from sqlalchemy.dialects.postgresql import UUID
from sqlalchemy.orm import Mapped, mapped_column, relationship

from app.core.database import Base
from app.models.base import OrgScopedMixin, TimestampMixin

RETRO_PHASES = ("collect", "group", "vote", "discuss", "action", "closed")
PHASE_TRANSITIONS: dict[str, str] = {p: RETRO_PHASES[i + 1] for i, p in enumerate(RETRO_PHASES[:-1])}


class RetroSession(Base, OrgScopedMixin, TimestampMixin):
    __tablename__ = "retro_sessions"

    id: Mapped[uuid.UUID] = mapped_column(UUID(as_uuid=True), primary_key=True, default=uuid.uuid4)
    project_id: Mapped[uuid.UUID] = mapped_column(
        UUID(as_uuid=True), ForeignKey("projects.id", ondelete="CASCADE"), nullable=False, index=True
    )
    sprint_id: Mapped[uuid.UUID | None] = mapped_column(
        UUID(as_uuid=True), ForeignKey("sprints.id", ondelete="SET NULL"), nullable=True
    )
    created_by: Mapped[uuid.UUID | None] = mapped_column(
        UUID(as_uuid=True), nullable=True
    )
    title: Mapped[str] = mapped_column(Text, nullable=False)
    phase: Mapped[str] = mapped_column(Text, nullable=False, default="collect")

    items: Mapped[list["RetroItem"]] = relationship("RetroItem", back_populates="session", lazy="select")
    actions: Mapped[list["RetroAction"]] = relationship("RetroAction", back_populates="session", lazy="select")


class RetroItem(Base):
    __tablename__ = "retro_items"

    id: Mapped[uuid.UUID] = mapped_column(UUID(as_uuid=True), primary_key=True, default=uuid.uuid4)
    session_id: Mapped[uuid.UUID] = mapped_column(
        UUID(as_uuid=True), ForeignKey("retro_sessions.id", ondelete="CASCADE"), nullable=False, index=True
    )
    author_id: Mapped[uuid.UUID | None] = mapped_column(
        UUID(as_uuid=True), nullable=True
    )
    category: Mapped[str] = mapped_column(Text, nullable=False)
    text: Mapped[str] = mapped_column(Text, nullable=False)
    vote_count: Mapped[int] = mapped_column(Integer, nullable=False, default=0)
    # B2(9f27af8f): 'group' phase 병합 — child가 가리키는 값. parent는 반드시 top-level
    # (parent_item_id IS NULL)이어야 함(체인/사이클 방지, app-level 검증 — 같은 테이블 참조라
    # CHECK 제약으로 표현 불가). child는 vote 불가·투표는 parent로 이관.
    parent_item_id: Mapped[uuid.UUID | None] = mapped_column(
        UUID(as_uuid=True), ForeignKey("retro_items.id", ondelete="SET NULL"), nullable=True, index=True
    )
    created_at: Mapped[datetime] = mapped_column(
        DateTime(timezone=True), server_default=func.now(), nullable=False
    )

    session: Mapped[RetroSession] = relationship("RetroSession", back_populates="items")
    votes: Mapped[list["RetroVote"]] = relationship("RetroVote", back_populates="item", lazy="select")
    parent: Mapped["RetroItem | None"] = relationship(
        "RetroItem", remote_side=[id], back_populates="children"
    )
    children: Mapped[list["RetroItem"]] = relationship(
        "RetroItem", back_populates="parent", lazy="select"
    )


class RetroVote(Base):
    __tablename__ = "retro_votes"

    id: Mapped[uuid.UUID] = mapped_column(UUID(as_uuid=True), primary_key=True, default=uuid.uuid4)
    item_id: Mapped[uuid.UUID] = mapped_column(
        UUID(as_uuid=True), ForeignKey("retro_items.id", ondelete="CASCADE"), nullable=False, index=True
    )
    voter_id: Mapped[uuid.UUID] = mapped_column(
        UUID(as_uuid=True), nullable=False
    )
    created_at: Mapped[datetime] = mapped_column(
        DateTime(timezone=True), server_default=func.now(), nullable=False
    )

    item: Mapped[RetroItem] = relationship("RetroItem", back_populates="votes")


class RetroAction(Base):
    __tablename__ = "retro_actions"

    id: Mapped[uuid.UUID] = mapped_column(UUID(as_uuid=True), primary_key=True, default=uuid.uuid4)
    session_id: Mapped[uuid.UUID] = mapped_column(
        UUID(as_uuid=True), ForeignKey("retro_sessions.id", ondelete="CASCADE"), nullable=False, index=True
    )
    assignee_id: Mapped[uuid.UUID | None] = mapped_column(
        UUID(as_uuid=True), nullable=True
    )
    title: Mapped[str] = mapped_column(Text, nullable=False)
    status: Mapped[str] = mapped_column(Text, nullable=False, default="open")
    created_at: Mapped[datetime] = mapped_column(
        DateTime(timezone=True), server_default=func.now(), nullable=False
    )

    session: Mapped[RetroSession] = relationship("RetroSession", back_populates="actions")
