from __future__ import annotations

import uuid
from datetime import datetime
from typing import Any

from pydantic import BaseModel, ConfigDict


class AgentRunToolCallResponse(BaseModel):
    model_config = ConfigDict(from_attributes=True)

    id: uuid.UUID
    org_id: uuid.UUID
    agent_id: uuid.UUID
    run_id: uuid.UUID | None
    tool: str | None
    method: str
    path: str
    status_code: int
    duration_ms: int
    started_at: datetime
    input_summary: dict[str, Any] | None
    error: str | None
    attribution_reason: str
    created_at: datetime
