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
    # E-CANVAS C3-S7: 이 버전이 응답한 코멘트(closed-loop, 선택제).
    source_comment_id: uuid.UUID | None = None


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
    # E-CANVAS C3-S7: 이 버전이 응답한 코멘트(closed-loop, 선택제).
    version_source_comment_id: uuid.UUID | None = None
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


class ExportUploadUrlRequest(BaseModel):
    content_type: str = "image/png"


class ExportUploadUrlResponse(BaseModel):
    upload_url: str
    object_path: str
    expires_at: datetime


class CompleteExportRequest(BaseModel):
    object_path: str


class ArtifactExportResponse(BaseModel):
    id: uuid.UUID
    artifact_id: uuid.UUID
    version_id: uuid.UUID
    version_number: int
    format: str
    created_by: uuid.UUID | None = None
    created_at: datetime
    # 유나 UX 결정③(공유 링크 1급): asset_id는 안정적 공유 참조 — FE가
    # GET /api/v2/attachments/authorize?asset_id=... (기존 인프라 재사용)로 인가된 caller에게
    # 언제든 재서명 다운로드 URL을 새로 받을 수 있다. download_url은 즉시 사용 편의용 단기 서명.
    asset_id: uuid.UUID
    download_url: str | None = None


class ArtifactNodeOperation(BaseModel):
    """E-CANVAS C3-S7(story 940266db): 딸깍 편집(휴먼)·MCP 편집(에이전트) 공용 연산 — 동일
    서비스 경로를 경유해 "같은 객체를 양쪽이 편집"을 보장한다."""
    op: str  # "add" | "update" | "delete"
    id: uuid.UUID | None = None  # add: 선택(미지정 시 서버 생성) / update·delete: 필수(대상 node id)
    type: str | None = None  # add 필수
    props: dict[str, Any] | None = None  # add: 초기값(미지정 {}) / update: 지정 시 전체 교체
    parent_id: uuid.UUID | None = None
    sort_order: int | None = None
    description: str | None = None

    @field_validator("op")
    @classmethod
    def _validate_op(cls, v: str) -> str:
        if v not in ("add", "update", "delete"):
            raise ValueError("op must be 'add', 'update', or 'delete'")
        return v


class EditArtifactRequest(BaseModel):
    operations: list[ArtifactNodeOperation]
    # 새 버전의 변경 이유(선택) — ArtifactVersion.summary와 동형(C1-S3 §11 갭②).
    summary: str | None = None
    # 이 편집 커밋이 어느 코멘트에 응답했는지(선택, closed-loop). op-level 아닌 request-level
    # — 편집=코멘트 응답 단위. auto-resolve 안 함(링크≠해결, 해결은 별도 명시 액션).
    source_comment_id: uuid.UUID | None = None

    @field_validator("operations")
    @classmethod
    def _non_empty_operations(cls, v: list) -> list:
        if not v:
            raise ValueError("operations must not be empty")
        return v
