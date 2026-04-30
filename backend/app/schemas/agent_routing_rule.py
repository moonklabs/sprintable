from __future__ import annotations

import uuid
from datetime import datetime
from typing import Any

from pydantic import BaseModel, ConfigDict


class RoutingRuleResponse(BaseModel):
    model_config = ConfigDict(from_attributes=True)

    id: uuid.UUID
    org_id: uuid.UUID
    project_id: uuid.UUID
    agent_id: uuid.UUID
    persona_id: uuid.UUID | None
    deployment_id: uuid.UUID | None
    name: str
    priority: int
    match_type: str
    conditions: dict[str, Any]
    action: dict[str, Any]
    target_runtime: str
    target_model: str | None
    is_enabled: bool
    metadata: dict[str, Any]
    created_by: uuid.UUID | None
    created_at: datetime
    updated_at: datetime


class CreateRoutingRuleRequest(BaseModel):
    agent_id: uuid.UUID
    persona_id: uuid.UUID | None = None
    deployment_id: uuid.UUID | None = None
    name: str
    priority: int | None = None
    match_type: str | None = None
    conditions: dict[str, Any] | None = None
    action: dict[str, Any] | None = None
    target_runtime: str | None = None
    target_model: str | None = None
    is_enabled: bool | None = None


class UpdateRoutingRuleRequest(BaseModel):
    id: uuid.UUID
    agent_id: uuid.UUID | None = None
    persona_id: uuid.UUID | None = None
    deployment_id: uuid.UUID | None = None
    name: str | None = None
    priority: int | None = None
    match_type: str | None = None
    conditions: dict[str, Any] | None = None
    action: dict[str, Any] | None = None
    target_runtime: str | None = None
    target_model: str | None = None
    is_enabled: bool | None = None
    metadata: dict[str, Any] | None = None


class ReplaceRuleItem(BaseModel):
    id: uuid.UUID | None = None
    agent_id: uuid.UUID
    persona_id: uuid.UUID | None = None
    deployment_id: uuid.UUID | None = None
    name: str
    priority: int | None = None
    match_type: str | None = None
    conditions: dict[str, Any] | None = None
    action: dict[str, Any] | None = None
    target_runtime: str | None = None
    target_model: str | None = None
    is_enabled: bool | None = None
    metadata: dict[str, Any] | None = None


class ReplaceRulesRequest(BaseModel):
    items: list[ReplaceRuleItem]


class ReorderItem(BaseModel):
    id: uuid.UUID
    priority: int


class ReorderRulesRequest(BaseModel):
    items: list[ReorderItem]


class DisableAllRequest(BaseModel):
    disable_all: bool
