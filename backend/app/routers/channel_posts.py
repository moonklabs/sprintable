"""story #3374(Phase1·마케팅운영, 페드루 PO 확定 2026-09-03) — 채널 포스트 초안·버전·상신
API. `app/routers/site_posts.py`(story #3365) 형태를 그대로 미러 — 새 패턴 발명 0."""
from __future__ import annotations

import uuid

from fastapi import APIRouter, Depends, HTTPException, Query
from pydantic import BaseModel, Field
from sqlalchemy.ext.asyncio import AsyncSession

from app.dependencies.auth import AuthContext, get_current_user, get_verified_org_id
from app.dependencies.database import get_db
from app.services.channel_posts import (
    ChannelConnectionNotActiveError,
    ChannelPostApproverRoleMissingError,
    ChannelPostDraftNotFoundError,
    ChannelPostVersionNotFoundError,
    ChannelTextTooLongError,
    create_channel_post_draft_version,
    get_channel_post_draft,
    is_agent_caller,
    list_channel_post_draft_versions,
    list_channel_post_drafts,
    submit_channel_post_draft,
)

# story f8f7cb0f(서버 Threads 발행 실행, 다음 스토리) — publish 엔드포인트가 여기 추가되면
# ChannelPostSealMissingError/ChannelPostReapprovalRequiredError(gate_seal.py 공용 헬퍼,
# app.services.channel_posts가 재-export)를 잡아 SITE_POST_SEAL_MISSING/
# SITE_POST_REAPPROVAL_REQUIRED로 매핑한다(site_posts.py와 문자열 공유, PO 확定
# 2026-09-03 09:02Z) — 이번 스토리(초안·상신 봉인까지)엔 발행이 없어 아직 안 씀.

router = APIRouter(prefix="/api/v2/organizations", tags=["channel-posts"])


class CreateChannelPostDraftVersionRequest(BaseModel):
    work_item_id: uuid.UUID
    connection_id: uuid.UUID
    text: str = Field(..., min_length=1)
    link_url: str | None = None


class ChannelPostDraftVersionResponse(BaseModel):
    draft_id: uuid.UUID
    version_id: uuid.UUID
    version: int
    author_kind: str
    body_sha256: str


class ChannelPostDraftListItem(BaseModel):
    draft_id: uuid.UUID
    work_item_id: uuid.UUID
    channel: str
    connection_id: uuid.UUID
    current_version: int
    latest_author_kind: str
    origin_author_kind: str
    updated_at: str


class ChannelPostVersionHistoryItem(BaseModel):
    version_id: uuid.UUID
    version: int
    draft_id: uuid.UUID
    text: str
    link_url: str | None
    body_sha256: str
    author_member_id: uuid.UUID
    author_kind: str
    created_at: str


class SubmitChannelPostDraftRequest(BaseModel):
    version_id: uuid.UUID | None = None


class SubmitChannelPostDraftResponse(BaseModel):
    gate_id: uuid.UUID
    version_id: uuid.UUID
    content_sha256: str
    status: str


@router.post(
    "/{org_id}/channel-posts/drafts", response_model=ChannelPostDraftVersionResponse, status_code=201,
)
async def post_channel_post_draft_version(
    org_id: uuid.UUID,
    body: CreateChannelPostDraftVersionRequest,
    db: AsyncSession = Depends(get_db),
    verified_org_id: uuid.UUID = Depends(get_verified_org_id),
    auth: AuthContext = Depends(get_current_user),
) -> ChannelPostDraftVersionResponse:
    """AC1 — 고객 에이전트·휴먼 공용 초안 제출/수정 API. `channel`은 요청 본문에 없다 —
    `connection_id`에서 서버가 조회해 derive한다(클라이언트가 실제와 다른 channel을 주장할
    표면 자체를 없앤다, PO 정정: channel은 connection_id의 파생값이지 독립 축이 아니다)."""
    if org_id != verified_org_id:
        raise HTTPException(status_code=403, detail="org_id mismatch")

    member_id = uuid.UUID(auth.user_id)
    actor_type = "agent" if await is_agent_caller(db, org_id=org_id, member_id=member_id) else "human"

    try:
        version = await create_channel_post_draft_version(
            db, org_id=org_id, work_item_id=body.work_item_id, connection_id=body.connection_id,
            text=body.text, link_url=body.link_url, author_member_id=member_id, author_kind=actor_type,
        )
    except ChannelConnectionNotActiveError as exc:
        raise HTTPException(
            status_code=422,
            detail={"code": "CHANNEL_CONNECTION_NOT_ACTIVE", "message": str(exc)},
        ) from exc
    except ChannelTextTooLongError as exc:
        raise HTTPException(
            status_code=422,
            detail={
                "code": "CHANNEL_TEXT_TOO_LONG", "message": str(exc),
                "max_length": exc.max_length, "current_length": exc.current_length,
            },
        ) from exc

    return ChannelPostDraftVersionResponse(
        draft_id=version.draft_id, version_id=version.id, version=version.version,
        author_kind=version.author_kind, body_sha256=version.body_sha256,
    )


@router.get("/{org_id}/channel-posts/drafts", response_model=list[ChannelPostDraftListItem])
async def list_channel_post_drafts_endpoint(
    org_id: uuid.UUID,
    limit: int = Query(default=50, ge=1, le=200),
    offset: int = Query(default=0, ge=0),
    db: AsyncSession = Depends(get_db),
    verified_org_id: uuid.UUID = Depends(get_verified_org_id),
    auth: AuthContext = Depends(get_current_user),
) -> list[ChannelPostDraftListItem]:
    """조직 멤버(휴먼·에이전트 모두) 읽기 가능 — site_posts 목록과 동형(승인·발행 경계
    밖이라 human-only 제약 없음)."""
    if org_id != verified_org_id:
        raise HTTPException(status_code=403, detail="org_id mismatch")

    rows = await list_channel_post_drafts(db, org_id=org_id, limit=limit, offset=offset)
    return [
        ChannelPostDraftListItem(
            draft_id=draft.id, work_item_id=draft.work_item_id, channel=draft.channel,
            connection_id=draft.connection_id, current_version=latest.version,
            latest_author_kind=latest.author_kind, origin_author_kind=origin.author_kind,
            updated_at=latest.created_at.isoformat(),
        )
        for draft, latest, origin in rows
    ]


@router.get(
    "/{org_id}/channel-posts/drafts/{draft_id}/versions", response_model=list[ChannelPostVersionHistoryItem],
)
async def list_channel_post_draft_version_history(
    org_id: uuid.UUID,
    draft_id: uuid.UUID,
    db: AsyncSession = Depends(get_db),
    verified_org_id: uuid.UUID = Depends(get_verified_org_id),
    auth: AuthContext = Depends(get_current_user),
) -> list[ChannelPostVersionHistoryItem]:
    if org_id != verified_org_id:
        raise HTTPException(status_code=403, detail="org_id mismatch")

    draft = await get_channel_post_draft(db, org_id=org_id, draft_id=draft_id)
    if draft is None:
        raise HTTPException(status_code=404, detail=f"draft를 찾을 수 없습니다: {draft_id}")

    versions = await list_channel_post_draft_versions(db, draft_id=draft_id)
    return [
        ChannelPostVersionHistoryItem(
            version_id=v.id, version=v.version, draft_id=draft.id, text=v.text, link_url=v.link_url,
            body_sha256=v.body_sha256, author_member_id=v.author_member_id, author_kind=v.author_kind,
            created_at=v.created_at.isoformat(),
        )
        for v in versions
    ]


@router.post(
    "/{org_id}/channel-posts/drafts/{draft_id}/submit", response_model=SubmitChannelPostDraftResponse,
)
async def submit_channel_post_draft_endpoint(
    org_id: uuid.UUID,
    draft_id: uuid.UUID,
    body: SubmitChannelPostDraftRequest,
    db: AsyncSession = Depends(get_db),
    verified_org_id: uuid.UUID = Depends(get_verified_org_id),
    auth: AuthContext = Depends(get_current_user),
) -> SubmitChannelPostDraftResponse:
    """AC1·AC3 — 초안 버전을 external_publish 게이트에 상신. body.version_id 생략 시 최신
    버전. **에이전트 키도 호출 가능**(2026-09-03 dev 실측 정정 — site S2와 동일 실동작,
    승인·발행만 human-only이고 상신 자체는 actor_type 가드가 없다)."""
    if org_id != verified_org_id:
        raise HTTPException(status_code=403, detail="org_id mismatch")

    try:
        gate, version_id = await submit_channel_post_draft(
            db, org_id=org_id, draft_id=draft_id, version_id=body.version_id,
            requester_member_id=uuid.UUID(auth.user_id),
        )
    except ChannelPostDraftNotFoundError as exc:
        raise HTTPException(status_code=404, detail=str(exc)) from exc
    except ChannelPostVersionNotFoundError as exc:
        raise HTTPException(status_code=404, detail=str(exc)) from exc
    except ChannelConnectionNotActiveError as exc:
        raise HTTPException(
            status_code=422,
            detail={"code": "CHANNEL_CONNECTION_NOT_ACTIVE", "message": str(exc)},
        ) from exc
    except ChannelPostApproverRoleMissingError as exc:
        raise HTTPException(
            status_code=409,
            detail={"code": "CHANNEL_POST_APPROVER_ROLE_MISSING", "message": str(exc)},
        ) from exc

    return SubmitChannelPostDraftResponse(
        gate_id=gate.id, version_id=version_id, content_sha256=gate.sealed_content_sha256,
        status=gate.status,
    )
