"""story #3722 — 에이전트 인증 API 요청 1건 = 이 테이블 1행. `unhandled_error_events`
(0355)와 동형 관례: 비밀값(헤더·raw 쿼리스트링·body 원문)은 저장하지 않는다 —
`input_summary`는 이미 마스킹·절단된 요약만(app/services/tool_call_masking.py).

`run_id`만 예외로 FK(ON DELETE CASCADE) — 그 외 org_id/agent_id는 FK 없음(조회용 요약
테이블, 강제 조인 이유 0 — 인증 직후 삭제 경합 등으로 참조 대상이 이미 사라졌어도 이
기록 자체는 「그 요청이 있었다」는 사실을 안 잃는다)."""
from __future__ import annotations

import uuid
from datetime import datetime
from typing import Any

from sqlalchemy import DateTime, ForeignKey, Integer, Text, func
from sqlalchemy.dialects.postgresql import JSONB, UUID
from sqlalchemy.orm import Mapped, mapped_column

from app.core.database import Base


class AgentRunToolCall(Base):
    __tablename__ = "agent_run_tool_calls"

    id: Mapped[uuid.UUID] = mapped_column(UUID(as_uuid=True), primary_key=True, default=uuid.uuid4)
    org_id: Mapped[uuid.UUID] = mapped_column(UUID(as_uuid=True), nullable=False)
    agent_id: Mapped[uuid.UUID] = mapped_column(UUID(as_uuid=True), nullable=False)
    run_id: Mapped[uuid.UUID | None] = mapped_column(
        UUID(as_uuid=True), ForeignKey("agent_runs.id", ondelete="CASCADE"), nullable=True,
    )
    # PR2(MCP 이름표, X-Sprintable-Tool)가 채우기 전까지는 항상 null — REST 직접 호출은
    # 이름표가 없어도 method/path만으로 기록이 선다(그 자체가 이 스토리의 요구사항).
    tool: Mapped[str | None] = mapped_column(Text, nullable=True)
    method: Mapped[str] = mapped_column(Text, nullable=False)
    # 쿼리스트링 제외(unhandled_error_events 관례 그대로 — 토큰/코드류가 쿼리에 실릴 수
    # 있다) — 라우트 템플릿이 있으면 그것(예 "/api/v2/stories/{id}"), 없으면 raw path.
    path: Mapped[str] = mapped_column(Text, nullable=False)
    status_code: Mapped[int] = mapped_column(Integer, nullable=False)
    duration_ms: Mapped[int] = mapped_column(Integer, nullable=False)
    started_at: Mapped[datetime] = mapped_column(DateTime(timezone=True), nullable=False)
    input_summary: Mapped[dict[str, Any] | None] = mapped_column(JSONB, nullable=True)
    error: Mapped[str | None] = mapped_column(Text, nullable=True)
    # 열거형 문자열(tool_call_attribution.py의 AttributionReason과 동형) — 귀속 성공
    # 케이스도 값을 남겨(header/story_scope/single_running) 분포를 셀 수 있게 한다(페드루
    # PO 지시 — ⓐ/ⓑ'/ⓑ/ⓒ 각 1건 라이브 재현이 AC).
    attribution_reason: Mapped[str] = mapped_column(Text, nullable=False)
    created_at: Mapped[datetime] = mapped_column(
        DateTime(timezone=True), server_default=func.now(), nullable=False,
    )
