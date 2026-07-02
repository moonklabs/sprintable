"""E-LOOP-LEDGER S1+S2: loop_runs 척추 + loop_artifacts(variant) 엔티티.

블루프린트 `e-loop-ledger-blueprint` §1/§2 구현. 반복(loop) — goal→brief→variants→
decision→execute→measure→outcome — 의 spine + variant 후보를 신설하고, 나머지
(hypotheses/docs/assets/gate)는 기존 엔티티를 EXTEND(FK로 연결)한다.

status FSM (§1):
    draft → briefing → generating → deciding → executing → measuring → closed
    draft | briefing | generating | deciding | executing | measuring → abandoned
    (closed | abandoned → 어디로도 역전이 금지 — terminal. app/models/hypothesis.py의
    is_valid_transition 패턴과 동형.)

chosen_artifact_id: S1 마이그(0149) 시점엔 loop_artifacts가 없어 컬럼만 있었으나, S2
마이그(0150)가 ALTER TABLE ADD CONSTRAINT로 FK를 잠갔다 — 이 모델(ORM 레벨)도 동일하게
FK를 선언해야 fresh-runnable(create_all) 스키마가 마이그 스키마와 일치한다(선언 안 하면
model↔migration drift — Gate 미등록 사건과 동일 클래스).
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
    Integer,
    String,
    Text,
    text,
)
from sqlalchemy.dialects.postgresql import JSONB, UUID
from sqlalchemy.orm import Mapped, mapped_column

from app.core.database import Base
from app.models.base import OrgScopedMixin, TimestampMixin, SoftDeleteMixin

# §2 decision 3종
LOOP_ARTIFACT_DECISIONS = frozenset({"pending", "chosen", "rejected"})

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
    # name+use_alter=True 필수 — loop_artifacts.loop_id→loop_runs.id 와 함께 진짜 2-테이블
    # FK 순환을 이룬다(parent_loop_id self-FK와 다른 클래스). 무명이면 SQLAlchemy
    # Base.metadata.drop_all()이 DROP 순서를 못 풀어 CircularDependencyError(까심 QA 발견,
    # fresh-schema 라운드트립 쓰는 테스트 다수가 회귀). 마이그 0150의
    # op.create_foreign_key("fk_loop_runs_chosen_artifact_id", ...)와 이름 일치 필수.
    chosen_artifact_id: Mapped[uuid.UUID | None] = mapped_column(
        UUID(as_uuid=True),
        ForeignKey(
            "loop_artifacts.id", ondelete="SET NULL",
            name="fk_loop_runs_chosen_artifact_id", use_alter=True,
        ),
        nullable=True
    )
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

    # S28(story 116e6fe8) AC④: Context Pack synthesis/recommendation content-hash 캐시(gen-LLM
    # 재호출 방지 — "같은 입력=1회만"). cache_key가 최신 회수 items+loop 맥락+모델/프롬프트
    # 버전 해시와 일치할 때만 재사용(app/services/context_pack_items.py::_compute_cache_key).
    context_pack_cache_key: Mapped[str | None] = mapped_column(String(64), nullable=True)
    context_pack_synthesis: Mapped[str | None] = mapped_column(Text, nullable=True)
    context_pack_synthesis_confidence: Mapped[str | None] = mapped_column(String(16), nullable=True)
    context_pack_recommendation: Mapped[str | None] = mapped_column(Text, nullable=True)
    context_pack_recommendation_confidence: Mapped[str | None] = mapped_column(String(16), nullable=True)
    context_pack_cached_at: Mapped[datetime | None] = mapped_column(DateTime(timezone=True), nullable=True)

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


class LoopArtifact(Base, OrgScopedMixin, TimestampMixin):
    """§2: loop당 variant 후보 + per-variant 결정/이유. rejection_reason=moat 신호원."""

    __tablename__ = "loop_artifacts"

    id: Mapped[uuid.UUID] = mapped_column(UUID(as_uuid=True), primary_key=True, default=uuid.uuid4)
    loop_id: Mapped[uuid.UUID] = mapped_column(
        UUID(as_uuid=True), ForeignKey("loop_runs.id", ondelete="CASCADE"), nullable=False
    )
    asset_id: Mapped[uuid.UUID] = mapped_column(
        UUID(as_uuid=True), ForeignKey("assets.id", ondelete="CASCADE"), nullable=False
    )
    variant_group: Mapped[str] = mapped_column(Text, nullable=False)
    variant_label: Mapped[str] = mapped_column(Text, nullable=False)
    decision: Mapped[str] = mapped_column(String(16), nullable=False, server_default="pending")
    choose_reason: Mapped[str | None] = mapped_column(Text, nullable=True)
    # ⭐moat 신호원 — 왜 반려했나. 필수화(게이트 강제)는 S5 스코프, 스키마는 nullable.
    rejection_reason: Mapped[str | None] = mapped_column(Text, nullable=True)
    generation_metadata: Mapped[dict] = mapped_column(
        JSONB, nullable=False, server_default=text("'{}'::jsonb"), default=dict
    )
    sort_order: Mapped[int] = mapped_column(Integer, nullable=False, server_default="0")
    # FK 비강제(hypotheses.owner_member_id 동형 컨벤션) — resolve_member 서비스 해소.
    created_by_member_id: Mapped[uuid.UUID] = mapped_column(UUID(as_uuid=True), nullable=False)

    __table_args__ = (
        CheckConstraint(
            "decision IN ('pending','chosen','rejected')",
            name="ck_loop_artifacts_decision",
        ),
        Index(
            "ix_loop_artifacts_loop_variant_group",
            "loop_id",
            "variant_group",
            "sort_order",
        ),
        Index("ix_loop_artifacts_asset_id", "asset_id"),
        # 슬롯(variant_group)당 승자 ≤1 — chosen 행만 대상인 partial unique.
        Index(
            "uq_loop_artifacts_chosen_per_group",
            "loop_id",
            "variant_group",
            unique=True,
            postgresql_where=text("decision = 'chosen'"),
        ),
    )
