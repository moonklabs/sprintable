import uuid
from datetime import date, datetime

from sqlalchemy import BigInteger, Boolean, Date, DateTime, ForeignKey, Integer, String, Text, func, text
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
    # (0078). canonical은 legacy 컬럼이 canonicalize_member_id로 보유((A) resolver-cutover);
    # 백필-only vestigial assignee_id_v2는 0090서 DROP. 컬럼·nullable 유지.
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
    # E-GLANCE wedge #2(story 96b19bc3) — 로드맵 조타 큐레이션. Story.position과 완전 동형
    # (null=아직 큐레이션 안 됨·자동도출 순서 유지). 0175 additive nullable.
    position: Mapped[int | None] = mapped_column(BigInteger, nullable=True)
    # source_loop_id: 어떤 epic이 어느 Loop 결과에서 파생 제안됐는지 계보 인터페이스(컬럼만·
    # 배선은 P3 후속). Loop이 epic을 자동 생성하지 않음(STEER: 휴먼이 항상 약속을 얹는다).
    source_loop_id: Mapped[uuid.UUID | None] = mapped_column(
        UUID(as_uuid=True), ForeignKey("loop_runs.id", ondelete="SET NULL"), nullable=True
    )

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
    # (0078). canonical은 legacy 컬럼이 canonicalize_member_id로 보유((A) resolver-cutover);
    # 백필-only vestigial assignee_id_v2는 0090서 DROP. 컬럼·nullable 유지.
    assignee_id: Mapped[uuid.UUID | None] = mapped_column(
        UUID(as_uuid=True), nullable=True
    )
    # P0-03(doc trust-pipeline-be-design §5·story 23b9bdac): Human owner — assignee_id/assignee_ids
    # (혼합 human/agent)와 별도 필드. 0176 additive nullable. FK 미부여(assignee_id와 동일 이유 —
    # team_members VIEW/org_members 양쪽 해소값이라 단일 물리 FK 불가). write-time에 resolve_
    # member_identity로 human 강제(app-level).
    human_owner_member_id: Mapped[uuid.UUID | None] = mapped_column(
        UUID(as_uuid=True), nullable=True
    )
    # P0-05 후속(doc scope-violation-signal-design §3·story 174be6bc): 작업 착수 시점 자발적 선언
    # 파일-경로 글롭 배열(0178 additive). None/빈 배열 = 판정 무신호(scope_violation 항상 False 유지).
    declared_scope_paths: Mapped[list | None] = mapped_column(JSONB, nullable=True)
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
    # E-FILE S4: 보드 스토리 첨부 (chat과 동형 {url,name,content_type,size} list). additive.
    attachments: Mapped[list | None] = mapped_column(
        JSONB, nullable=True, server_default=text("'[]'"), default=list
    )

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
    # (0078). canonical은 legacy 컬럼이 canonicalize_member_id로 보유((A) resolver-cutover);
    # 백필-only vestigial assignee_id_v2는 0090서 DROP. 컬럼·nullable 유지.
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
