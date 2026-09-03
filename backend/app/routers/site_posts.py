"""story #3360(발행 구조·서버, 선생님 확定 2026-09-03) — 자사 사이트 글 발행 API(org 인증).

POST /api/v2/organizations/{org_id}/site-posts — org 멤버(에이전트 키 포함) write. **서버
chokepoint**: work item의 external_publish 게이트가 approved/auto_passed가 아니면 403 —
connectors.py::post_connector_schema와 동일 권한 축(스키마 등록처럼 "그 org 소속이면 누구나"
— owner/admin 전용 아님, 발행 스킬을 실행하는 게 에이전트라 owner/admin이면 그 흐름이 첫
호출에서 403으로 죽는다)."""
from __future__ import annotations

import uuid

from fastapi import APIRouter, Depends, HTTPException, Query
from pydantic import BaseModel, Field
from sqlalchemy.ext.asyncio import AsyncSession

from app.dependencies.auth import AuthContext, get_current_user, get_verified_org_id
from app.dependencies.database import get_db
from app.services.site_posts import (
    ExternalPublishGateNotApprovedError,
    InvalidSitePostInputError,
    MediaNotSupportedPhase0Error,
    create_site_post_draft_version,
    get_site_post_draft,
    is_agent_caller,
    list_site_post_draft_versions,
    list_site_post_drafts,
    publish_site_post,
)

router = APIRouter(prefix="/api/v2/organizations", tags=["site-posts"])


class CreateSitePostDraftVersionRequest(BaseModel):
    work_item_id: uuid.UUID
    title: str = Field(..., min_length=1, max_length=300)
    slug: str = Field(..., min_length=1, max_length=200)
    lang: str = Field(..., min_length=2, max_length=5)
    summary: str = Field(..., min_length=1, max_length=1000)
    tags: list[str] = Field(default_factory=list)
    body_md: str = Field(..., min_length=1)
    media_manifest: list = Field(default_factory=list)


class SitePostDraftVersionResponse(BaseModel):
    draft_id: uuid.UUID
    version_id: uuid.UUID
    version: int


class SitePostDraftListItem(BaseModel):
    draft_id: uuid.UUID
    work_item_id: uuid.UUID
    slug: str
    lang: str
    title: str
    current_version: int
    latest_author_kind: str
    updated_at: str


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


class PublishSitePostRequest(BaseModel):
    work_item_id: uuid.UUID
    gate_id: uuid.UUID | None = None
    title: str = Field(..., min_length=1, max_length=300)
    slug: str = Field(..., min_length=1, max_length=200)
    lang: str = Field(..., min_length=2, max_length=5)
    summary: str = Field(..., min_length=1, max_length=1000)
    tags: list[str] = Field(default_factory=list)
    body_md: str = Field(..., min_length=1)


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

    try:
        post = await publish_site_post(
            db, org_id=org_id, work_item_id=body.work_item_id, gate_id=body.gate_id,
            title=body.title, slug=body.slug, lang=body.lang, summary=body.summary,
            tags=body.tags, body_md=body.body_md, created_by_member_id=uuid.UUID(auth.user_id),
        )
    except InvalidSitePostInputError as exc:
        raise HTTPException(status_code=422, detail=str(exc)) from exc
    except ExternalPublishGateNotApprovedError as exc:
        raise HTTPException(status_code=403, detail=str(exc)) from exc

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

    try:
        version = await create_site_post_draft_version(
            db, org_id=org_id, work_item_id=body.work_item_id, slug=body.slug, lang=body.lang,
            title=body.title, summary=body.summary, tags=body.tags, body_md=body.body_md,
            media_manifest=body.media_manifest, author_member_id=member_id, author_kind=actor_type,
        )
    except MediaNotSupportedPhase0Error as exc:
        raise HTTPException(
            status_code=422, detail={"code": "MEDIA_NOT_SUPPORTED_PHASE0", "message": str(exc)},
        ) from exc
    except InvalidSitePostInputError as exc:
        raise HTTPException(status_code=422, detail=str(exc)) from exc

    return SitePostDraftVersionResponse(
        draft_id=version.draft_id, version_id=version.id, version=version.version,
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
            lang=version.lang, title=version.title, current_version=version.version,
            latest_author_kind=version.author_kind, updated_at=version.created_at.isoformat(),
        )
        for draft, version in rows
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

    versions = await list_site_post_draft_versions(db, draft_id=draft_id)
    return [
        SitePostVersionHistoryItem(
            version_id=v.id, version=v.version, slug=draft.slug, source_story_id=draft.work_item_id,
            title=v.title, lang=v.lang, summary=v.summary, tags=v.tags, body_md=v.body_md,
            body_sha256=v.body_sha256, author_member_id=v.author_member_id, author_kind=v.author_kind,
            created_at=v.created_at.isoformat(),
        )
        for v in versions
    ]
