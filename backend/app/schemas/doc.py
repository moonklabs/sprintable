import uuid
from datetime import datetime

from pydantic import BaseModel, ConfigDict


class DocCreate(BaseModel):
    project_id: uuid.UUID
    org_id: uuid.UUID
    title: str
    slug: str
    content: str = ""
    parent_id: uuid.UUID | None = None
    created_by: uuid.UUID | None = None
    icon: str | None = None
    sort_order: int = 0
    doc_type: str = "page"
    content_format: str = "markdown"
    tags: list[str] = []


class DocUpdate(BaseModel):
    title: str | None = None
    slug: str | None = None
    # 4dd399c6: True=사용자 명시 고정(URL 다이얼로그). 명시 충돌→409, 자동파생(false/미설정)→무음 -N suffix.
    slug_locked: bool | None = None
    content: str | None = None
    parent_id: uuid.UUID | None = None
    icon: str | None = None
    sort_order: int | None = None
    doc_type: str | None = None
    content_format: str | None = None
    tags: list[str] | None = None
    assignee_id: uuid.UUID | None = None
    # 151e05f1: 낙관적 동시성(문서 동시편집 충돌 보호). expected_updated_at 제공 시 BE가 현재
    # updated_at 과 exact match 검사 → 불일치면 409 DOC_CONFLICT(opt-in·미제공=무체크 하위호환).
    # force_overwrite=True 면 검사 우회(last-write-wins 의도적). ⚠️ 이 2필드는 strip 금지(BE 수용).
    expected_updated_at: datetime | None = None
    force_overwrite: bool | None = None


class DocSummaryResponse(BaseModel):
    """List endpoint용 — content 미포함으로 페이로드 최소화."""
    model_config = ConfigDict(from_attributes=True)

    id: uuid.UUID
    project_id: uuid.UUID
    parent_id: uuid.UUID | None = None
    title: str
    slug: str
    canonical_slug: str
    slug_locked: bool = False
    icon: str | None = None
    sort_order: int
    doc_type: str
    is_folder: bool
    tags: list[str]
    updated_at: datetime
    snippet: str | None = None


class DocMemberSummary(BaseModel):
    """담당자 member 최소 요약(아바타 렌더용·FE 별도 fetch 제거). org-scope resolve."""
    id: uuid.UUID
    name: str
    avatar_url: str | None = None


class DocRevisionsSummary(BaseModel):
    """수정이력 요약(count/latest·FE 별도 fetch 제거). full history 는 /{id}/revisions 그대로 사용."""
    count: int = 0
    latest_at: datetime | None = None


class DocResponse(BaseModel):
    model_config = ConfigDict(from_attributes=True)

    id: uuid.UUID
    project_id: uuid.UUID
    org_id: uuid.UUID
    parent_id: uuid.UUID | None = None
    created_by: uuid.UUID | None = None
    assignee_id: uuid.UUID | None = None
    # E-DG S22: doc decision status(doc-specific lifecycle·work status 아님). 기본 draft.
    status: str = "draft"
    # E-DG S28: cross-doc 대체 포인터(이 doc 을 대체한 후속 doc·없으면 None). additive read·재상신
    # 체인엔 안 씀(버전 이력=DocRevision 타임라인). nullable 하위호환.
    superseded_by: uuid.UUID | None = None
    title: str
    slug: str
    canonical_slug: str
    slug_locked: bool = False
    content: str
    icon: str | None = None
    sort_order: int
    doc_type: str
    content_format: str
    tags: list[str]
    created_at: datetime
    updated_at: datetime
    # doc-payload enrich(이중 fetch 제거): 담당자 member 요약 + 수정이력 요약을 doc 상세에 동봉.
    # additive·nullable(하위호환·미enrich 응답/list 엔 None). FE 는 별도 member/revisions fetch 제거.
    assignee: DocMemberSummary | None = None
    revisions: DocRevisionsSummary | None = None


class ShareStatusResponse(BaseModel):
    """b1574f5a: 문서 공유 상태(관리 API). enabled=active 토큰 유무."""
    enabled: bool
    token: str | None = None
    share_url: str | None = None


class PublicDocResponse(BaseModel):
    """b1574f5a: 공개 read 응답 — 메타 누출 0(project/org/author/tree/comment 미반환)."""
    title: str
    content: str
    content_format: str
