from __future__ import annotations

import uuid
from datetime import datetime
from typing import Any

from pydantic import BaseModel, ConfigDict, Field, computed_field, field_validator, model_validator

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
    # story #2262 AC9②(PO 판정 2026-07-29): visual_artifact는 status 컬럼이 없다 — 「지금
    # 상태」대신 「미결」을 들고 오는 첫 실증. 이름이 세는 단위를 그대로 말한다(오르테가 확정):
    # ArtifactComment(root+reply 전부, 스레드는 제품에 없는 개념) WHERE resolved=false 개수.
    # 라우터가 model_validate 前 transient attr로 세팅(agent_delegate_ids 패턴 동형) — 항상
    # 세팅되므로(N+1 방지 배치 조회, 0도 명시) 여기 기본값(0)이 실제로 쓰일 일은 없다.
    unresolved_comment_count: int = 0
    # ⛔story #2262(C-4, PO 판정 2026-07-29): 여기 있던 `next_action_code`(artifact_next_action
    # 호출)를 뺐다 — `unresolved_comment_count`(바로 위)가 이미 원자 필드로 응답에 있어
    # 완전히 같은 사실을 두 칸에 중복으로 실었던 것(한 사실이 두 칸에 살면 언젠가 갈라진다).
    # 근거는 "응답에 있다"가 아니라 "FE가 이 원자 필드로 직접 판정할 수 있다"인 것 — 지금은
    # 아무도 안 읽지만(next_action_code 소비 0%) 읽을 재료는 이미 서 있다. 빼도 없어지는
    # 동작이 0인 이유가 바로 이것(FE 소비 0%였다는 사실 그대로).

    # story #2724(2026-08-17, 페드루 PO 판정) — 추가 필드(기존 소비자 무회귀, additive-only).
    # story_id·doc_id가 둘 다 비어있다는 **사실만** 싣는다(처방 문장·권고 아님 — "이걸 붙이세요"
    # 류는 여기 안 넣는다, MCP 도구 description 쪽 유도문과 역할 분리). story_id/doc_id는 이미
    # 응답에 있어 소비자가 스스로 계산할 수 있지만, 그 계산을 반복 재구현하는 대신 이 한 필드로
    # 명시(계산 로직 1곳 SSOT — epic_id는 이 판정에 안 들어간다, PO 문구 "story/doc 미연결" 그대로).
    @computed_field  # type: ignore[prop-decorator]
    @property
    def unlinked(self) -> bool:
        return self.story_id is None and self.doc_id is None


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
    # story #2262 AC9②: VisualArtifactSummary와 동형 — 여기 위 주석 참조. 이 클래스는
    # from_attributes를 안 쓰므로(라우터가 키워드 인자로 직접 생성) 기본값 0이 실제로
    # 쓰이지 않는다는 보장이 없다 — 호출부(_load_detail)가 항상 명시로 넘긴다.
    unresolved_comment_count: int = 0
    # ⛔story #2262(C-4, PO 판정 2026-07-29): VisualArtifactSummary와 동형 — 위 클래스의
    # next_action_code 제거 사유 그대로(unresolved_comment_count 원자 필드와 중복).

    # story #2642(웹·칩 공통, 2026-08-14) — org_id/project_id가 이미 이 행 자체에 있어(부모
    # story/epic/doc hop 불필요, artifact 생성 시점에 같은 org/project로 이미 보장됨,
    # _assert_link_target_in_scope) additive slug 2개만(#2168 DocPreviewResponse와 동형).
    # from_attributes 안 씀 — 호출부(_load_detail)가 항상 키워드 인자로 명시.
    org_slug: str | None = None
    project_slug: str | None = None

    # story #2724 — VisualArtifactSummary와 동형(위 주석 참조), 이 클래스에도 동일 사실 필드.
    @computed_field  # type: ignore[prop-decorator]
    @property
    def unlinked(self) -> bool:
        return self.story_id is None and self.doc_id is None


class CreateArtifactCommentRequest(BaseModel):
    content: str
    node_id: uuid.UUID | None = None
    # story #154a26be — 이 클래스(아티팩트 좌표 코멘트)의 좌표 앵커 규약은 %(0~100),
    # ratio(0~1)나 픽셀이 아니다(FE artifact-viewer.tsx가 `style={{ left: "${x}%" }}`로
    # 직접 CSS % 소비). 기존엔 이 규약이 소비처 관행으로만 서 있고 서버가 안 막아 다른
    # 단위 클라이언트가 통과·핀이 조용히 딴 자리에 렌더될 수 있었다("금지 AC=서버가 거부"
    # 원칙 위반). ⛔`artifact_spec_pins`(CreateSpecPinRequest, 이 파일의 별개 클래스)는
    # **다른 단위 계약**(px, canvas_bounds 좌표계)이라 이 %(0~100) 제약을 그쪽엔 걸지
    # 않는다 — 처음엔 두 클래스를 같은 규약으로 오판해 걸었다가 미르코 QA 음성대조로
    # 롤백함(페드루 PO, 2026-08-17). 이 클래스(코멘트)만 %.
    anchor_x: float | None = Field(default=None, ge=0, le=100, description="캔버스 폭 대비 %(0~100) — ratio(0~1)·픽셀 아님")
    anchor_y: float | None = Field(default=None, ge=0, le=100, description="캔버스 높이 대비 %(0~100) — ratio(0~1)·픽셀 아님")
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
    # ⛔story #154a26be 정정(페드루 PO, 2026-08-17) — 이 클래스는 %(0~100)가 아니라
    # **px(canvas_bounds 좌표계)**다. FE `edit-canvas.tsx`가 `style={{ left: pin.anchorX,
    # top: pin.anchorY }}`로 단위 없는 숫자를 직접 꽂아 쓴다(React CSSProperties 관례상
    # unitless left/top = px). 실측값(638.4, 398.4)은 오염이 아니라 **정상 데이터**였음
    # (원래 le=100을 걸었다가 라이브 스펙핀 배치를 과잉살상할 뻔한 것을 미르코 QA 음성대조가
    # 잡음). 상한은 걸지 않는다 — 하한(>=0, 아래 _validate_anchor_consistency)만 유지.
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
