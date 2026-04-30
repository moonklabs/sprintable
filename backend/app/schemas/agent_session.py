from __future__ import annotations

import uuid
from datetime import datetime
from typing import Any

from pydantic import BaseModel, ConfigDict


class AgentSessionResponse(BaseModel):
    model_config = ConfigDict(from_attributes=True)

    id: uuid.UUID
    org_id: uuid.UUID
    project_id: uuid.UUID
    agent_id: uuid.UUID
    persona_id: uuid.UUID | None
    deployment_id: uuid.UUID | None
    session_key: str
    channel: str
    title: str | None
    status: str
    context_window_tokens: int | None
    session_metadata: dict[str, Any]
    context_snapshot: dict[str, Any]
    created_by: uuid.UUID | None
    started_at: datetime
    last_activity_at: datetime
    idle_at: datetime | None
    suspended_at: datetime | None
    ended_at: datetime | None
    terminated_at: datetime | None
    created_at: datetime
    updated_at: datetime


class TransitionSessionRequest(BaseModel):
    status: str
    reason: str | None = None


class SessionResumeCandidate(BaseModel):
    run_id: str
    memo_id: str
    org_id: str
    project_id: str
    agent_id: str


class TransitionSessionResponse(BaseModel):
    session: AgentSessionResponse
    resumptions: list[SessionResumeCandidate]
