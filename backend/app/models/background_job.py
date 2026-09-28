"""story #4336 PR2(PO 04:32Z) — 요청 한도(BFF 55s)를 넘을 수 있는 일을 요청에서 떼어 cron 워커가 이어서 하는 공용 작업 줄.

PO 규칙 (b) «응답 뒤 일 0 · 실행자는 cron 워커뿐» — 요청은 싼 검사만 하고 이 행을 넣은 뒤 곧바로 답한다(202 · 작업 id). 실제 일은
`publication-commands` 틱(1분)에 얹힌 `process_due_background_jobs`가 한다(새 Cloud Scheduler 잡 0 · #3527 선례). 화면은 작업 id로
상태를 다시 묻는다(`GET /organizations/{org}/background-jobs/{id}`).

- `kind`: 일의 종류(처리기 표 `services/background_jobs.py::HANDLERS`의 키). 새 종류는 이 체크와 마이그를 같이 늘린다.
- `payload`: 처리기가 다시 일을 하는 데 필요한 값만(요청 원문 X).
- `result`: 끝났을 때 화면이 다시 읽을 참조(예: 새 버전 id) — 만료되는 값(서명 URL 등)은 싣지 않고 읽을 때 새로 만든다.
- `error`: 실패했을 때 요청이 그대로 받았을 오류 본문(`{status_code, detail}`) — 화면이 같은 문장을 고른다.
- `publication_commands`와 달리 제공자 쪽 부작용(밖으로 나간 발행)이 없는 일만 담는다 — 재시도는 일시 실패에만.
"""
from __future__ import annotations

import uuid
from datetime import datetime

from sqlalchemy import CheckConstraint, DateTime, Index, Integer, Text, func, text
from sqlalchemy.dialects.postgresql import JSONB, UUID
from sqlalchemy.orm import Mapped, mapped_column

from app.core.database import Base

BACKGROUND_JOB_KINDS = ("channel_video_confirm", "attachment_convert", "loop_context_pack", "retro_synthesis")
BACKGROUND_JOB_STATUSES = ("pending", "in_progress", "completed", "failed")


# 열린(대기 · 실행 중) 작업만 겹침을 막는다 — 끝난 작업 뒤에는 같은 대상으로 새 작업을 만들 수 있다.
OPEN_DEDUP_WHERE = "status IN ('pending', 'in_progress') AND dedup_key IS NOT NULL"


class BackgroundJob(Base):
    __tablename__ = "background_jobs"

    id: Mapped[uuid.UUID] = mapped_column(UUID(as_uuid=True), primary_key=True, default=uuid.uuid4)
    org_id: Mapped[uuid.UUID] = mapped_column(UUID(as_uuid=True), nullable=False, index=True)
    kind: Mapped[str] = mapped_column(Text, nullable=False)
    payload: Mapped[dict] = mapped_column(JSONB, nullable=False, default=dict)
    status: Mapped[str] = mapped_column(Text, nullable=False, default="pending", server_default="pending")
    result: Mapped[dict | None] = mapped_column(JSONB, nullable=True)
    error: Mapped[dict | None] = mapped_column(JSONB, nullable=True)
    attempt_count: Mapped[int] = mapped_column(Integer, nullable=False, default=0, server_default="0")
    next_attempt_at: Mapped[datetime | None] = mapped_column(DateTime(timezone=True), nullable=True)
    requested_by_member_id: Mapped[uuid.UUID] = mapped_column(UUID(as_uuid=True), nullable=False)
    created_at: Mapped[datetime] = mapped_column(DateTime(timezone=True), server_default=func.now(), nullable=False)
    claimed_at: Mapped[datetime | None] = mapped_column(DateTime(timezone=True), nullable=True)
    finished_at: Mapped[datetime | None] = mapped_column(DateTime(timezone=True), nullable=True)
    # story #4336 PR2 ②(PO 10:39Z) — 같은 사람 · 같은 종류 · 같은 대상의 대기 · 실행 중 작업은 하나(다시 부르면 그 작업을 돌려줌). 0417.
    dedup_key: Mapped[str | None] = mapped_column(Text, nullable=True)

    __table_args__ = (
        # story #4336 PR2 ②(마이그 0417) — 첨부 변환 · 컨텍스트팩(캐시 미스) · 회고 종합/추천.
        CheckConstraint(
            "kind IN ('channel_video_confirm', 'attachment_convert', 'loop_context_pack', 'retro_synthesis')",
            name="ck_background_jobs_kind",
        ),
        CheckConstraint("status IN ('pending', 'in_progress', 'completed', 'failed')", name="ck_background_jobs_status"),
        Index("ix_background_jobs_due", "created_at", postgresql_where=text("status IN ('pending', 'in_progress')")),
        Index(
            "uq_background_jobs_open_dedup", "org_id", "kind", "requested_by_member_id", "dedup_key", unique=True,
            postgresql_where=text(OPEN_DEDUP_WHERE),
        ),
    )
