from __future__ import annotations

import uuid
from datetime import datetime
from typing import Any

from pydantic import BaseModel, ConfigDict


class PersonaBaseResponse(BaseModel):
    model_config = ConfigDict(from_attributes=True)

    id: uuid.UUID
    org_id: uuid.UUID
    project_id: uuid.UUID
    agent_id: uuid.UUID
    name: str
    slug: str
    description: str | None
    system_prompt: str
    style_prompt: str | None
    model: str | None
    config: dict[str, Any]
    is_builtin: bool
    is_default: bool
    created_by: uuid.UUID | None
    created_at: datetime
    updated_at: datetime


class PersonaSummaryResponse(PersonaBaseResponse):
    resolved_system_prompt: str
    resolved_style_prompt: str | None
    tool_allowlist: list[str]
    base_persona_id: str | None
    base_persona: dict[str, Any] | None
    is_in_use: bool
    version_metadata: dict[str, Any]
    permission_boundary: dict[str, Any]
    change_history: list[dict[str, Any]]


class CreatePersonaRequest(BaseModel):
    agent_id: uuid.UUID
    name: str
    slug: str | None = None
    description: str | None = None
    system_prompt: str | None = None
    style_prompt: str | None = None
    model: str | None = None
    base_persona_id: uuid.UUID | None = None
    tool_allowlist: list[str] | None = None
    is_default: bool | None = None


class UpdatePersonaRequest(BaseModel):
    name: str | None = None
    slug: str | None = None
    description: str | None = None
    system_prompt: str | None = None
    style_prompt: str | None = None
    model: str | None = None
    base_persona_id: uuid.UUID | None = None
    tool_allowlist: list[str] | None = None
    is_default: bool | None = None
