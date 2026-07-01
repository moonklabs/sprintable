"""E-LOOP-LEDGER S1: loop_runs 척추 엔티티(append-only spine).

블루프린트 `e-loop-ledger-blueprint` §1 구현. 반복(loop) — goal→brief→variants→
decision→execute→measure→outcome — 의 spine만 신설하고, 나머지(hypotheses/docs/
assets/gate)는 기존 엔티티를 EXTEND(FK로 연결)한다.

status FSM (§1):
    draft → briefing → generating → deciding → executing → measuring → closed
    draft | briefing | generating | deciding | executing | measuring → abandoned
    (closed | abandoned → 어디로도 역전이 금지 — terminal. app/models/hypothesis.py의
    is_valid_transition 패턴과 동형.)

chosen_artifact_id: loop_artifacts(S2, 후속 스토리)를 가리키나 이 마이그 시점엔 그
테이블이 없어 FK 제약이 없다(컬럼만). S2 마이그가 ALTER TABLE ADD CONSTRAINT로 잠근다.
"""
from __future__ import annotations

import uuid
from datetime import datetime

from sqlalchemy import (
    ARRAY,
    CheckConstraint,
    DateTime,
    ForeignKey,
    Index,
    String,
    Text,
    text,
)
from sqlalchemy.dialects.postgresql import JSONB, UUID
from sqlalchemy.orm import Mapped, mapped_column

from app.core.database import Base
from app.models.base import OrgScopedMixin, SoftDeleteMixin, TimestampMixin

# §1 상태 8종 (DB CHECK와 동기)
LOOP_RUN_STATUSES = frozenset(
    {"draft", "briefing", "generating", "deciding", "executing", "measuring", "closed", "abandoned"}
)

_NON_TERMINAL_STATUSES = frozenset(
    {"draft", "briefing", "generating", "deciding", "executing", "measuring"}
)

# 합법 전이: (from, to). closed/abandoned는 terminal(역전이 없음).
_VALID_TRANSITIONS: set[tuple[str, str]] = {
    ("draft", "briefing"),
    ("briefing", "generating"),
    ("generating", "deciding"),
    ("deciding", "executing"),
    ("executing", "measuring"),
    ("measuring", "closed"),
    # 조기 중단 — closed/abandoned 이전 어느 비-terminal 상태에서든 abandoned 진입 가능.
    *{(s, "abandoned") for s in _NON_TERMINAL_STATUSES},
}


def is_valid_transition(from_status: str, to_status: str) -> bool:
    return (from_status, to_status) in _VALID_TRANSITIONS


class LoopRun(Base, OrgScopedMixin, TimestampMixin, SoftDeleteMixin):
    __tablename__ = "loop_runs"

    id: Mapped[uuid.UUID] = mapped_column(UUID(as_uuid=True), primary_key=True, default=uuid.uuid4)
    project_id: Mapped[uuid.UUID] = mapped_column(
        UUID(as_uuid=True), ForeignKey("projects.id", ondelete="CASCADE"), nullable=False
    )
    parent_loop_id: Mapped[uuid.UUID | None] = mapped_column(
        UUID(as_uuid=True), ForeignKey("loop_runs.id", ondelete="SET NULL"), nullable=True
    )
    hypothesis_id: Mapped[uuid.UUID | None] = mapped_column(
        UUID(as_uuid=True), ForeignKey("hypotheses.id", ondelete="SET NULL"), nullable=True
    )
    brief_doc_id: Mapped[uuid.UUID | None] = mapped_column(
        UUID(as_uuid=True), ForeignKey("docs.id", ondelete="SET NULL"), nullable=True
    )
    decision_gate_id: Mapped[uuid.UUID | None] = mapped_column(
        UUID(as_uuid=True), ForeignKey("gate.id", ondelete="SET NULL"), nullable=True
    )
    # loop_artifacts(S2) 생성 전이라 FK 없음 — 컬럼만.
    chosen_artifact_id: Mapped[uuid.UUID | None] = mapped_column(UUID(as_uuid=True), nullable=True)
    recipe_slug: Mapped[str | None] = mapped_column(Text, nullable=True)
    title: Mapped[str] = mapped_column(Text, nullable=False)
    goal_tags: Mapped[list[str]] = mapped_column(
        ARRAY(Text), nullable=False, server_default=text("'{}'::text[]"), default=list
    )
    status: Mapped[str] = mapped_column(String(24), nullable=False, server_default="draft")
    outcome_snapshot: Mapped[dict | None] = mapped_column(JSONB, nullable=True)
    outcome_attributed_at: Mapped[datetime | None] = mapped_column(DateTime(timezone=True), nullable=True)
    # FK 비강제(hypotheses.owner_member_id/assignee_id 동형 컨벤션) — resolve_member 서비스 해소.
    created_by_member_id: Mapped[uuid.UUID] = mapped_column(UUID(as_uuid=True), nullable=False)

    __table_args__ = (
        CheckConstraint(
            "status IN ('draft','briefing','generating','deciding','executing',"
            "'measuring','closed','abandoned')",
            name="ck_loop_runs_status",
        ),
        CheckConstraint(
            "parent_loop_id IS NULL OR parent_loop_id <> id",
            name="ck_loop_runs_parent_not_self",
        ),
        Index(
            "ix_loop_runs_org_project_status_created_at",
            "org_id",
            "project_id",
            "status",
            text("created_at DESC"),
        ),
        Index("ix_loop_runs_parent_loop_id", "parent_loop_id"),
        Index("ix_loop_runs_goal_tags_gin", "goal_tags", postgresql_using="gin"),
    )
