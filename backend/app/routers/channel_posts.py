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
    ChannelPostReapprovalRequiredError,
    ChannelPostSealMissingError,
    ChannelPostVersionNotFoundError,
    ChannelPublishProviderError,
    ChannelRateLimitedError,
    ChannelTextTooLongError,
    ChannelTokenExpiredError,
    ExternalPublishGateNotApprovedError,
    build_tagged_link,
    create_channel_post_draft_version,
    get_channel_post_draft,
    is_agent_caller,
    list_channel_post_draft_versions,
    list_channel_post_drafts,
    publish_channel_post_draft,
    submit_channel_post_draft,
)
from app.services.member_resolver import resolve_member

router = APIRouter(prefix="/api/v2/organizations", tags=["channel-posts"])


async def _require_human(db: AsyncSession, auth: AuthContext, org_id: uuid.UUID):
    """AC1(발행 human-only) — channel_connections.py::_require_human과 동형(별도 role
    제한 없음, publish보다 좁은 owner/admin 축이 아니다 — site_posts.py의 publish
    엔드포인트와 같은 권한 폭: org 멤버인 휴먼이면 누구나)."""
    resolved = await resolve_member(auth, org_id, db)
    if resolved.type != "human":
        raise HTTPException(
            status_code=403,
            detail={
                "code": "CHANNEL_POST_PUBLISH_HUMAN_ONLY",
                "message": "채널 포스트 발행은 휴먼 멤버만 가능합니다(에이전트는 초안·상신까지).",
            },
        )
    return resolved


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
    # story #3394(AC5) — link_url이 있을 때만 채워진다(없으면 null, 지어내지 않는다).
    # publish_channel_post_draft가 실제 발행에 쓰는 것과 같은 값(build_tagged_link 공용).
    tagged_link_preview: str | None = None


class ChannelPostDraftListItem(BaseModel):
    draft_id: uuid.UUID
    work_item_id: uuid.UUID
    channel: str
    connection_id: uuid.UUID
    current_version: int
    latest_author_kind: str
    origin_author_kind: str
    updated_at: str
    # story #3394(AC1·AC3) — site_posts.SitePostDraftListItem(#3742)과 같은 이름·의미로
    # 미러. gate 없으면 전부 None("모른다≠다르다" — 아직 상신 전이라는 뜻).
    gate_status: str | None = None
    reapproval_required: bool | None = None
    sealed_content_sha256: str | None = None
    body_sha256: str
    published_at: str | None = None
    published_body_sha256: str | None = None
    # story #3394(AC2) — 채널 고유. publication_status·error_code는 "최신 버전"의
    # publication 행 기준(T9 이어서 발행), published_at·permalink·external_id는 "가장 최근
    # published" 기준(버전 무관) — 두 축이 다른 이유는 서비스 docstring 참고.
    publication_status: str | None = None
    permalink: str | None = None
    external_id: str | None = None
    error_code: str | None = None


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
    tagged_link_preview: str | None = None


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
        version, channel = await create_channel_post_draft_version(
            db, org_id=org_id, work_item_id=body.work_item_id, connection_id=body.connection_id,
            text=body.text, link_url=body.link_url, author_member_id=member_id, author_kind=actor_type,
        )
    except ChannelConnectionNotActiveError as exc:
        # 페드루 PO 리뷰(2026-09-03) — 발행 스토리(f8f7cb0f) 결정표가 이 코드를 409(상태
        # 충돌·재연결 필요)로 정했다 — 같은 코드에 HTTP status가 갈리면 FE 매핑이 두 벌이
        # 된다. 422는 입력 형태 오류에만 남긴다(CHANNEL_TEXT_TOO_LONG처럼).
        raise HTTPException(
            status_code=409,
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

    tagged_link_preview = (
        build_tagged_link(channel=channel, link_url=body.link_url, draft_id=version.draft_id)
        if body.link_url else None
    )
    return ChannelPostDraftVersionResponse(
        draft_id=version.draft_id, version_id=version.id, version=version.version,
        author_kind=version.author_kind, body_sha256=version.body_sha256,
        tagged_link_preview=tagged_link_preview,
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
            body_sha256=latest.body_sha256,
            gate_status=gate.status if gate else None,
            reapproval_required=gate.reapproval_required if gate else None,
            sealed_content_sha256=gate.sealed_content_sha256 if gate else None,
            published_at=published_pub.published_at.isoformat() if published_pub else None,
            published_body_sha256=published_body_sha256,
            publication_status=latest_pub.status if latest_pub else None,
            permalink=published_pub.permalink if published_pub else None,
            external_id=published_pub.external_id if published_pub else None,
            error_code=latest_pub.error_code if latest_pub else None,
        )
        for draft, latest, origin, gate, published_pub, latest_pub, published_body_sha256 in rows
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
            tagged_link_preview=(
                build_tagged_link(channel=draft.channel, link_url=v.link_url, draft_id=draft.id)
                if v.link_url else None
            ),
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
        # 페드루 PO 리뷰(2026-09-03) — 발행 스토리(f8f7cb0f) 결정표가 이 코드를 409(상태
        # 충돌·재연결 필요)로 정했다 — 같은 코드에 HTTP status가 갈리면 FE 매핑이 두 벌이
        # 된다. 422는 입력 형태 오류에만 남긴다(CHANNEL_TEXT_TOO_LONG처럼).
        raise HTTPException(
            status_code=409,
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


class PublishChannelPostResponse(BaseModel):
    permalink: str | None
    external_id: str | None
    published_at: str
    version_id: uuid.UUID


@router.post(
    "/{org_id}/channel-posts/drafts/{draft_id}/publish", response_model=PublishChannelPostResponse,
)
async def publish_channel_post_draft_endpoint(
    org_id: uuid.UUID,
    draft_id: uuid.UUID,
    db: AsyncSession = Depends(get_db),
    verified_org_id: uuid.UUID = Depends(get_verified_org_id),
    auth: AuthContext = Depends(get_current_user),
) -> PublishChannelPostResponse:
    """story #f8f7cb0f — 휴먼 전용(AC1). 발행 직전 게이트 approved·봉인 일치·connection
    active 셋을 재검증(fail-closed)한 뒤 연결 토큰으로 Threads에 2-호출 발행한다. 같은
    (gate, version) 재요청은 멱등(새 POST 없이 기존 완료 행 반환)."""
    if org_id != verified_org_id:
        raise HTTPException(status_code=403, detail="org_id mismatch")

    resolved = await _require_human(db, auth, org_id)

    try:
        row = await publish_channel_post_draft(
            db, org_id=org_id, draft_id=draft_id, published_by_member_id=resolved.id,
        )
    except ChannelPostDraftNotFoundError as exc:
        raise HTTPException(status_code=404, detail=str(exc)) from exc
    except ExternalPublishGateNotApprovedError as exc:
        raise HTTPException(
            status_code=403,
            detail={"code": "EXTERNAL_PUBLISH_APPROVAL_REQUIRED", "message": str(exc)},
        ) from exc
    except ChannelTextTooLongError as exc:
        # 페드루 PO 확定(2026-09-03) — 발행 시점 재검사(UTM 태그된 링크가 붙은 실제 전송
        # 문자열 기준). draft 생성 시점의 매핑(422·max_length·current_length)과 동형 —
        # 코드 하나가 두 HTTP status를 갖지 않게 유지.
        raise HTTPException(
            status_code=422,
            detail={
                "code": "CHANNEL_TEXT_TOO_LONG", "message": str(exc),
                "max_length": exc.max_length, "current_length": exc.current_length,
            },
        ) from exc
    except ChannelPostSealMissingError as exc:
        raise HTTPException(
            status_code=409, detail={"code": "SITE_POST_SEAL_MISSING", "message": str(exc)},
        ) from exc
    except ChannelPostReapprovalRequiredError as exc:
        raise HTTPException(
            status_code=409,
            detail={"code": "SITE_POST_REAPPROVAL_REQUIRED", "message": str(exc)},
        ) from exc
    except ChannelConnectionNotActiveError as exc:
        raise HTTPException(
            status_code=409,
            detail={"code": "CHANNEL_CONNECTION_NOT_ACTIVE", "message": str(exc)},
        ) from exc
    except ChannelTokenExpiredError as exc:
        raise HTTPException(
            status_code=409,
            detail={"code": "CHANNEL_TOKEN_EXPIRED", "message": str(exc)},
        ) from exc
    except ChannelRateLimitedError as exc:
        raise HTTPException(
            status_code=429,
            detail={"code": "CHANNEL_RATE_LIMITED", "message": str(exc), "reset_at": exc.reset_at.isoformat()},
        ) from exc
    except ChannelPublishProviderError as exc:
        raise HTTPException(
            status_code=502,
            detail={"code": "CHANNEL_PUBLISH_PROVIDER_ERROR", "message": str(exc)},
        ) from exc

    return PublishChannelPostResponse(
        permalink=row.permalink, external_id=row.external_id,
        published_at=row.published_at.isoformat(), version_id=row.version_id,
    )
