import uuid
from datetime import datetime

from pydantic import BaseModel, ConfigDict, computed_field


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
    # story #2974 QA(카디르) — Doc.is_folder(models/doc.py)는 저장 컬럼이 아니라
    # doc_type=="folder"의 derived property다. FE(apps/web/src/app/api/docs/route.ts)가
    # 요청에 is_folder를 실어 보내는데 이 스키마엔 그 필드가 없어 Pydantic이 조용히 버렸다 —
    # 클라가 true를 보내도 항상 doc_type="page"(폴더 아님)로 생성됐다. 라우터가 True면
    # doc_type을 "folder"로 강제한다(create_doc 참고).
    is_folder: bool = False


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
    # story #2346 AC7 — stories.py와 동형(50% 이상 급감+절대손실 100자 이상이면 기본 거부).
    # 정당한 대규모 축약(예: 낡은 섹션 통째로 제거)은 이 플래그로 명시 승인한다.
    allow_shrink: bool = False


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
    # story #2672(2026-08-15, 미르코 라이브 실측 발견) — 단건(DocResponse) 응답엔 있었는데 이
    # 배치조회 응답엔 status가 아예 없었다. C-4 이래 챗 doc 참조 칩 상태 배지·#2669 CTA(draft
    # 판별)가 전부 이 응답을 쓰는 경로라 필드 부재만으로 조용히 빈칸이었다 — FE 소비 로직은
    # 이미 옳게 짜여 있었다(BE 필드 하나 누락이 근본원인). DocResponse와 동일 기본값(draft).
    status: str = "draft"
    is_folder: bool
    tags: list[str]
    created_at: datetime
    updated_at: datetime
    snippet: str | None = None
    # doc-payload enrich(slug-query 단건 경로): FE 상세 fetchDoc 이 GET /api/docs?slug= 를 쓰므로 이 응답에도
    # 담당자/수정이력 요약 동봉(이중 fetch 제거). additive·nullable(다건 list/tree/search 엔 None). forward-ref.
    assignee: "DocMemberSummary | None" = None
    revisions: "DocRevisionsSummary | None" = None


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

    # story #2282(E-CONNECT) AC1/AC2: 이 doc을 가리키는 참조 토큰 — 단일 builder(app.services.
    # reference_token.build_reference_token) 재사용. id/title에서 매 직렬화 시 계산되므로
    # 호출부(create/get/update 등)가 매번 따로 채울 필요가 없다(빠뜨릴 자리 자체가 없다).
    @computed_field  # type: ignore[prop-decorator]
    @property
    def reference_token(self) -> str | None:
        from app.services.reference_token import build_reference_token
        return build_reference_token("doc", self.id, self.title)

    # story #2262(C-4) AC9: 참조 카드의 「다음 행동」 재료 — SSOT는 app.services.next_action.
    # ⛔superseded는 여기서 안 낸다(PO 판정 2026-07-29) — superseded_by(위)가 이미 원자
    # 필드라 FE가 그걸로 직접 판정한다.
    @computed_field  # type: ignore[prop-decorator]
    @property
    def next_action_code(self) -> str | None:
        from app.services.next_action import doc_next_action
        return doc_next_action(status=self.status)

    @computed_field  # type: ignore[prop-decorator]
    @property
    def next_action_category(self) -> str | None:
        from app.services.next_action import next_action_category
        return next_action_category(self.next_action_code)


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


# DocSummaryResponse 는 뒤에 정의된 DocMemberSummary/DocRevisionsSummary 를 forward-ref 하므로 명시 rebuild.
DocSummaryResponse.model_rebuild()
