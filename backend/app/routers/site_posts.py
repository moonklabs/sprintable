"""story #3360(발행 구조·서버, 선생님 확定 2026-09-03) — 자사 사이트 글 발행 API(org 인증).

POST /api/v2/organizations/{org_id}/site-posts — org 멤버(에이전트 키 포함) write. **서버
chokepoint**: work item의 external_publish 게이트가 approved/auto_passed가 아니면 403 —
connectors.py::post_connector_schema와 동일 권한 축(스키마 등록처럼 "그 org 소속이면 누구나"
— owner/admin 전용 아님, 발행 스킬을 실행하는 게 에이전트라 owner/admin이면 그 흐름이 첫
호출에서 403으로 죽는다)."""
from __future__ import annotations

import uuid

from fastapi import APIRouter, Depends, HTTPException, Query, Request
from pydantic import BaseModel, Field, field_validator
from sqlalchemy.ext.asyncio import AsyncSession

from app.dependencies.auth import AuthContext, get_current_user, get_verified_org_id
from app.dependencies.database import get_db
from app.services.member_resolver import resolve_member
from app.routers.insight_snapshots import InsightSnapshotView
from app.services.generation_budget import GenerationBudgetExceededError
from app.services.insight_snapshots import get_latest_insight_snapshot
from app.services.site_posts import (
    CampaignNotFoundError,
    ContentRuleViolationError,
    ExternalPublishGateNotApprovedError,
    InvalidSitePostInputError,
    MediaNotSupportedPhase0Error,
    SitePostApproverRoleMissingError,
    SitePostConnectionNotFoundError,
    SitePostDestinationKindMismatchError,
    SitePostDraftNotFoundError,
    SitePostGateAlreadyHeldError,
    SitePostNotPublishedError,
    SitePostReapprovalRequiredError,
    SitePostSealMissingError,
    SitePostVersionNotFoundError,
    create_site_post_draft_version,
    get_campaign,
    get_site_post_draft,
    get_site_post_external_publication_state,
    get_site_post_publication_info,
    is_agent_caller,
    list_site_post_draft_versions,
    list_site_post_drafts,
    publish_site_post,
    publish_site_post_from_draft,
    request_site_post_external_publish,
    request_site_post_external_unpublish,
    set_site_post_draft_campaign,
    submit_site_post_draft,
    unpublish_site_post,
)

router = APIRouter(prefix="/api/v2/organizations", tags=["site-posts"])


async def _require_owner_or_admin(db: AsyncSession, auth: AuthContext, org_id: uuid.UUID):
    """story #3381 — 발행 취소(비공개)는 owner/admin 전용(PO 결정, publish보다 좁다 —
    publish는 org 멤버 누구나·이 액션은 되돌릴 수 있는 파괴적 상태전환이라 한 단계 더).
    channel_connections.py의 _require_owner와 동형 2단(human→role) 패턴."""
    resolved = await resolve_member(auth, org_id, db)
    if resolved.type != "human":
        raise HTTPException(
            status_code=403,
            detail={
                "code": "SITE_POST_UNPUBLISH_HUMAN_ONLY",
                "message": "발행 취소는 휴먼 멤버만 가능합니다.",
            },
        )
    if resolved.role not in ("owner", "admin"):
        raise HTTPException(
            status_code=403,
            detail={
                "code": "SITE_POST_UNPUBLISH_OWNER_OR_ADMIN_ONLY",
                "message": "발행 취소는 조직 owner 또는 admin만 가능합니다.",
            },
        )
    return resolved


class CreateSitePostDraftVersionRequest(BaseModel):
    work_item_id: uuid.UUID
    title: str = Field(..., min_length=1, max_length=300)
    slug: str = Field(..., min_length=1, max_length=200)
    lang: str = Field(..., min_length=2, max_length=5)
    summary: str = Field(..., min_length=1, max_length=1000)
    tags: list[str] = Field(default_factory=list)
    body_md: str = Field(..., min_length=1)
    media_manifest: list = Field(default_factory=list)
    # story #3437(AC3, 페드루 PO 確定 2026-09-04) — 이 content_item이 속하는 campaign.
    # 필수 아님(단독 글 허용). 다른 필드와 동형으로 매 호출 전량 재반영(서비스 계층
    # docstring 참고, 캐리포워드 없음).
    campaign_id: uuid.UUID | None = None
    # story e4fc29fa(조각③a, 페드루 PO 確定 2026-09-04) — 이 content_item이 나가는
    # 목적지(channel_connections 행). 생략=캐리포워드, 명시 null=hosted_site로 해제,
    # 값=변경(라우터가 model_fields_set으로 생략/명시null을 구분 — 3437의 campaign_id
    # B1 처방과 동형 센티널 계약, 아래 엔드포인트 참고).
    connection_id: uuid.UUID | None = None

    # story #3437(후속 묶음, 페드루 PO 確定 2026-09-05) — Pydantic min_length은 strip을
    # 안 해 공백만("   ")도 통과·저장됐다. conversations.py:1259-1265 정본 패턴 그대로
    # 미러(새 패턴 발명 0) — 공백만이면 기존 min_length과 동일하게 422.
    @field_validator("title", "slug", "summary")
    @classmethod
    def _non_empty(cls, v: str) -> str:
        v = v.strip()
        if not v:
            raise ValueError("must not be empty")
        return v


class SitePostDraftVersionResponse(BaseModel):
    draft_id: uuid.UUID
    version_id: uuid.UUID
    version: int
    author_kind: str
    body_sha256: str
    # story #3471(페드루 PO 確定 2026-09-05) — 비차단 lint 결과(create/update 시점).
    # channel_posts.py::ChannelPostDraftVersionResponse.violations와 동형.
    violations: list[dict] = []


class SitePostDraftListItem(BaseModel):
    draft_id: uuid.UUID
    work_item_id: uuid.UUID
    slug: str
    lang: str
    title: str
    current_version: int
    latest_author_kind: str
    origin_author_kind: str
    updated_at: str
    # story #3384(Phase0 결함, 유나 원인 진단·페드루 PO 확定 2026-09-03) — 목록 상태 칩이
    # 항상 "초안"으로만 뜨던 결함의 근본 수정. 필드명은 상세 계약(story #3386)과 한 벌 —
    # 게이트 없음/발행 이력 없음이면 각각 None(지어내지 않는다, deriveContentPostStatus의
    # fail-safe가 그대로 「—」로 받는다).
    gate_status: str | None = None
    reapproval_required: bool | None = None
    sealed_content_sha256: str | None = None
    body_sha256: str
    published_at: str | None = None


class SubmitSitePostDraftRequest(BaseModel):
    version_id: uuid.UUID | None = None
    # story #3498(페드루 PO 決定 2026-09-05) — 예상 생성비용 제시(에이전트가 채운다).
    # 생략/null=검사 없음(AC2). 게이트 budget 축(sealed_estimated_cost_minor)에 그대로
    # 봉인된다 — channel_posts.py의 scheduled_at과 동형(submit 전용, draft 컬럼 아님).
    estimated_cost_minor: int | None = None


class SubmitSitePostDraftResponse(BaseModel):
    gate_id: uuid.UUID
    version_id: uuid.UUID
    content_sha256: str
    status: str


class SitePostVersionHistoryItem(BaseModel):
    version_id: uuid.UUID
    version: int
    slug: str
    source_story_id: uuid.UUID
    title: str
    lang: str
    summary: str
    tags: list[str]
    body_md: str
    body_sha256: str
    author_member_id: uuid.UUID
    author_kind: str
    created_at: str
    # story #3457(Phase1·FE, 페드루 PO 確定 2026-09-04) — campaign_id는 이미 쓰기(저장
    # POST 캐리포워드, story #3437)만 있고 이 읽기 응답엔 필드 자체가 없어 "붙인 뒤
    # 새로고침하면 어느 campaign인지 못 보는" 갭이었다. campaign_id는 draft 축(story
    # #3437) — 버전마다 다르지 않다, 그래도 이 계약이 버전 단위 응답이라 매 항목에
    # 그대로 싣는다(FE가 draft를 별도로 안 들고 다녀도 되게). campaign_name은 표시용
    # (campaign_id만 있으면 FE가 campaign 목록을 따로 조회해야 이름을 그릴 수 있다 —
    # #3457 GET .../campaigns 신설이 그 조회를 가능하게 하지만, 이 응답 자체에 이름을
    # 실으면 그 왕복이 아예 불요해진다).
    campaign_id: uuid.UUID | None = None
    campaign_name: str | None = None


class PublishSitePostRequest(BaseModel):
    work_item_id: uuid.UUID
    gate_id: uuid.UUID | None = None
    title: str = Field(..., min_length=1, max_length=300)
    slug: str = Field(..., min_length=1, max_length=200)
    lang: str = Field(..., min_length=2, max_length=5)
    summary: str = Field(..., min_length=1, max_length=1000)
    tags: list[str] = Field(default_factory=list)
    body_md: str = Field(..., min_length=1)

    # story #3437(후속 묶음) — CreateSitePostDraftVersionRequest와 같은 처방(conversations.py
    # 정본 미러, body_md는 자유서식이라 범위 밖).
    @field_validator("title", "slug", "summary")
    @classmethod
    def _non_empty(cls, v: str) -> str:
        v = v.strip()
        if not v:
            raise ValueError("must not be empty")
        return v


class SitePostResponse(BaseModel):
    id: uuid.UUID
    slug: str
    title: str
    lang: str
    published_at: str
    gate_id: uuid.UUID


@router.post("/{org_id}/site-posts", response_model=SitePostResponse, status_code=201)
async def post_site_post(
    org_id: uuid.UUID,
    body: PublishSitePostRequest,
    db: AsyncSession = Depends(get_db),
    verified_org_id: uuid.UUID = Depends(get_verified_org_id),
    auth: AuthContext = Depends(get_current_user),
) -> SitePostResponse:
    if org_id != verified_org_id:
        raise HTTPException(status_code=403, detail="org_id mismatch")

    # story #3365(Phase0 S1) AC4 — 공개 API는 휴먼 전용. 초안 제출자(고객 에이전트)와 발행자(휴먼)
    # 경계가 이 체크 하나로 갈린다 — 가드가 먼저(게이트 조회보다 앞) 서야 mutation("이 조건을
    # 제거하면 반드시 201로 실패")이 성립한다.
    if await is_agent_caller(db, org_id=org_id, member_id=uuid.UUID(auth.user_id)):
        raise HTTPException(
            status_code=403,
            detail={
                "code": "SITE_POST_PUBLISH_HUMAN_ONLY",
                "message": "글 공개는 휴먼 멤버만 가능합니다 (에이전트는 초안만 제출).",
            },
        )
    # story 194acb63(배포 11 실측) — created_by_member_id는 member-bound 리소스 축이라
    # auth.user_id(users.id)가 아니라 resolve_member()가 돌려주는 org_member.id를 써야
    # 한다(위 is_agent_caller가 이미 human을 확認했으니 여기선 항상 human 분기로 해소).
    resolved = await resolve_member(auth, org_id, db)

    try:
        post = await publish_site_post(
            db, org_id=org_id, work_item_id=body.work_item_id, gate_id=body.gate_id,
            title=body.title, slug=body.slug, lang=body.lang, summary=body.summary,
            tags=body.tags, body_md=body.body_md, created_by_member_id=resolved.id,
        )
    except InvalidSitePostInputError as exc:
        raise HTTPException(status_code=422, detail=str(exc)) from exc
    except ExternalPublishGateNotApprovedError as exc:
        raise HTTPException(status_code=403, detail=str(exc)) from exc
    except SitePostReapprovalRequiredError as exc:
        raise HTTPException(
            status_code=409,
            detail={"code": "SITE_POST_REAPPROVAL_REQUIRED", "message": str(exc)},
        ) from exc
    except SitePostSealMissingError as exc:
        raise HTTPException(
            status_code=409,
            detail={"code": "SITE_POST_SEAL_MISSING", "message": str(exc)},
        ) from exc

    return SitePostResponse(
        id=post.id, slug=post.slug, title=post.title, lang=post.lang,
        published_at=post.published_at.isoformat(), gate_id=post.gate_id,
    )


@router.post(
    "/{org_id}/site-posts/drafts", response_model=SitePostDraftVersionResponse, status_code=201,
)
async def post_site_post_draft_version(
    org_id: uuid.UUID,
    body: CreateSitePostDraftVersionRequest,
    db: AsyncSession = Depends(get_db),
    verified_org_id: uuid.UUID = Depends(get_verified_org_id),
    auth: AuthContext = Depends(get_current_user),
) -> SitePostDraftVersionResponse:
    """story #3365(Phase0 S1) — 고객 에이전트·휴먼 공용 초안 제출 API. 공개 권한이 없어도(agent
    키만으로도) 호출 가능 — 공개 `SitePost` 행은 만들지 않는다(AC1). 작성 주체는 요청 body가
    아니라 인증 컨텍스트에서 서버가 판정해 위조를 원천 차단한다(AC2 — body에 author 필드
    자체가 없다)."""
    if org_id != verified_org_id:
        raise HTTPException(status_code=403, detail="org_id mismatch")

    member_id = uuid.UUID(auth.user_id)
    actor_type = "agent" if await is_agent_caller(db, org_id=org_id, member_id=member_id) else "human"

    # story #3437(페드루 PO 리뷰 B1) — 요청 body에 campaign_id 키가 실제로 있었을 때만
    # 서비스에 명시로 넘긴다(model_fields_set) — 생략은 캐리포워드, 서비스 기본 센티널이
    # 그 뜻을 안다. 이 라우터가 "생략=None"으로 뭉개면 캐리포워드 자체가 무의미해진다.
    campaign_kwargs = (
        {"campaign_id": body.campaign_id} if "campaign_id" in body.model_fields_set else {}
    )
    # story e4fc29fa(조각③a, 페드루 리뷰 B1의 3437 처방과 동형) — 요청 body에
    # connection_id 키가 실제로 있었을 때만 서비스에 명시로 넘긴다(model_fields_set) —
    # 생략은 캐리포워드, 서비스 기본 센티널이 그 뜻을 안다.
    connection_kwargs = (
        {"connection_id": body.connection_id} if "connection_id" in body.model_fields_set else {}
    )
    try:
        version, violations = await create_site_post_draft_version(
            db, org_id=org_id, work_item_id=body.work_item_id, slug=body.slug, lang=body.lang,
            title=body.title, summary=body.summary, tags=body.tags, body_md=body.body_md,
            media_manifest=body.media_manifest, author_member_id=member_id, author_kind=actor_type,
            **campaign_kwargs, **connection_kwargs,
        )
    except MediaNotSupportedPhase0Error as exc:
        raise HTTPException(
            status_code=422, detail={"code": "MEDIA_NOT_SUPPORTED_PHASE0", "message": str(exc)},
        ) from exc
    except CampaignNotFoundError as exc:
        raise HTTPException(
            status_code=422, detail={"code": "CAMPAIGN_NOT_FOUND", "message": str(exc)},
        ) from exc
    except SitePostConnectionNotFoundError as exc:
        raise HTTPException(
            status_code=422, detail={"code": "SITE_POST_CONNECTION_NOT_FOUND", "message": str(exc)},
        ) from exc
    except SitePostDestinationKindMismatchError as exc:
        raise HTTPException(
            status_code=422,
            detail={"code": "SITE_POST_DESTINATION_KIND_MISMATCH", "message": str(exc)},
        ) from exc
    except InvalidSitePostInputError as exc:
        raise HTTPException(status_code=422, detail=str(exc)) from exc

    return SitePostDraftVersionResponse(
        draft_id=version.draft_id, version_id=version.id, version=version.version,
        author_kind=version.author_kind, body_sha256=version.body_sha256, violations=violations,
    )


class SetSitePostDraftCampaignRequest(BaseModel):
    campaign_id: uuid.UUID | None


class SitePostDraftCampaignResponse(BaseModel):
    draft_id: uuid.UUID
    campaign_id: uuid.UUID | None
    campaign_name: str | None


@router.patch(
    "/{org_id}/site-posts/drafts/{draft_id}/campaign", response_model=SitePostDraftCampaignResponse,
)
async def patch_site_post_draft_campaign(
    org_id: uuid.UUID,
    draft_id: uuid.UUID,
    body: SetSitePostDraftCampaignRequest,
    db: AsyncSession = Depends(get_db),
    verified_org_id: uuid.UUID = Depends(get_verified_org_id),
    auth: AuthContext = Depends(get_current_user),
) -> SitePostDraftCampaignResponse:
    """story #3437 후속(유나 #3805 정적 판정, 페드루 PO 確定 2026-09-04) — campaign
    「붙이기/해제」 전용 API. 버전 POST(`post_site_post_draft_version`)로 campaign_id를
    바꾸면 본문 무변인데도 새 버전이 이력에 끼고 승인된 게이트가 pending·
    reapproval_required로 되돌아간다(유나 정적 판정) — 이 엔드포인트는 새 버전 0·게이트
    무접촉으로 `site_post_drafts.campaign_id`만 갱신한다. 권한 폭은 버전 POST와 동일
    (org 멤버면 human/agent 모두, 추가 role 제한 없음)."""
    if org_id != verified_org_id:
        raise HTTPException(status_code=403, detail="org_id mismatch")

    try:
        draft = await set_site_post_draft_campaign(
            db, org_id=org_id, draft_id=draft_id, campaign_id=body.campaign_id,
        )
    except SitePostDraftNotFoundError as exc:
        raise HTTPException(status_code=404, detail=f"draft를 찾을 수 없습니다: {exc}") from exc
    except CampaignNotFoundError as exc:
        raise HTTPException(
            status_code=422, detail={"code": "CAMPAIGN_NOT_FOUND", "message": str(exc)},
        ) from exc

    # story 5285888c(PATH_ID 뮤테이션 축, 카디르 QA·페드루 PO 지시 2026-09-04) — 위
    # set_site_post_draft_campaign→get_site_post_draft가 이미 org_id로 조회를 좁혀 실
    # cross-org 접근은 구조적으로 불가능하지만, has_id_mutation_guard 정적 스캐너는
    # 2-hop 안쪽 헬퍼를 안 들여다본다(이름을 직접 아는 1-hop만 인식) — meetings.py::
    # cancel_meeting과 동일 SEC-S6/S7 헬퍼를 라우터 바디에서 직접 호출해 스캐너 가시성을
    # 확보한다(방어 논리 자체는 이미 있었다, 스캐너 인식만 추가).
    from app.services.project_auth import assert_target_in_caller_org

    assert_target_in_caller_org(org_id, draft.org_id, not_found_detail="draft를 찾을 수 없습니다")

    campaign_name: str | None = None
    if draft.campaign_id is not None:
        campaign = await get_campaign(db, org_id=org_id, campaign_id=draft.campaign_id)
        campaign_name = campaign.name if campaign is not None else None
    return SitePostDraftCampaignResponse(
        draft_id=draft.id, campaign_id=draft.campaign_id, campaign_name=campaign_name,
    )


@router.get("/{org_id}/site-posts/drafts", response_model=list[SitePostDraftListItem])
async def list_site_post_drafts_endpoint(
    org_id: uuid.UUID,
    limit: int = Query(default=50, ge=1, le=200),
    offset: int = Query(default=0, ge=0),
    db: AsyncSession = Depends(get_db),
    verified_org_id: uuid.UUID = Depends(get_verified_org_id),
    auth: AuthContext = Depends(get_current_user),
) -> list[SitePostDraftListItem]:
    """story #3365 후속(S4 계약 갭, 페드루 PO 확定 2026-09-03) — S4 글 관리 화면이 열릴 때
    draft_id를 미리 알 방법이 없어 신설. 조직 멤버(휴먼·에이전트 모두) 읽기 가능 — 목록 조회는
    승인·발행 경계 밖이라 human-only 제약 없음."""
    if org_id != verified_org_id:
        raise HTTPException(status_code=403, detail="org_id mismatch")

    rows = await list_site_post_drafts(db, org_id=org_id, limit=limit, offset=offset)
    return [
        SitePostDraftListItem(
            draft_id=draft.id, work_item_id=draft.work_item_id, slug=draft.slug,
            lang=latest.lang, title=latest.title, current_version=latest.version,
            latest_author_kind=latest.author_kind, origin_author_kind=origin.author_kind,
            updated_at=latest.created_at.isoformat(),
            body_sha256=latest.body_sha256,
            gate_status=gate.status if gate else None,
            reapproval_required=gate.reapproval_required if gate else None,
            sealed_content_sha256=gate.sealed_content_sha256 if gate else None,
            published_at=post.published_at.isoformat() if post else None,
        )
        for draft, latest, origin, gate, post in rows
    ]


@router.get(
    "/{org_id}/site-posts/drafts/{draft_id}/versions", response_model=list[SitePostVersionHistoryItem],
)
async def list_site_post_draft_version_history(
    org_id: uuid.UUID,
    draft_id: uuid.UUID,
    db: AsyncSession = Depends(get_db),
    verified_org_id: uuid.UUID = Depends(get_verified_org_id),
    auth: AuthContext = Depends(get_current_user),
) -> list[SitePostVersionHistoryItem]:
    """story #3365 AC6 — 조직 멤버가 버전 이력을 조회하면 에이전트 원안(v1)과 휴먼 개정본(v2+)이
    별도 버전으로 관측된다."""
    if org_id != verified_org_id:
        raise HTTPException(status_code=403, detail="org_id mismatch")

    draft = await get_site_post_draft(db, org_id=org_id, draft_id=draft_id)
    if draft is None:
        raise HTTPException(status_code=404, detail="draft not found")

    # story #3457 — campaign_id는 draft 축(버전마다 안 바뀐다)이라 루프 밖에서 한 번만
    # 조회한다. 존재 비노출 관례상 campaign이 그새 지워졌으면(이례적) None으로 안전
    # 폴백(campaign_id 자체는 그대로 실어 FE가 상황을 알 수 있게 — 지어내지 않는다,
    # campaign_name만 모른다는 뜻).
    campaign_name: str | None = None
    if draft.campaign_id is not None:
        campaign = await get_campaign(db, org_id=org_id, campaign_id=draft.campaign_id)
        campaign_name = campaign.name if campaign is not None else None

    versions = await list_site_post_draft_versions(db, draft_id=draft_id)
    return [
        SitePostVersionHistoryItem(
            version_id=v.id, version=v.version, slug=draft.slug, source_story_id=draft.work_item_id,
            title=v.title, lang=v.lang, summary=v.summary, tags=v.tags, body_md=v.body_md,
            body_sha256=v.body_sha256, author_member_id=v.author_member_id, author_kind=v.author_kind,
            created_at=v.created_at.isoformat(), campaign_id=draft.campaign_id, campaign_name=campaign_name,
        )
        for v in versions
    ]


@router.post(
    "/{org_id}/site-posts/drafts/{draft_id}/submit", response_model=SubmitSitePostDraftResponse,
)
async def submit_site_post_draft_endpoint(
    org_id: uuid.UUID,
    draft_id: uuid.UUID,
    body: SubmitSitePostDraftRequest,
    db: AsyncSession = Depends(get_db),
    verified_org_id: uuid.UUID = Depends(get_verified_org_id),
    auth: AuthContext = Depends(get_current_user),
) -> SubmitSitePostDraftResponse:
    """story #3365(Phase0 S2) — 초안 버전을 external_publish 게이트에 상신(PO 계약 확定
    2026-09-03 04:26Z). body.version_id 생략 시 최신 버전. 에이전트 키도 호출 가능 — 게이트
    생성까지만 허용되고(AC2), external_publish는 항상 human-only 승인 대상(기존 gates.py
    transition_gate_endpoint의 human-only 가드가 그대로 적용, 신규 코드 없음)."""
    if org_id != verified_org_id:
        raise HTTPException(status_code=403, detail="org_id mismatch")

    try:
        gate, version_id = await submit_site_post_draft(
            db, org_id=org_id, draft_id=draft_id, version_id=body.version_id,
            requester_member_id=uuid.UUID(auth.user_id),
            estimated_cost_minor=body.estimated_cost_minor,
        )
    except GenerationBudgetExceededError as exc:
        # story #3498(AC2) — 4값 detail(story 確定 그대로).
        raise HTTPException(
            status_code=422,
            detail={
                "code": "GENERATION_BUDGET_EXCEEDED",
                "limit_minor": exc.limit_minor, "spent_minor": exc.spent_minor,
                "estimated_cost_minor": exc.estimated_cost_minor, "remaining_minor": exc.remaining_minor,
            },
        ) from exc
    except SitePostDraftNotFoundError as exc:
        raise HTTPException(status_code=404, detail=str(exc)) from exc
    except SitePostVersionNotFoundError as exc:
        raise HTTPException(status_code=404, detail=str(exc)) from exc
    except SitePostApproverRoleMissingError as exc:
        raise HTTPException(
            status_code=409,
            detail={"code": "SITE_POST_APPROVER_ROLE_MISSING", "message": str(exc)},
        ) from exc
    except SitePostGateAlreadyHeldError as exc:
        raise HTTPException(
            status_code=409,
            detail={
                "code": "SITE_POST_GATE_ALREADY_HELD",
                "message": str(exc),
                "holding_draft_id": str(exc.holding_draft_id),
                "holding_lang": exc.holding_lang,
                "holding_slug": exc.holding_slug,
            },
        ) from exc
    except ContentRuleViolationError as exc:
        # story #3471(페드루 PO 確定 2026-09-05) — channel_posts.py와 동형 422 body.
        raise HTTPException(
            status_code=422,
            detail={
                "code": "CONTENT_RULE_VIOLATION", "rules_version": exc.rules_version,
                "violations": exc.violations,
            },
        ) from exc

    return SubmitSitePostDraftResponse(
        gate_id=gate.id, version_id=version_id, content_sha256=gate.sealed_content_sha256,
        status=gate.status,
    )


class ChannelPublicationView(BaseModel):
    """story #3476 — `channel_publications` 최신 1행을 그대로 실은 것(서버 값 그대로,
    FE 조립 X). `unpublished_at`은 전용 컬럼이 없다 — status가 "unpublished"일 때만
    updated_at을 그 의미로 재사용한다(신규 마이그 없이, 이 스토리 스코프가 "읽기
    표면"뿐이라 스키마 확장은 별도 판단 대상)."""
    status: str
    external_id: str | None = None
    permalink: str | None = None
    published_at: str | None = None
    unpublished_at: str | None = None
    last_error: str | None = None
    # story #3497 조각4(페드루 PO 決定 2026-09-05, 미르코 #3499 그라운딩에서 나온 갭) —
    # 3497 조회 API(`/publications/{publication_id}/insights`)의 path 파라미터와 같은
    # 값을 여기서 노출한다(외부 목적지 발행=ChannelPublication.id 축, 그라운딩④와 동형).
    publication_id: uuid.UUID


class PublicationCommandView(BaseModel):
    """story #3476 보정①(페드루, 미르코 FE 그라운딩 2026-09-05) — 필드명은 새로
    안 짓는다. FE의 기존 순수 판정 함수 `components/content/failure-action.ts::
    deriveFailureAction`이 channel_post 상세에서 이미 먹는 그 shape 그대로 —
    site_post에도 같은 이름으로 붙여야 `FailureActionBadge`를 재사용할 수 있다."""
    id: uuid.UUID
    command_status: str
    attempt_count: int
    failure_kind: str | None = None
    next_retry_at: str | None = None
    dead_letter_at: str | None = None
    command_reason_code: str | None = None
    last_error: str | None = None


def _channel_publication_view(pub) -> ChannelPublicationView | None:
    if pub is None:
        return None
    return ChannelPublicationView(
        status=pub.status, external_id=pub.external_id, permalink=pub.permalink,
        published_at=pub.published_at.isoformat() if pub.published_at else None,
        unpublished_at=pub.updated_at.isoformat() if pub.status == "unpublished" else None,
        last_error=pub.last_error, publication_id=pub.id,
    )


def _publication_command_view(cmd) -> PublicationCommandView | None:
    if cmd is None:
        return None
    return PublicationCommandView(
        id=cmd.id, command_status=cmd.status, attempt_count=cmd.attempt_count,
        failure_kind=cmd.failure_kind,
        next_retry_at=cmd.next_attempt_at.isoformat() if cmd.next_attempt_at else None,
        dead_letter_at=cmd.dead_letter_at.isoformat() if cmd.dead_letter_at else None,
        command_reason_code=cmd.reason_code,
        last_error=cmd.last_error,
    )


class PublishSitePostFromDraftResponse(BaseModel):
    # story e4fc29fa(조각③c) — 외부 목적지(connection_id != None)는 이 요청 시점엔 아직
    # 결과가 없다(url/published_at은 워커가 나중에 채우는 channel_publications 몫이지
    # 이 응답의 몫이 아니다) — hosted_site 기존 응답과의 회귀 0을 위해 둘 다 Optional로
    # 바꾸되 hosted_site 분기는 여전히 항상 채워 보낸다(channel_posts publish 응답의
    # scheduled=true 모양과 동형 사상 — 새 필드만 추가, 기존 필드 의미 무변경).
    url: str | None = None
    published_at: str | None = None
    version_id: uuid.UUID
    command_id: uuid.UUID | None = None
    status: str | None = None  # "pending" — 외부 목적지 경로에서만 채워진다.
    # story #3476 — 외부 목적지 분기에서만 채워진다(hosted_site는 이 요청으로 이미
    # 동기 완결이라 "지금 어디까지 왔나" 자체가 무의미 — None 유지, 회귀 0).
    channel_publication: ChannelPublicationView | None = None
    command: PublicationCommandView | None = None


@router.post(
    "/{org_id}/site-posts/drafts/{draft_id}/publish", response_model=PublishSitePostFromDraftResponse,
)
async def publish_site_post_from_draft_endpoint(
    org_id: uuid.UUID,
    draft_id: uuid.UUID,
    request: Request,
    db: AsyncSession = Depends(get_db),
    verified_org_id: uuid.UUID = Depends(get_verified_org_id),
    auth: AuthContext = Depends(get_current_user),
) -> PublishSitePostFromDraftResponse:
    """story #3369(Phase0 S3)·e4fc29fa(조각③c 확장) — 휴먼이 승인된 최신 버전을
    공개한다. draft_id 하나로 서버가 직접 최신 버전·게이트를 읽는다(발행 화면이
    본문을 다시 보낼 필요 없음 — S4 계약).

    가드 순서(AC2·AC3): ①에이전트 호출자 차단(SITE_POST_PUBLISH_HUMAN_ONLY) → ②게이트
    approved 재검증(EXTERNAL_PUBLISH_APPROVAL_REQUIRED, auto_passed도 거부) → ③봉인
    재검증(SEAL_MISSING/REAPPROVAL_REQUIRED).

    조각③c — 사용자는 "목적지를 골랐지 내부/외부를 고른 게 아니다"(페드루 확定,
    별도 엔드포인트 신설 거부) — draft의 봉인된 목적지(connection_id)로 이 하나의
    엔드포인트가 분기한다. null(hosted_site)이면 기존 동기 내부 저장 그대로. 값이
    있으면(WordPress 등) publication_command만 만들고 반환 — 실제 발행은 워커가
    한다(channel_posts publish의 "예약" 분기와 같은 응답 모양, command_id+status)."""
    if org_id != verified_org_id:
        raise HTTPException(status_code=403, detail="org_id mismatch")

    if await is_agent_caller(db, org_id=org_id, member_id=uuid.UUID(auth.user_id)):
        raise HTTPException(
            status_code=403,
            detail={
                "code": "SITE_POST_PUBLISH_HUMAN_ONLY",
                "message": "글 공개는 휴먼 멤버만 가능합니다 (에이전트는 초안만 제출).",
            },
        )
    # story 194acb63(배포 11 실측) — 위 post_site_post와 동형 정정: auth.user_id가 아니라
    # resolve_member()의 org_member.id.
    resolved = await resolve_member(auth, org_id, db)

    draft = await get_site_post_draft(db, org_id=org_id, draft_id=draft_id)
    if draft is None:
        raise HTTPException(status_code=404, detail=f"draft를 찾을 수 없습니다: {draft_id}")

    try:
        if draft.connection_id is None:
            post, url, version_id = await publish_site_post_from_draft(
                db, org_id=org_id, draft_id=draft_id, published_by_member_id=resolved.id,
                backend_base_url=str(request.base_url),
            )
            return PublishSitePostFromDraftResponse(
                url=url, published_at=post.published_at.isoformat(), version_id=version_id,
            )

        command = await request_site_post_external_publish(
            db, org_id=org_id, draft_id=draft_id, requested_by_member_id=resolved.id,
        )
        _destination, publication, _cmd_latest = await get_site_post_external_publication_state(
            db, org_id=org_id, draft_id=draft_id,
        )
        return PublishSitePostFromDraftResponse(
            version_id=command.approved_version, command_id=command.id, status=command.status,
            channel_publication=_channel_publication_view(publication),
            command=_publication_command_view(command),
        )
    except SitePostDraftNotFoundError as exc:
        raise HTTPException(status_code=404, detail=str(exc)) from exc
    except GenerationBudgetExceededError as exc:
        # story #3498(AC4) — 발행 直前 재검사 실패(재시도 아님·사유 코드).
        raise HTTPException(
            status_code=422,
            detail={
                "code": "GENERATION_BUDGET_EXCEEDED",
                "limit_minor": exc.limit_minor, "spent_minor": exc.spent_minor,
                "estimated_cost_minor": exc.estimated_cost_minor, "remaining_minor": exc.remaining_minor,
            },
        ) from exc
    except ExternalPublishGateNotApprovedError as exc:
        raise HTTPException(
            status_code=403,
            detail={"code": "EXTERNAL_PUBLISH_APPROVAL_REQUIRED", "message": str(exc)},
        ) from exc
    except SitePostSealMissingError as exc:
        raise HTTPException(
            status_code=409, detail={"code": "SITE_POST_SEAL_MISSING", "message": str(exc)},
        ) from exc
    except SitePostReapprovalRequiredError as exc:
        raise HTTPException(
            status_code=409,
            detail={"code": "SITE_POST_REAPPROVAL_REQUIRED", "message": str(exc)},
        ) from exc


class SitePostPublicationResponse(BaseModel):
    published_at: str | None
    url: str | None
    published_by_member_id: uuid.UUID | None
    published_body_sha256: str | None
    # story #3476 — destination은 hosted_site/wordpress/webhook 3종(기본값 hosted_site
    # 유지 — 기존 필드 넷은 hosted_site에서 이미 그대로 채워지던 값, 회귀 0).
    destination: str = "hosted_site"
    channel_publication: ChannelPublicationView | None = None
    command: PublicationCommandView | None = None
    # story #3497 조각4(페드루 PO 決定 — 미르코 #3499 그라운딩 갭) — 3497 조회 API
    # (`/publications/{publication_id}/insights`)의 path 파라미터와 같은 값. 목적지로
    # 갈린다(hosted_site=SitePost.id·외부=ChannelPublication.id) — latest_insight와
    # 같은 축(insight_publication_id), 발행 이력이 아예 없으면 null.
    publication_id: uuid.UUID | None = None
    # story #3497 조각3 — 이 발행의 가장 최근 캡처된 스냅샷 1건(그라운딩 確定④). 아직
    # 아무것도 안 잡혔으면 None(지어내지 않는다). 전체 이력은 별도 목록 API(insight_
    # snapshots.py 라우터, `/publications/{publication_id}/insights`)에서.
    latest_insight: InsightSnapshotView | None = None


@router.get(
    "/{org_id}/site-posts/drafts/{draft_id}/publication", response_model=SitePostPublicationResponse,
)
async def get_site_post_publication_endpoint(
    org_id: uuid.UUID,
    draft_id: uuid.UUID,
    db: AsyncSession = Depends(get_db),
    verified_org_id: uuid.UUID = Depends(get_verified_org_id),
    auth: AuthContext = Depends(get_current_user),
) -> SitePostPublicationResponse:
    """story #3386(Phase0 결함, S8 — 발행됨·URL·행위자) — 상세 화면이 «승인됨»·URL 없음·
    «발행» 버튼 재활성으로 잘못 그리던 원인(FE의 hasPublishedSitePost가 항상 undefined)의
    서버측 계약. 조직 멤버(휴먼·에이전트 모두) 읽기 가능 — 목록 계약(list_site_post_drafts_
    endpoint)과 동일하게 발행 여부 열람은 승인·발행 경계 밖.

    story 194acb63(배포 11 실측) — url 조립에 request.base_url을 더 쓰지 않는다(그
    자체가 결함의 재료였다)."""
    if org_id != verified_org_id:
        raise HTTPException(status_code=403, detail="org_id mismatch")

    try:
        info = await get_site_post_publication_info(db, org_id=org_id, draft_id=draft_id)
        destination, publication, command = await get_site_post_external_publication_state(
            db, org_id=org_id, draft_id=draft_id,
        )
    except SitePostDraftNotFoundError as exc:
        raise HTTPException(status_code=404, detail=str(exc)) from exc

    # story #3497 조각3 — publication_id 축은 목적지로 갈린다: hosted_site는
    # info.id(SitePost.id 자신, schedule_insight_snapshots가 그 값으로 스케줄한다),
    # 외부(wordpress/webhook)는 publication.id(ChannelPublication.id — publish_site_
    # post_external_command가 그 값으로 스케줄한다).
    insight_publication_id = publication.id if publication is not None else info.id
    latest_insight = None
    if insight_publication_id is not None:
        snapshot = await get_latest_insight_snapshot(db, publication_id=insight_publication_id)
        if snapshot is not None:
            latest_insight = InsightSnapshotView(
                id=snapshot.id, channel=snapshot.channel, due_at=snapshot.due_at,
                captured_at=snapshot.captured_at, status=snapshot.status,
                normalized=snapshot.normalized, source=snapshot.source, error_code=snapshot.error_code,
            )

    return SitePostPublicationResponse(
        published_at=info.published_at.isoformat() if info.published_at else None,
        url=info.url, published_by_member_id=info.published_by_member_id,
        published_body_sha256=info.published_body_sha256,
        destination=destination,
        channel_publication=_channel_publication_view(publication),
        command=_publication_command_view(command),
        publication_id=insight_publication_id,
        latest_insight=latest_insight,
    )


class UnpublishSitePostResponse(BaseModel):
    # story e4fc29fa(조각③c) — publish 응답과 동형 확장(외부 목적지는 이 요청 시점엔
    # 아직 결과가 없다). hosted_site 분기는 기존 그대로 셋 다 채워 보낸다.
    id: uuid.UUID | None = None
    slug: str | None = None
    unpublished_at: str | None = None
    command_id: uuid.UUID | None = None
    status: str | None = None
    # story #3476 — publish 응답과 동형(외부 목적지 분기에서만 채워진다).
    channel_publication: ChannelPublicationView | None = None
    command: PublicationCommandView | None = None


@router.post(
    "/{org_id}/site-posts/drafts/{draft_id}/unpublish", response_model=UnpublishSitePostResponse,
)
async def unpublish_site_post_endpoint(
    org_id: uuid.UUID,
    draft_id: uuid.UUID,
    db: AsyncSession = Depends(get_db),
    verified_org_id: uuid.UUID = Depends(get_verified_org_id),
    auth: AuthContext = Depends(get_current_user),
) -> UnpublishSitePostResponse:
    """story #3381(Phase0 후속·결함) — 공개된 글을 비공개로(행 삭제 아님, 감사 보존·재발행
    가능). owner/admin 전용(publish보다 좁은 권한 — 되돌릴 수 있는 파괴적 액션).

    페드루 PO 코드리뷰(2026-09-03 11:02Z) — 감사 로그 귀속은 `auth.user_id`(휴먼이면
    users.id)가 아니라 `resolve_member()`가 돌려주는 member id(org_member.id)를 써야 한다
    (member-bound 리소스 축, channel_connections.py의 connected_by와 동일 관례) — 이전엔
    `_require_owner_or_admin`의 반환값을 버리고 auth.user_id를 그대로 썼다."""
    if org_id != verified_org_id:
        raise HTTPException(status_code=403, detail="org_id mismatch")

    resolved = await _require_owner_or_admin(db, auth, org_id)

    draft = await get_site_post_draft(db, org_id=org_id, draft_id=draft_id)
    if draft is None:
        raise HTTPException(status_code=404, detail=f"draft를 찾을 수 없습니다: {draft_id}")

    try:
        if draft.connection_id is None:
            post = await unpublish_site_post(
                db, org_id=org_id, draft_id=draft_id, unpublished_by_member_id=resolved.id,
            )
            return UnpublishSitePostResponse(
                id=post.id, slug=post.slug, unpublished_at=post.unpublished_at.isoformat(),
            )

        command = await request_site_post_external_unpublish(
            db, org_id=org_id, draft_id=draft_id, requested_by_member_id=resolved.id,
        )
        _destination, publication, _cmd_latest = await get_site_post_external_publication_state(
            db, org_id=org_id, draft_id=draft_id,
        )
        return UnpublishSitePostResponse(
            command_id=command.id, status=command.status,
            channel_publication=_channel_publication_view(publication),
            command=_publication_command_view(command),
        )
    except SitePostDraftNotFoundError as exc:
        raise HTTPException(status_code=404, detail=str(exc)) from exc
    except SitePostNotPublishedError as exc:
        raise HTTPException(
            status_code=409, detail={"code": "SITE_POST_NOT_PUBLISHED", "message": str(exc)},
        ) from exc
