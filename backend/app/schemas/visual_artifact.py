from __future__ import annotations

import uuid
from datetime import datetime
from typing import Any

from pydantic import BaseModel, ConfigDict, Field, field_validator, model_validator

# 뷰어 통합 재설계(story 1948d19d): 비정상 거대값 방어 상한. Figma류 대형 캔버스 툴의 실용 한계보다
# 넉넉하되(20000px), 정수 오버플로/스토리지 남용성 값은 확실히 막는 값 — 특정 스펙 수치가 아니라
# 방어 목적의 보수적 라운드 넘버(유나 스펙 doc 발행 시 필요하면 조정).
_CANVAS_BOUND_MAX = 20000


class CanvasBounds(BaseModel):
    """artifact 자기 프레임 크기 선언(story 1948d19d) — sandbox iframe 내부 측정 불가라 필요."""
    w: int
    h: int

    @field_validator("w", "h")
    @classmethod
    def _positive_and_bounded(cls, v: int) -> int:
        if v <= 0:
            raise ValueError("must be a positive integer")
        if v > _CANVAS_BOUND_MAX:
            raise ValueError(f"must not exceed {_CANVAS_BOUND_MAX}")
        return v


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
    # story #1920: 빈 nodes로 생성된 산출물이 조용히 만들어져 온보딩/뷰어 혼란을 유발(8de4e981
    # 계열 사고 재발 방지 — 그 사고 자체의 사후처리는 #1922로 별도 완료, 이건 재발 방지책).
    # min_length=1 — loop.py::LoopDecisionRequest.decisions와 동일 컨벤션(Field(min_length=1)).
    # 빈 리스트는 FastAPI 기본 RequestValidationError → 422(이 스키마 파일의 기존 필드
    # validator들과 마찬가지로 라우터에서 별도 400 처리하지 않음 — 코드베이스 전역 컨벤션).
    nodes: list[ArtifactNodeIn] = Field(min_length=1)
    # 유나 §11 갭②: 최초 버전의 변경 이유(보통 "초기 생성"류·선택제).
    summary: str | None = None
    # 뷰어 통합 재설계(story 1948d19d): 생성 시점 프레임 크기 선언(선택 — 미선언=FE 기본 아트보드).
    canvas_bounds: CanvasBounds | None = None

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
    # 뷰어 통합 재설계(story 1948d19d·doc artifact-canvas-viewport-spec §4): 이 버전이 선언한
    # 프레임(SSOT — ArtifactVersion 실 컬럼, from_attributes로 그대로 픽업).
    canvas_bounds: CanvasBounds | None = None


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
    # denorm 캐시(latest_version_number와 동일 목적 — 버전 서브쿼리 회피). SSOT는
    # ArtifactVersion.canvas_bounds, 이 값은 항상 최신 버전 값과 동기화된다.
    canvas_bounds: CanvasBounds | None = None


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
    # 뷰어 통합 재설계(story 1948d19d·doc artifact-canvas-viewport-spec §4): **이 detail이 로드한
    # version_number 버전**이 선언한 프레임(과거 버전 조회 시 그 버전 당시 값 — artifact의 현재
    # denorm 캐시가 아님).
    canvas_bounds: CanvasBounds | None = None
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


_SPEC_PIN_ANCHOR_TYPES = ("coord", "node")


class CreateSpecPinRequest(BaseModel):
    """편집 캔버스 핀 저작(story 7fe16274) — anchor_type이 좌표/노드 중 무엇이든 description은
    non-null 강제(doc §3 — 빈 스펙 커밋 차단)."""
    anchor_type: str
    anchor_x: float | None = None
    anchor_y: float | None = None
    node_id: uuid.UUID | None = None
    description: str

    @field_validator("anchor_type")
    @classmethod
    def _validate_anchor_type(cls, v: str) -> str:
        if v not in _SPEC_PIN_ANCHOR_TYPES:
            raise ValueError("anchor_type must be 'coord' or 'node'")
        return v

    @field_validator("description")
    @classmethod
    def _description_non_empty(cls, v: str) -> str:
        v = v.strip()
        if not v:
            raise ValueError("description must not be empty")
        return v

    @model_validator(mode="after")
    def _validate_anchor_consistency(self) -> "CreateSpecPinRequest":
        # DB CHECK(ck_artifact_spec_pins_anchor_consistency)와 동형 — API 레벨에서 먼저 422로 거름.
        if self.anchor_type == "coord":
            if self.anchor_x is None or self.anchor_y is None:
                raise ValueError("coord anchor requires both anchor_x and anchor_y")
            if self.node_id is not None:
                raise ValueError("coord anchor must not set node_id")
            if self.anchor_x < 0 or self.anchor_y < 0:
                raise ValueError("anchor_x/anchor_y must be non-negative")
        else:  # node
            if self.node_id is None:
                raise ValueError("node anchor requires node_id")
            if self.anchor_x is not None or self.anchor_y is not None:
                raise ValueError("node anchor must not set anchor_x/anchor_y")
        return self


class UpdateSpecPinRequest(BaseModel):
    description: str

    @field_validator("description")
    @classmethod
    def _description_non_empty(cls, v: str) -> str:
        v = v.strip()
        if not v:
            raise ValueError("description must not be empty")
        return v


class SpecPinResponse(BaseModel):
    model_config = ConfigDict(from_attributes=True)
    id: uuid.UUID
    artifact_id: uuid.UUID
    version_id: uuid.UUID
    anchor_type: str
    anchor_x: float | None = None
    anchor_y: float | None = None
    node_id: uuid.UUID | None = None
    description: str
    # ⛔감시금지(doc §4): created_by/created_at 미노출 — 모델 자체에 attribution 컬럼이 없음
    # (ArtifactNode와 동형).


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
    operations: list[ArtifactNodeOperation] = []
    # 새 버전의 변경 이유(선택) — ArtifactVersion.summary와 동형(C1-S3 §11 갭②).
    summary: str | None = None
    # 이 편집 커밋이 어느 코멘트에 응답했는지(선택, closed-loop). op-level 아닌 request-level
    # — 편집=코멘트 응답 단위. auto-resolve 안 함(링크≠해결, 해결은 별도 명시 액션).
    source_comment_id: uuid.UUID | None = None
    # 뷰어 통합 재설계(story 1948d19d): 프레임 크기 재선언(선택) — 버전 단위 SSOT라 이것만
    # 바뀌어도 무-mutate 버전 원칙대로 새 버전이 생긴다(operations 없이 canvas_bounds만으로도
    # 호출 가능, 아래 model_validator 참조). 미지정 시 직전 버전 값을 그대로 이어받는다.
    canvas_bounds: CanvasBounds | None = None

    @model_validator(mode="after")
    def _require_at_least_one_change(self) -> "EditArtifactRequest":
        if not self.operations and self.canvas_bounds is None:
            raise ValueError("operations must not be empty (or provide canvas_bounds)")
        return self
