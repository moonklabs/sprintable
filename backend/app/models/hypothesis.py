"""E1 L3: Hypothesis 1급 엔티티 + epic/story 링크 테이블.

블루프린트 `blueprint-e1-hypothesis-entity` §2 구현. 가설을 epic/story/sprint의
숨은 outcome 컬럼에서 꺼내 `hypotheses` 1급 엔티티로 승격한다. epic/story는 새 FK를
직접 달지 않고 링크 테이블(`hypothesis_epic_links`·`hypothesis_story_links`)로 무접촉 연결.

상태기계 (§2.5):
    proposed → active → measuring → verified | falsified
    proposed | active | measuring → killed
    verified | falsified | killed → archived
    (verified|falsified|killed → active 역전이는 v1 금지 — 새 가설을 만든다.)

owner_member_id: 책임 주체. v1은 반드시 type='human' resolved member.
    canonical member id를 저장하고 FK는 강제하지 않는다(기존 assignee_id와 동형 —
    grant-only 휴먼 회귀 방지). 신원 해소는 API/service의 resolve_member에서.
"""
import uuid
from datetime import datetime

from sqlalchemy import (
    CheckConstraint,
    DateTime,
    ForeignKey,
    Index,
    Numeric,
    String,
    Text,
    UniqueConstraint,
    func,
    text,
)
from sqlalchemy.dialects.postgresql import JSONB, UUID
from sqlalchemy.orm import Mapped, mapped_column

from app.core.database import Base
from app.models.base import OrgScopedMixin, TimestampMixin

# §2.3.1 상태 7종 (DB CHECK와 동기)
HYPOTHESIS_STATUSES = frozenset(
    {"proposed", "active", "measuring", "verified", "falsified", "killed", "archived"}
)

# §2.5 합법 전이: (from, to). verified|falsified|killed → active 역전이는 금지.
_VALID_TRANSITIONS: set[tuple[str, str]] = {
    ("proposed", "active"),
    ("active", "measuring"),
    ("measuring", "verified"),
    ("measuring", "falsified"),
    ("proposed", "killed"),
    ("active", "killed"),
    ("measuring", "killed"),
    ("verified", "archived"),
    ("falsified", "archived"),
    ("killed", "archived"),
}


def is_valid_transition(from_status: str, to_status: str) -> bool:
    return (from_status, to_status) in _VALID_TRANSITIONS


class Hypothesis(Base, OrgScopedMixin, TimestampMixin):
    __tablename__ = "hypotheses"

    id: Mapped[uuid.UUID] = mapped_column(UUID(as_uuid=True), primary_key=True, default=uuid.uuid4)
    project_id: Mapped[uuid.UUID] = mapped_column(
        UUID(as_uuid=True), ForeignKey("projects.id", ondelete="CASCADE"), nullable=False
    )
    # §2.2 휴먼/에이전트 신원. owner는 휴먼 전용, created_by/drafted_by는 에이전트 가능.
    # FK 비강제 — canonical member id 보유(assignee_id 선례). 해소는 service resolve_member.
    owner_member_id: Mapped[uuid.UUID] = mapped_column(UUID(as_uuid=True), nullable=False)
    created_by_member_id: Mapped[uuid.UUID | None] = mapped_column(UUID(as_uuid=True), nullable=True)
    confirmed_by_member_id: Mapped[uuid.UUID | None] = mapped_column(UUID(as_uuid=True), nullable=True)

    # §2.2.4 유일한 수동 텍스트 입력
    statement: Mapped[str] = mapped_column(Text, nullable=False)
    # §2.2.5 기존 outcome validator 호환 {metric, source, target, direction}
    metric_definition: Mapped[dict] = mapped_column(JSONB, nullable=False)
    # §2.2.6 기존 measure_after 의미 승격
    measure_after: Mapped[datetime] = mapped_column(DateTime(timezone=True), nullable=False)
    status: Mapped[str] = mapped_column(String(24), nullable=False, server_default="proposed")
    outcome_result: Mapped[dict | None] = mapped_column(JSONB, nullable=True)
    confidence: Mapped[float | None] = mapped_column(Numeric(5, 4), nullable=True)

    # §2.2.7-8 AI 드래프트 추적. source_snapshot은 입력 일부만(원문 전체 복제 금지).
    source_type: Mapped[str | None] = mapped_column(String(32), nullable=True)
    source_id: Mapped[uuid.UUID | None] = mapped_column(UUID(as_uuid=True), nullable=True)
    source_snapshot: Mapped[dict | None] = mapped_column(JSONB, nullable=True)
    drafted_by_member_id: Mapped[uuid.UUID | None] = mapped_column(UUID(as_uuid=True), nullable=True)
    draft_metadata: Mapped[dict | None] = mapped_column(JSONB, nullable=True)

    # §2.8 휴먼 회계 연결 고리(v1 비어 있어도 됨). §2.9 E2 verdict gate가 읽을 anchor.
    human_accounting: Mapped[dict] = mapped_column(
        JSONB, nullable=False, server_default=text("'{}'::jsonb"), default=dict
    )
    gate_contract: Mapped[dict] = mapped_column(
        JSONB, nullable=False, server_default=text("'{}'::jsonb"), default=dict
    )

    # §3.10 archive=soft. hard delete는 마이그/감사 정책 확정 전까지 금지.
    archived_at: Mapped[datetime | None] = mapped_column(DateTime(timezone=True), nullable=True)

    __table_args__ = (
        # §2.3 제약
        CheckConstraint(
            "status IN ('proposed','active','measuring','verified','falsified','killed','archived')",
            name="ck_hypotheses_status",
        ),
        CheckConstraint(
            "jsonb_typeof(metric_definition) = 'object'",
            name="ck_hypotheses_metric_object",
        ),
        # §2.4 인덱스
        Index(
            "ix_hypotheses_org_project_status_created_at",
            "org_id",
            "project_id",
            "status",
            text("created_at DESC"),
        ),
        Index(
            "ix_hypotheses_owner",
            "org_id",
            "owner_member_id",
            text("created_at DESC"),
        ),
        Index(
            "ix_hypotheses_measure_due",
            "org_id",
            "status",
            "measure_after",
            postgresql_where=text("status IN ('active','measuring')"),
        ),
        Index(
            "ix_hypotheses_metric_gin",
            "metric_definition",
            postgresql_using="gin",
        ),
        Index(
            "ix_hypotheses_source",
            "org_id",
            "source_type",
            "source_id",
        ),
    )


class HypothesisEpicLink(Base):
    """§2.6 가설↔에픽 연결. link_type='primary'는 대표 가설 배지."""

    __tablename__ = "hypothesis_epic_links"

    id: Mapped[uuid.UUID] = mapped_column(UUID(as_uuid=True), primary_key=True, default=uuid.uuid4)
    hypothesis_id: Mapped[uuid.UUID] = mapped_column(
        UUID(as_uuid=True), ForeignKey("hypotheses.id", ondelete="CASCADE"), nullable=False
    )
    epic_id: Mapped[uuid.UUID] = mapped_column(
        UUID(as_uuid=True), ForeignKey("epics.id", ondelete="CASCADE"), nullable=False
    )
    link_type: Mapped[str] = mapped_column(String(24), nullable=False, server_default="primary")
    created_at: Mapped[datetime] = mapped_column(
        DateTime(timezone=True), server_default=func.now(), nullable=False
    )

    __table_args__ = (
        UniqueConstraint("hypothesis_id", "epic_id", name="uq_hypothesis_epic_links"),
        Index("ix_hypothesis_epic_links_epic", "epic_id", "link_type"),
    )


class HypothesisStoryLink(Base):
    """§2.6 가설↔스토리 연결. link_type='supports'는 실행 근거·dispatch 앵커."""

    __tablename__ = "hypothesis_story_links"

    id: Mapped[uuid.UUID] = mapped_column(UUID(as_uuid=True), primary_key=True, default=uuid.uuid4)
    hypothesis_id: Mapped[uuid.UUID] = mapped_column(
        UUID(as_uuid=True), ForeignKey("hypotheses.id", ondelete="CASCADE"), nullable=False
    )
    story_id: Mapped[uuid.UUID] = mapped_column(
        UUID(as_uuid=True), ForeignKey("stories.id", ondelete="CASCADE"), nullable=False
    )
    link_type: Mapped[str] = mapped_column(String(24), nullable=False, server_default="supports")
    created_at: Mapped[datetime] = mapped_column(
        DateTime(timezone=True), server_default=func.now(), nullable=False
    )

    __table_args__ = (
        UniqueConstraint("hypothesis_id", "story_id", name="uq_hypothesis_story_links"),
        Index("ix_hypothesis_story_links_story", "story_id"),
    )


class HypothesisSprintLink(Base):
    """E-SPRINT-LOOP a4acc4d0: 가설↔스프린트 연결. epic/story 링크와 달리 **N:1**(PO 결·
    2026-07-03) — sprint는 시간상자, 가설은 그 안의 실험이라 한 가설은 정확히 1개 sprint에
    속한다(epic/story의 N:M 지지 관계와 의미론이 다름). cross-sprint 복리는 링크가 아니라
    회수(context_pack_search·project 전역)로 성립하므로 멀티링크 불필요 — §6 비협상은
    context_pack_search.py에 sprint_id 필터를 추가하지 않는 것으로 준수(이 테이블 신설과
    무관하게 그 파일은 org_id+project_id 스코프 그대로).

    link_type: 'declared'(sprint 열기 시 직접 선언, 기본) | 'seeded'(이전 sprint의 L3
    다음가설 추천을 채택해 생긴 링크 — story 3). seed된 가설의 home도 여전히 1개(seed
    대상 sprint) — 측정이 걸쳐도 선언 sprint에 잔류(§ PO 결).
    """

    __tablename__ = "hypothesis_sprint_links"

    id: Mapped[uuid.UUID] = mapped_column(UUID(as_uuid=True), primary_key=True, default=uuid.uuid4)
    hypothesis_id: Mapped[uuid.UUID] = mapped_column(
        UUID(as_uuid=True), ForeignKey("hypotheses.id", ondelete="CASCADE"), nullable=False
    )
    sprint_id: Mapped[uuid.UUID] = mapped_column(
        UUID(as_uuid=True), ForeignKey("sprints.id", ondelete="CASCADE"), nullable=False
    )
    link_type: Mapped[str] = mapped_column(String(24), nullable=False, server_default="declared")
    created_at: Mapped[datetime] = mapped_column(
        DateTime(timezone=True), server_default=func.now(), nullable=False
    )

    __table_args__ = (
        # N:1 강제(PO 결) — epic/story의 (hypothesis_id, target_id) 쌍 unique와 달리
        # hypothesis_id 단독 unique. 재배정은 서비스가 upsert(기존 링크 delete→insert)로 처리.
        UniqueConstraint("hypothesis_id", name="uq_hypothesis_sprint_links_hypothesis"),
        Index("ix_hypothesis_sprint_links_sprint", "sprint_id"),
    )
