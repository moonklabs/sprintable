import uuid
from datetime import date

from sqlalchemy import Date, ForeignKey, Text, UniqueConstraint
from sqlalchemy.dialects.postgresql import ARRAY, UUID
from sqlalchemy.orm import Mapped, mapped_column, relationship

from app.core.database import Base
from app.models.base import OrgScopedMixin, TimestampMixin


class StandupEntry(Base, OrgScopedMixin, TimestampMixin):
    __tablename__ = "standup_entries"

    id: Mapped[uuid.UUID] = mapped_column(UUID(as_uuid=True), primary_key=True, default=uuid.uuid4)
    # E-STANDUP 3b6b567c: org-level 재설계 — 엔트리는 (org_id, author_id, date) 단위 1건.
    # project_id 는 nullable 로 완화(레거시 origin 보존·기존 project-filter read 무파손).
    # 프로젝트 surface 는 standup_entry_projects link 로 projection(51447ca0).
    project_id: Mapped[uuid.UUID | None] = mapped_column(
        UUID(as_uuid=True), ForeignKey("projects.id", ondelete="CASCADE"), nullable=True, index=True
    )
    sprint_id: Mapped[uuid.UUID | None] = mapped_column(
        UUID(as_uuid=True), ForeignKey("sprints.id", ondelete="SET NULL"), nullable=True
    )
    # E-MEMBER-SSOT(6a1e8b1d): team_members FK 완화 — resolve_member가 grant-only 휴먼에
    # org_member.id(canonical member.id 방향)를 반환하므로 team_members FK 제약 제거.
    # migration 0074에서 DROP (0069 conv/events·0073 notif 동일 패턴). 컬럼·인덱스 유지.
    author_id: Mapped[uuid.UUID] = mapped_column(
        UUID(as_uuid=True), nullable=False, index=True
    )
    date: Mapped[date] = mapped_column(Date, nullable=False, index=True)
    done: Mapped[str | None] = mapped_column(Text, nullable=True)
    plan: Mapped[str | None] = mapped_column(Text, nullable=True)
    blockers: Mapped[str | None] = mapped_column(Text, nullable=True)
    plan_story_ids: Mapped[list[uuid.UUID]] = mapped_column(
        ARRAY(UUID(as_uuid=True)), nullable=False, default=list
    )

    feedbacks: Mapped[list["StandupFeedback"]] = relationship(
        "StandupFeedback", back_populates="entry", lazy="select"
    )
    projects: Mapped[list["StandupEntryProject"]] = relationship(
        "StandupEntryProject", back_populates="entry", lazy="select",
        cascade="all, delete-orphan",
    )


class StandupEntryProject(Base):
    """E-STANDUP 3b6b567c: org-level 스탠드업 엔트리 ↔ 프로젝트 projection link.

    하나의 org-level 엔트리가 복수 프로젝트 보드에 surface 되도록 명시 M:N 링크.
    plan_story_ids-derive 대비: 스토리 계획이 빈 엔트리도 orphan 되지 않음.
    write 시 링크 채우기는 1c2be9db(write API) 스코프, read projection 은 51447ca0.
    """
    __tablename__ = "standup_entry_projects"

    id: Mapped[uuid.UUID] = mapped_column(UUID(as_uuid=True), primary_key=True, default=uuid.uuid4)
    entry_id: Mapped[uuid.UUID] = mapped_column(
        UUID(as_uuid=True), ForeignKey("standup_entries.id", ondelete="CASCADE"), nullable=False, index=True
    )
    project_id: Mapped[uuid.UUID] = mapped_column(
        UUID(as_uuid=True), ForeignKey("projects.id", ondelete="CASCADE"), nullable=False, index=True
    )
    org_id: Mapped[uuid.UUID] = mapped_column(UUID(as_uuid=True), nullable=False, index=True)

    entry: Mapped["StandupEntry"] = relationship("StandupEntry", back_populates="projects")

    __table_args__ = (
        UniqueConstraint("entry_id", "project_id", name="uq_standup_entry_project"),
    )


class StandupFeedback(Base, OrgScopedMixin, TimestampMixin):
    __tablename__ = "standup_feedback"

    id: Mapped[uuid.UUID] = mapped_column(UUID(as_uuid=True), primary_key=True, default=uuid.uuid4)
    project_id: Mapped[uuid.UUID] = mapped_column(
        UUID(as_uuid=True), ForeignKey("projects.id", ondelete="CASCADE"), nullable=False, index=True
    )
    sprint_id: Mapped[uuid.UUID | None] = mapped_column(
        UUID(as_uuid=True), ForeignKey("sprints.id", ondelete="SET NULL"), nullable=True
    )
    standup_entry_id: Mapped[uuid.UUID] = mapped_column(
        UUID(as_uuid=True), ForeignKey("standup_entries.id", ondelete="CASCADE"), nullable=False, index=True
    )
    # E-MEMBER-SSOT(6a1e8b1d): team_members FK 선제 완화 — author_id와 동일 anchor 방향(canonical
    # member.id). 현재 add_feedback는 클라 body.feedback_by_id를 쓰지만, 동일 latent B-bug
    # 방지 위해 같은 migration 0074에서 동반 DROP. 컬럼·인덱스 유지.
    feedback_by_id: Mapped[uuid.UUID] = mapped_column(
        UUID(as_uuid=True), nullable=False, index=True
    )
    review_type: Mapped[str] = mapped_column(Text, nullable=False, default="comment")
    feedback_text: Mapped[str] = mapped_column(Text, nullable=False)

    entry: Mapped[StandupEntry] = relationship("StandupEntry", back_populates="feedbacks")
