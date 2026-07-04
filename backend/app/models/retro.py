import uuid
from datetime import datetime

from sqlalchemy import DateTime, ForeignKey, Integer, Text, func
from sqlalchemy.dialects.postgresql import JSONB, UUID
from sqlalchemy.orm import Mapped, mapped_column, relationship

from app.core.database import Base
from app.models.base import OrgScopedMixin, TimestampMixin

# B1(9f27af8f): 6게이트(collect/group/vote/discuss/action/closed) → 3능동게이트+terminal 로
# de-gate(rename 아님) — 유나 locked mockup §B1. group/discuss는 강제 통과 게이트였던 게 문제라
# 비차단 선택 액션으로 강등(group=B2 그룹핑 툴, discuss=선택 노트 — 둘 다 전용 phase 불요, 언제든
# 가능). 기존 세션은 마이그 0145에서 {group→vote, discuss→action}로 일괄 이관(공존 아님).
RETRO_PHASES = ("collect", "vote", "action", "closed")

# 3 능동단계(collect/vote/action)는 인접 양방향(뒤로가기 포함, 데이터 PRESERVE) + action→closed
# 편도. closed는 terminal 고정(되돌리면 투표/액션 수정 가능성과 감사 의미가 섞임 — 유나 스펙
# "terminal 유지"). 비인접 점프(예: collect→action, collect→closed)는 여전히 거부.
ALLOWED_PHASE_TRANSITIONS: dict[str, frozenset[str]] = {
    "collect": frozenset({"vote"}),
    "vote": frozenset({"collect", "action"}),
    "action": frozenset({"vote", "closed"}),
    "closed": frozenset(),
}


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
    # dc861e44 §5 — L2 종합(on-demand). null=미생성→FE "종합 생성" CTA. overwrite 저장
    # (PO 결 2026-07-03: 1세션=1 최신·이력 보존 YAGNI — 진짜 결정은 story 3서 proposed
    # 가설로 별도 영속). shape: {learned:[{text,source}], generated_at, source:'ai_draft'}.
    synthesis: Mapped[dict | None] = mapped_column(JSONB, nullable=True)
    # dc861e44 §5 — L3 다음가설 추천(on-demand). synthesis 선행 필수(recommend-next가
    # 409 SYNTHESIS_REQUIRED로 fail-closed 가드). overwrite 저장(synthesis와 동일 정책).
    # shape: [{id,statement,metric_definition,measure_after,confidence,rationale,
    #          requires_confirmation:true}]
    next_hypotheses: Mapped[list | None] = mapped_column(JSONB, nullable=True)

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
