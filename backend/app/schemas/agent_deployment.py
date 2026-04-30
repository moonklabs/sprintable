from __future__ import annotations

import uuid
from datetime import datetime
from typing import Any

from pydantic import BaseModel, ConfigDict


class AgentDeploymentResponse(BaseModel):
    model_config = ConfigDict(from_attributes=True)

    id: uuid.UUID
    org_id: uuid.UUID
    project_id: uuid.UUID
    agent_id: uuid.UUID
    persona_id: uuid.UUID | None
    name: str
    runtime: str
    model: str | None
    version: str | None
    status: str
    config: dict[str, Any]
    last_deployed_at: datetime | None
    failure_code: str | None
    failure_message: str | None
    failure_detail: dict[str, Any] | None
    failed_at: datetime | None
    created_at: datetime
    updated_at: datetime


class DeploymentFailureInput(BaseModel):
    code: str
    message: str
    detail: dict[str, Any] | None = None


class CreateDeploymentRequest(BaseModel):
    agent_id: uuid.UUID
    name: str
    runtime: str | None = None
    model: str | None = None
    version: str | None = None
    persona_id: uuid.UUID | None = None
    config: dict[str, Any] | None = None
    overwrite_routing_rules: bool | None = None


class PatchDeploymentRequest(BaseModel):
    status: str
    failure: DeploymentFailureInput | None = None


class DeploymentMutationResponse(BaseModel):
    deployment: AgentDeploymentResponse
    queue_held_count: int
    queue_resumed_count: int
    queue_failed_count: int


class DeploymentPreflightResponse(BaseModel):
    ok: bool
    checked_at: str
    blocking_reasons: list[str]
    warnings: list[str]
    routing_template_id: str
    routing_rule_count: int
    existing_routing_rule_count: int
    requires_routing_overwrite_confirmation: bool
    mcp_validation_errors: list[str]


class DeploymentPreflightWrapperResponse(BaseModel):
    preflight: DeploymentPreflightResponse


class DeploymentVerificationResponse(BaseModel):
    deployment: AgentDeploymentResponse


class DeploymentFailureSignal(BaseModel):
    run_id: str
    memo_id: str | None
    failed_at: str
    error_message: str | None
    last_error_code: str | None
    result_summary: str | None
    failure_disposition: str | None
    next_retry_at: str | None
    can_manual_retry: bool


class DeploymentCardResponse(BaseModel):
    id: str
    name: str
    status: str
    model: str | None
    runtime: str
    agent_name: str
    persona_name: str | None
    updated_at: str
    last_run_at: str | None
    latest_successful_run_at: str | None
    executions_today: int
    tokens_today: int
    pending_hitl_count: int
    next_hitl_deadline_at: str | None
    latest_failed_run: DeploymentFailureSignal | None
