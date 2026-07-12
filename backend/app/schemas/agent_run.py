from __future__ import annotations

import uuid
from datetime import datetime
from typing import Any

from pydantic import BaseModel, ConfigDict


class CreateAgentRun(BaseModel):
    agent_id: uuid.UUID
    # project_id(2a5f21d3): agent_run 필수 개념(DB NOT NULL 정합). 라우터가 caller의
    # has_project_access를 resource-actual로 검증(body-claimed 금지·신규 mutation 인가 표면).
    project_id: uuid.UUID
    trigger: str = "manual"
    model: str | None = None
    story_id: uuid.UUID | None = None
    memo_id: uuid.UUID | None = None
    status: str = "running"
    result_summary: str | None = None
    input_tokens: int | None = None
    output_tokens: int | None = None
    cost_usd: float | None = None
    # duration_ms(2a5f21d3): DB GENERATED ALWAYS(started/finished_at 파생)라 클라 입력 불가 —
    # 명시 세팅 시 GeneratedAlwaysError. 입력 표면에서 제거(응답 AgentRunResponse엔 read-only 유지).


class UpdateAgentRun(BaseModel):
    status: str
    result_summary: str | None = None
    input_tokens: int | None = None
    output_tokens: int | None = None
    cost_usd: float | None = None
    # duration_ms: GENERATED ALWAYS라 입력 불가(2a5f21d3) — 제거.
    last_error_code: str | None = None


class AgentRunResponse(BaseModel):
    model_config = ConfigDict(from_attributes=True)

    id: uuid.UUID
    org_id: uuid.UUID
    agent_id: uuid.UUID
    story_id: uuid.UUID | None = None
    memo_id: uuid.UUID | None = None
    trigger: str
    model: str | None = None
    status: str
    result_summary: str | None = None
    input_tokens: int | None = None
    output_tokens: int | None = None
    cost_usd: float | None = None
    duration_ms: int | None = None
    last_error_code: str | None = None
    llm_call_count: int
    run_metadata: dict[str, Any]
    created_at: datetime
