from __future__ import annotations

import uuid
from datetime import datetime
from typing import Any

from pydantic import BaseModel, ConfigDict, field_validator


class ArtifactNodeIn(BaseModel):
    id: uuid.UUID | None = None
    type: str
    props: dict[str, Any] = {}
    parent_id: uuid.UUID | None = None
    sort_order: int = 0
    # E-CANVAS C2-S6: description pane(요소별 스펙 서술). 선택제(미지정=None).
    description: str | None = None


class ArtifactNodeOut(BaseModel):
    model_config = ConfigDict(from_attributes=True)
    id: uuid.UUID
    type: str
    props: dict[str, Any]
    parent_id: uuid.UUID | None = None
    sort_order: int
    description: str | None = None


class CreateArtifactRequest(BaseModel):
    title: str
    story_id: uuid.UUID | None = None
    epic_id: uuid.UUID | None = None
    doc_id: uuid.UUID | None = None
    source: str = "created"
    nodes: list[ArtifactNodeIn] = []
    # 유나 §11 갭②: 최초 버전의 변경 이유(보통 "초기 생성"류·선택제).
    summary: str | None = None

    @field_validator("source")
    @classmethod
    def _validate_source(cls, v: str) -> str:
        if v not in ("created", "imported"):
            raise ValueError("source must be 'created' or 'imported'")
        return v


class ArtifactVersionSummary(BaseModel):
    model_config = ConfigDict(from_attributes=True)
    id: uuid.UUID
    version_number: int
    summary: str | None = None
    created_by: uuid.UUID | None = None
    created_at: datetime


class VisualArtifactSummary(BaseModel):
    model_config = ConfigDict(from_attributes=True)
    id: uuid.UUID
    title: str
    story_id: uuid.UUID | None = None
    epic_id: uuid.UUID | None = None
    doc_id: uuid.UUID | None = None
    source: str
    latest_version_number: int
    anchor_version: int | None = None
    created_by: uuid.UUID | None = None
    created_at: datetime


class VisualArtifactDetail(BaseModel):
    id: uuid.UUID
    org_id: uuid.UUID
    project_id: uuid.UUID
    title: str
    story_id: uuid.UUID | None = None
    epic_id: uuid.UUID | None = None
    doc_id: uuid.UUID | None = None
    source: str
    latest_version_number: int
    anchor_version: int | None = None
    created_by: uuid.UUID | None = None
    created_at: datetime
    updated_at: datetime
    version_number: int
    version_summary: str | None = None
    nodes: list[ArtifactNodeOut]


class CreateArtifactCommentRequest(BaseModel):
    content: str
    node_id: uuid.UUID | None = None
    anchor_x: float | None = None
    anchor_y: float | None = None
    parent_id: uuid.UUID | None = None
    mentioned_ids: list[uuid.UUID] = []

    @field_validator("content")
    @classmethod
    def _content_non_empty(cls, v: str) -> str:
        v = v.strip()
        if not v:
            raise ValueError("content must not be empty")
        return v


class ArtifactCommentResponse(BaseModel):
    model_config = ConfigDict(from_attributes=True)
    id: uuid.UUID
    artifact_id: uuid.UUID
    node_id: uuid.UUID | None = None
    anchor_x: float | None = None
    anchor_y: float | None = None
    content: str
    parent_id: uuid.UUID | None = None
    resolved: bool
    resolved_by: uuid.UUID | None = None
    resolved_at: datetime | None = None
    created_by: uuid.UUID
    created_at: datetime
