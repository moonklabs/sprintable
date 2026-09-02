"""story #3337(선생님 4바퀴 실사고, 페드루 PO 설계 확定 2026-09-02) — 사이클형 레시피 정의의
반복 스케줄(payload.repeat=ISO8601 duration, 예: P7D). 예전엔 "다음 회차는 담당 에이전트의
스케줄로 반복"이라 반복 자체가 제품 능력이 아니라 에이전트의 자율 행동에 기대고 있었다(최저
지능·꺼진 에이전트는 다음 회차를 절대 안 낸다).

행 존재 자체 = "이 (org, project, definition_key) 조합에 활성 반복 스케줄이 있다"는 사실 —
유니크 키(정의 key+project 단위 1행, 페드루 확定)로 강제. 생성/갱신 시점은
`recipe_repeat_schedule.py::maybe_upsert_repeat_schedule`이 문서화한다(첫 stage(collect) 발행이
`repeat`를 실었을 때 upsert, 이후 매 stage 발행마다 last_payload_snapshot 갱신).
"""
from __future__ import annotations

import uuid
from datetime import datetime

from sqlalchemy import DateTime, Integer, Text, UniqueConstraint, func, text
from sqlalchemy.dialects.postgresql import JSONB, UUID
from sqlalchemy.orm import Mapped, mapped_column

from app.core.database import Base

# 정지 조건 3종(연속실패·정의 비활성/삭제·project/org 아카이브) 중 하나라도 걸리면 paused —
# 재개는 수동(FE 별도 라운드, 페드루 확定). active만 tick 대상.
RECIPE_REPEAT_SCHEDULE_STATUSES = frozenset({"active", "paused"})


class RecipeRepeatSchedule(Base):
    __tablename__ = "recipe_repeat_schedules"
    __table_args__ = (
        UniqueConstraint("org_id", "project_id", "definition_key", name="uq_recipe_repeat_schedule_definition"),
    )

    id: Mapped[uuid.UUID] = mapped_column(UUID(as_uuid=True), primary_key=True, default=uuid.uuid4)
    org_id: Mapped[uuid.UUID] = mapped_column(UUID(as_uuid=True), nullable=False, index=True)
    project_id: Mapped[uuid.UUID] = mapped_column(UUID(as_uuid=True), nullable=False, index=True)
    definition_key: Mapped[str] = mapped_column(Text, nullable=False)
    work_item_type: Mapped[str] = mapped_column(Text, nullable=False)
    # 최초 생성 시각(고정 — anchor 자체는 재계산 대상 아님, next_run_at만 매 회차 전진).
    anchor_time: Mapped[datetime] = mapped_column(DateTime(timezone=True), nullable=False)
    # tick 배치 쿼리의 대상 판정 컬럼 — 이 컬럼에만 index를 건다(SKIP LOCKED 배치가 매번
    # 훑는 유일한 축).
    next_run_at: Mapped[datetime] = mapped_column(DateTime(timezone=True), nullable=False, index=True)
    repeat: Mapped[str] = mapped_column(Text, nullable=False)
    # 다음 회차 collect 이벤트 payload를 그대로 재구성할 수 있는 최소 스냅샷(channel·
    # source_doc_id·previous_output_doc_id 등) — tick 시점에 직접 조회하지 않고 이 값을
    # 그대로 싣는다(페드루 확定 — "스케줄러는 직접 조회 불요").
    last_payload_snapshot: Mapped[dict] = mapped_column(JSONB, nullable=False, default=dict)
    consecutive_failure_count: Mapped[int] = mapped_column(Integer, nullable=False, server_default=text("0"))
    status: Mapped[str] = mapped_column(Text, nullable=False, server_default=text("'active'"))
    last_run_at: Mapped[datetime | None] = mapped_column(DateTime(timezone=True), nullable=True)
    # 직전 회차에 생성된 Story — 다음 회차 Story의 assignee 승계 출처(story #3340 도달 원칙과
    # 정합: 새 Story도 미배정으로 태어나지 않는다).
    last_story_id: Mapped[uuid.UUID | None] = mapped_column(UUID(as_uuid=True), nullable=True)
    created_at: Mapped[datetime] = mapped_column(DateTime(timezone=True), server_default=func.now(), nullable=False)
    updated_at: Mapped[datetime] = mapped_column(
        DateTime(timezone=True), server_default=func.now(), onupdate=func.now(), nullable=False,
    )
