from __future__ import annotations

import uuid
from datetime import datetime
from typing import Any, Literal

from pydantic import BaseModel, ConfigDict


class HitlHighRiskActionItem(BaseModel):
    key: str
    severity: str
    default_request_type: str
    default_timeout_class: str
    prompt_label: str


class HitlApprovalRule(BaseModel):
    key: str
    request_type: str
    timeout_class: str
    approval_required: bool = True


class HitlTimeoutClass(BaseModel):
    key: str
    duration_minutes: int
    reminder_minutes_before: int
    escalation_mode: str


class HitlPolicySnapshot(BaseModel):
    schema_version: Literal[1] = 1
    high_risk_actions: list[HitlHighRiskActionItem]
    approval_rules: list[HitlApprovalRule]
    timeout_classes: list[HitlTimeoutClass]
    prompt_summary: str


class PatchHitlPolicyRequest(BaseModel):
    approval_rules: list[HitlApprovalRule]
    timeout_classes: list[HitlTimeoutClass]


class HitlRequestResponse(BaseModel):
    model_config = ConfigDict(from_attributes=True)

    id: uuid.UUID
    org_id: uuid.UUID
    project_id: uuid.UUID
    agent_id: uuid.UUID
    deployment_id: uuid.UUID | None = None
    session_id: uuid.UUID | None = None
    run_id: uuid.UUID | None = None
    request_type: str
    title: str
    prompt: str
    requested_for: uuid.UUID
    status: str
    response_text: str | None = None
    responded_by: uuid.UUID | None = None
    responded_at: datetime | None = None
    expires_at: datetime | None = None
    hitl_metadata: dict[str, Any]
    created_at: datetime
    updated_at: datetime
    # enriched
    agent_name: str | None = None
    requested_for_name: str | None = None
    source_memo_id: str | None = None
    hitl_memo_id: str | None = None


class ResolveHitlRequestBody(BaseModel):
    status: Literal["approved", "rejected"]
    response_text: str | None = None
