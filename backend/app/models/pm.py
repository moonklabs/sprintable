import uuid
from datetime import date, datetime

from sqlalchemy import BigInteger, Boolean, Date, DateTime, ForeignKey, Integer, String, Text, func
from sqlalchemy.dialects.postgresql import JSONB, UUID
from sqlalchemy.orm import Mapped, mapped_column, relationship

from app.core.database import Base
from app.models.base import OrgScopedMixin, SoftDeleteMixin, TimestampMixin


class Sprint(Base, OrgScopedMixin, TimestampMixin):
    __tablename__ = "sprints"

    id: Mapped[uuid.UUID] = mapped_column(UUID(as_uuid=True), primary_key=True, default=uuid.uuid4)
    project_id: Mapped[uuid.UUID] = mapped_column(
        UUID(as_uuid=True), ForeignKey("projects.id", ondelete="CASCADE"), nullable=False, index=True
    )
    report_doc_id: Mapped[uuid.UUID | None] = mapped_column(
        UUID(as_uuid=True), ForeignKey("docs.id", ondelete="SET NULL"), nullable=True
    )
    title: Mapped[str] = mapped_column(Text, nullable=False)
    status: Mapped[str] = mapped_column(String(20), nullable=False, default="planning")
    start_date: Mapped[date | None] = mapped_column(Date, nullable=True)
    end_date: Mapped[date | None] = mapped_column(Date, nullable=True)
    velocity: Mapped[int | None] = mapped_column(Integer, nullable=True)
    team_size: Mapped[int | None] = mapped_column(Integer, nullable=True)
    duration: Mapped[int] = mapped_column(Integer, nullable=False, default=14)
    # E-BOARD-SCHEMA S4: 스프린트 목표·공수 (goal=실행목표, success_hypothesis=효과가설과 별개)
    goal: Mapped[str | None] = mapped_column(Text, nullable=True)
    # capacity=가용 공수(SP), team_size=인원수와 별개
    capacity: Mapped[int | None] = mapped_column(Integer, nullable=True)
    # E-OUTCOME-LOOP: 의도 필드 (intent)
    success_hypothesis: Mapped[str | None] = mapped_column(Text, nullable=True)
    metric_definition: Mapped[dict | None] = mapped_column(JSONB, nullable=True)
    measure_after: Mapped[datetime | None] = mapped_column(DateTime(timezone=True), nullable=True)
    # E-OUTCOME-LOOP: 채점 필드 (outcome, 채점잡 전용)
    outcome_status: Mapped[str] = mapped_column(String(20), nullable=False, server_default="n_a")
    outcome_result: Mapped[dict | None] = mapped_column(JSONB, nullable=True)

    project: Mapped["Project"] = relationship("Project", back_populates="sprints")
    stories: Mapped[list["Story"]] = relationship("Story", back_populates="sprint", lazy="select")


class Epic(Base, OrgScopedMixin, TimestampMixin):
    __tablename__ = "epics"

    id: Mapped[uuid.UUID] = mapped_column(UUID(as_uuid=True), primary_key=True, default=uuid.uuid4)
    project_id: Mapped[uuid.UUID] = mapped_column(
        UUID(as_uuid=True), ForeignKey("projects.id", ondelete="CASCADE"), nullable=False, index=True
    )
    # E-MEMBER-SSOT AC3-2: team_members FK 완화 — grant-only 휴먼(org_member.id) 할당 500 해소
    # (migration 0078). canonical 식별자는 assignee_id_v2. 컬럼·nullable 유지.
    assignee_id: Mapped[uuid.UUID | None] = mapped_column(
        UUID(as_uuid=True), nullable=True
    )
    title: Mapped[str] = mapped_column(Text, nullable=False)
    status: Mapped[str] = mapped_column(String(20), nullable=False, default="active")
    priority: Mapped[str] = mapped_column(String(20), nullable=False, default="medium")
    description: Mapped[str | None] = mapped_column(Text, nullable=True)
    objective: Mapped[str | None] = mapped_column(Text, nullable=True)
    success_criteria: Mapped[str | None] = mapped_column(Text, nullable=True)
    target_sp: Mapped[int | None] = mapped_column(Integer, nullable=True)
    target_date: Mapped[date | None] = mapped_column(Date, nullable=True)
    # E-BOARD-SCHEMA: 의도 필드 (intent)
    success_hypothesis: Mapped[str | None] = mapped_column(Text, nullable=True)
    metric_definition: Mapped[dict | None] = mapped_column(JSONB, nullable=True)
    measure_after: Mapped[datetime | None] = mapped_column(DateTime(timezone=True), nullable=True)
    # E-BOARD-SCHEMA: 채점 필드 (outcome, 채점잡 전용)
    outcome_status: Mapped[str] = mapped_column(String(20), nullable=False, server_default="n_a")
    outcome_result: Mapped[dict | None] = mapped_column(JSONB, nullable=True)

    project: Mapped["Project"] = relationship("Project", back_populates="epics")
    stories: Mapped[list["Story"]] = relationship("Story", back_populates="epic", lazy="select")


class Story(Base, OrgScopedMixin, TimestampMixin, SoftDeleteMixin):
    __tablename__ = "stories"

    id: Mapped[uuid.UUID] = mapped_column(UUID(as_uuid=True), primary_key=True, default=uuid.uuid4)
    project_id: Mapped[uuid.UUID] = mapped_column(
        UUID(as_uuid=True), ForeignKey("projects.id", ondelete="CASCADE"), nullable=False, index=True
    )
    epic_id: Mapped[uuid.UUID | None] = mapped_column(
        UUID(as_uuid=True), ForeignKey("epics.id", ondelete="SET NULL"), nullable=True
    )
    sprint_id: Mapped[uuid.UUID | None] = mapped_column(
        UUID(as_uuid=True), ForeignKey("sprints.id", ondelete="SET NULL"), nullable=True
    )
    # E-MEMBER-SSOT AC3-2: team_members FK 완화 — grant-only 휴먼(org_member.id) 할당 500 해소
    # (migration 0078). canonical 식별자는 assignee_id_v2. 컬럼·nullable 유지.
    assignee_id: Mapped[uuid.UUID | None] = mapped_column(
        UUID(as_uuid=True), nullable=True
    )
    meeting_id: Mapped[uuid.UUID | None] = mapped_column(
        UUID(as_uuid=True), ForeignKey("meetings.id", ondelete="SET NULL"), nullable=True
    )
    title: Mapped[str] = mapped_column(Text, nullable=False)
    status: Mapped[str] = mapped_column(String(30), nullable=False, default="backlog")
    priority: Mapped[str] = mapped_column(String(20), nullable=False, default="medium")
    story_points: Mapped[int | None] = mapped_column(Integer, nullable=True)
    description: Mapped[str | None] = mapped_column(Text, nullable=True)
    acceptance_criteria: Mapped[str | None] = mapped_column(Text, nullable=True)
    position: Mapped[int | None] = mapped_column(BigInteger, nullable=True)
    # E-CAGE-REFEREE P1: 데이터 오염 마킹 (삭제 아닌 플래그, 신뢰점수 집계 제외용)
    is_excluded: Mapped[bool] = mapped_column(Boolean, nullable=False, server_default="false", default=False)
    # E-OUTCOME-LOOP: 의도 필드 (intent)
    success_hypothesis: Mapped[str | None] = mapped_column(Text, nullable=True)
    metric_definition: Mapped[dict | None] = mapped_column(JSONB, nullable=True)
    measure_after: Mapped[datetime | None] = mapped_column(DateTime(timezone=True), nullable=True)
    # E-OUTCOME-LOOP: 채점 필드 (outcome, 채점잡 전용)
    outcome_status: Mapped[str] = mapped_column(String(20), nullable=False, server_default="n_a")
    outcome_result: Mapped[dict | None] = mapped_column(JSONB, nullable=True)

    epic: Mapped[Epic | None] = relationship("Epic", back_populates="stories")
    sprint: Mapped[Sprint | None] = relationship("Sprint", back_populates="stories")
    tasks: Mapped[list["Task"]] = relationship("Task", back_populates="story", lazy="select")


class Task(Base, OrgScopedMixin, TimestampMixin, SoftDeleteMixin):
    __tablename__ = "tasks"

    id: Mapped[uuid.UUID] = mapped_column(UUID(as_uuid=True), primary_key=True, default=uuid.uuid4)
    story_id: Mapped[uuid.UUID] = mapped_column(
        UUID(as_uuid=True), ForeignKey("stories.id", ondelete="CASCADE"), nullable=False, index=True
    )
    # E-MEMBER-SSOT AC3-2: team_members FK 완화 — grant-only 휴먼(org_member.id) 할당 500 해소
    # (migration 0078). canonical 식별자는 assignee_id_v2. 컬럼·nullable 유지.
    assignee_id: Mapped[uuid.UUID | None] = mapped_column(
        UUID(as_uuid=True), nullable=True
    )
    title: Mapped[str] = mapped_column(Text, nullable=False)
    status: Mapped[str] = mapped_column(String(20), nullable=False, default="todo")
    story_points: Mapped[int | None] = mapped_column(Integer, nullable=True)

    story: Mapped[Story] = relationship("Story", back_populates="tasks")


class StoryComment(Base, OrgScopedMixin):
    __tablename__ = "story_comments"

    id: Mapped[uuid.UUID] = mapped_column(UUID(as_uuid=True), primary_key=True, default=uuid.uuid4)
    story_id: Mapped[uuid.UUID] = mapped_column(
        UUID(as_uuid=True), ForeignKey("stories.id", ondelete="CASCADE"), nullable=False, index=True
    )
    project_id: Mapped[uuid.UUID] = mapped_column(
        UUID(as_uuid=True), ForeignKey("projects.id", ondelete="CASCADE"), nullable=False
    )
    content: Mapped[str] = mapped_column(Text, nullable=False)
    created_by: Mapped[uuid.UUID] = mapped_column(
        UUID(as_uuid=True), nullable=False
    )
    created_at: Mapped[datetime] = mapped_column(
        DateTime(timezone=True), server_default=func.now(), nullable=False
    )


class StoryActivity(Base, OrgScopedMixin):
    __tablename__ = "story_activities"

    id: Mapped[uuid.UUID] = mapped_column(UUID(as_uuid=True), primary_key=True, default=uuid.uuid4)
    story_id: Mapped[uuid.UUID] = mapped_column(
        UUID(as_uuid=True), ForeignKey("stories.id", ondelete="CASCADE"), nullable=False, index=True
    )
    project_id: Mapped[uuid.UUID] = mapped_column(
        UUID(as_uuid=True), ForeignKey("projects.id", ondelete="CASCADE"), nullable=False
    )
    activity_type: Mapped[str] = mapped_column(Text, nullable=False)
    old_value: Mapped[str | None] = mapped_column(Text, nullable=True)
    new_value: Mapped[str | None] = mapped_column(Text, nullable=True)
    created_by: Mapped[uuid.UUID] = mapped_column(
        UUID(as_uuid=True), nullable=False
    )
    created_at: Mapped[datetime] = mapped_column(
        DateTime(timezone=True), server_default=func.now(), nullable=False
    )


from app.models.project import Project  # noqa: E402, F401
