from __future__ import annotations

import uuid
from datetime import datetime
from typing import Any

from pydantic import BaseModel, ConfigDict


class CreateAgentRun(BaseModel):
    agent_id: uuid.UUID
    trigger: str = "manual"
    model: str | None = None
    story_id: uuid.UUID | None = None
    memo_id: uuid.UUID | None = None
    status: str = "running"
    result_summary: str | None = None
    input_tokens: int | None = None
    output_tokens: int | None = None
    cost_usd: float | None = None
    duration_ms: int | None = None


class UpdateAgentRun(BaseModel):
    status: str
    result_summary: str | None = None
    input_tokens: int | None = None
    output_tokens: int | None = None
    cost_usd: float | None = None
    duration_ms: int | None = None
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
