import uuid
from datetime import datetime

from sqlalchemy import Computed, DateTime, ForeignKey, Integer, Numeric, Text, func
from sqlalchemy.dialects.postgresql import JSONB, UUID
from sqlalchemy.orm import Mapped, mapped_column

from app.core.database import Base


class AgentRun(Base):
    __tablename__ = "agent_runs"

    id: Mapped[uuid.UUID] = mapped_column(UUID(as_uuid=True), primary_key=True, default=uuid.uuid4)
    org_id: Mapped[uuid.UUID] = mapped_column(
        UUID(as_uuid=True), ForeignKey("organizations.id", ondelete="CASCADE"), nullable=False, index=True
    )
    # 2a5f21d3: DB(baseline schema.sql)는 project_id NOT NULL인데 모델이 nullable=True로 드리프트
    # → create_agent_run이 project_id 미공급 시 NotNullViolation. DB(원설계 SSOT)에 정합.
    # agent_run은 project 안에서 일어나는 개념이라 도메인상 필수(마이그 불요·DB 이미 NOT NULL).
    project_id: Mapped[uuid.UUID] = mapped_column(
        UUID(as_uuid=True), ForeignKey("projects.id", ondelete="CASCADE"), nullable=False, index=True
    )
    agent_id: Mapped[uuid.UUID] = mapped_column(
        UUID(as_uuid=True), nullable=False, index=True
    )
    deployment_id: Mapped[uuid.UUID | None] = mapped_column(
        UUID(as_uuid=True), nullable=True, index=True
    )
    story_id: Mapped[uuid.UUID | None] = mapped_column(
        UUID(as_uuid=True), ForeignKey("stories.id", ondelete="SET NULL"), nullable=True
    )
    memo_id: Mapped[uuid.UUID | None] = mapped_column(
        UUID(as_uuid=True), nullable=True
    )
    trigger: Mapped[str] = mapped_column(Text, nullable=False, default="manual")
    model: Mapped[str | None] = mapped_column(Text, nullable=True)
    input_tokens: Mapped[int | None] = mapped_column(Integer, nullable=True)
    output_tokens: Mapped[int | None] = mapped_column(Integer, nullable=True)
    cost_usd: Mapped[float | None] = mapped_column(Numeric(10, 6), nullable=True)
    status: Mapped[str] = mapped_column(Text, nullable=False, default="running")
    result_summary: Mapped[str | None] = mapped_column(Text, nullable=True)
    error_message: Mapped[str | None] = mapped_column(Text, nullable=True)
    # 2a5f21d3: DB에선 GENERATED ALWAYS STORED(baseline schema.sql·started/finished_at 또는
    # duration_ms_legacy 폴백에서 파생)인데 모델이 plain writable Integer로 매핑해 SQLAlchemy가
    # INSERT/UPDATE에 이 컬럼을 항상 emit → GeneratedAlwaysError로 agent_runs 생성 전건 실패했다.
    # Computed(persisted=True)로 read-only 선언 → DML서 제외(모델↔DB 드리프트 해소·create_all
    # DDL도 prod와 동형 generated 컬럼 생성). 표현식은 baseline schema.sql과 byte-정합.
    duration_ms: Mapped[int | None] = mapped_column(
        Integer,
        Computed(
            "CASE "
            "WHEN ((finished_at IS NOT NULL) AND (started_at IS NOT NULL)) "
            "THEN GREATEST(((EXTRACT(epoch FROM (finished_at - started_at)) * (1000)::numeric))::integer, 0) "
            "WHEN (duration_ms_legacy IS NOT NULL) THEN duration_ms_legacy "
            "ELSE NULL::integer "
            "END",
            persisted=True,
        ),
        nullable=True,
    )
    last_error_code: Mapped[str | None] = mapped_column(Text, nullable=True)
    failure_disposition: Mapped[str | None] = mapped_column(Text, nullable=True)
    retry_count: Mapped[int] = mapped_column(Integer, nullable=False, default=0)
    max_retries: Mapped[int] = mapped_column(Integer, nullable=False, default=3)
    next_retry_at: Mapped[datetime | None] = mapped_column(DateTime(timezone=True), nullable=True)
    llm_call_count: Mapped[int] = mapped_column(Integer, nullable=False, default=0)
    run_metadata: Mapped[dict] = mapped_column("metadata", JSONB, nullable=False, default=dict)
    started_at: Mapped[datetime] = mapped_column(
        DateTime(timezone=True), server_default=func.now(), nullable=False
    )
    finished_at: Mapped[datetime | None] = mapped_column(DateTime(timezone=True), nullable=True)
    created_at: Mapped[datetime] = mapped_column(
        DateTime(timezone=True), server_default=func.now(), nullable=False
    )
