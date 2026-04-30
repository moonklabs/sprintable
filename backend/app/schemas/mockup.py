from __future__ import annotations

import uuid
from datetime import datetime
from typing import Any

from pydantic import BaseModel, ConfigDict


class MockupPageSummary(BaseModel):
    model_config = ConfigDict(from_attributes=True)
    id: uuid.UUID
    slug: str
    title: str
    category: str | None = None
    viewport: str | None = None
    version: int
    created_at: datetime


class MockupComponentOut(BaseModel):
    model_config = ConfigDict(from_attributes=True)
    id: uuid.UUID
    page_id: uuid.UUID
    type: str
    props: dict[str, Any]
    sort_order: int
    parent_id: uuid.UUID | None = None


class MockupScenarioOut(BaseModel):
    model_config = ConfigDict(from_attributes=True)
    id: uuid.UUID
    page_id: uuid.UUID
    name: str
    override_props: dict[str, Any]
    is_default: bool
    sort_order: int


class MockupPageDetail(BaseModel):
    id: uuid.UUID
    org_id: uuid.UUID
    project_id: uuid.UUID
    slug: str
    title: str
    category: str | None = None
    viewport: str | None = None
    version: int
    created_by: uuid.UUID | None = None
    created_at: datetime
    updated_at: datetime
    components: list[MockupComponentOut]
    scenarios: list[dict[str, Any]]


class CreateMockupRequest(BaseModel):
    slug: str
    title: str
    category: str | None = None
    viewport: str | None = None


class UpdateMockupRequest(BaseModel):
    title: str | None = None
    category: str | None = None
    viewport: str | None = None
    components: list[dict[str, Any]] | None = None


class MockupVersionOut(BaseModel):
    model_config = ConfigDict(from_attributes=True)
    id: uuid.UUID
    version: int
    created_at: datetime


class RestoreVersionRequest(BaseModel):
    version_id: uuid.UUID


class CreateScenarioRequest(BaseModel):
    name: str = "New Scenario"
    override_props: dict[str, Any] = {}


class UpdateScenarioRequest(BaseModel):
    scenario_id: uuid.UUID
    name: str | None = None
    override_props: dict[str, Any] | None = None
    sort_order: int | None = None


class DeleteScenarioRequest(BaseModel):
    scenario_id: uuid.UUID


class UsageMeterOut(BaseModel):
    model_config = ConfigDict(from_attributes=True)
    meter_type: str
    current_value: int
    limit_value: int | None = None
    period_start: datetime
    period_end: datetime | None = None
