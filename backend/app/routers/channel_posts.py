"""story #3374(Phase1·마케팅운영, 페드루 PO 확定 2026-09-03) — 채널 포스트 초안·버전·상신
API. `app/routers/site_posts.py`(story #3365) 형태를 그대로 미러 — 새 패턴 발명 0."""
from __future__ import annotations

import uuid
from datetime import datetime, timezone

from fastapi import APIRouter, Depends, HTTPException, Query
from pydantic import BaseModel, Field
from sqlalchemy.ext.asyncio import AsyncSession

from app.dependencies.auth import AuthContext, get_current_user, get_verified_org_id
from app.dependencies.database import get_db
from app.services.channel_posts import (
    ChannelConnectionNotActiveError,
    ChannelPostApproverRoleMissingError,
    ChannelPostDraftNotFoundError,
    ChannelPostGateAlreadyHeldError,
    ChannelPostReapprovalRequiredError,
    ChannelPostSealMissingError,
    ChannelPostVersionNotFoundError,
    ChannelPublishInProgressError,
    ChannelPublishProviderError,
    ChannelRateLimitedError,
    ChannelTextTooLongError,
    ChannelTokenExpiredError,
    ExternalPublishGateNotApprovedError,
    build_tagged_link,
    build_text_preview,
    create_channel_post_draft_version,
    get_channel_post_draft,
    is_agent_caller,
    list_channel_post_draft_versions,
    list_channel_post_drafts,
    publish_channel_post_draft,
    submit_channel_post_draft,
    text_char_count,
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
    # story #3411 — 최신 버전 text에서 파생(추가 쿼리 0, latest는 이미 조인돼 있음).
    # text_length는 text_char_count()(=len(text), 코드포인트 수)와 반드시 같은 셈법 —
    # _validate_text_length(422 검증)와 두 곳이 갈리지 않게 헬퍼 하나를 공유한다.
    text_preview: str
    text_length: int
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
    # story #3414(PO 確定, 2026-09-04) — 예약 발행 시각도 게이트 봉인 범위(블루프린트
    # v3 §3). 생략/null=즉시. 승인 뒤 이 값만 바꿔도(본문은 그대로) 재승인이 필요하다 —
    # submit_channel_post_draft가 그 판정을 한다(신규 엔드포인트 없음).
    scheduled_at: datetime | None = None


class SubmitChannelPostDraftResponse(BaseModel):
    gate_id: uuid.UUID
    version_id: uuid.UUID
    content_sha256: str
    status: str
    scheduled_at: str | None = None


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


def _to_draft_list_item(
    row: tuple,
) -> ChannelPostDraftListItem:
    """story #3403 — 목록·단건 두 엔드포인트가 공유하는 유일한 직렬화 지점. 손으로 두
    번 짜지 않는다(드리프트 원천 차단, list_channel_post_drafts()가 draft_id 필터를
    똑같이 지원하는 것과 동형 사상)."""
    draft, latest, origin, gate, published_pub, latest_pub, published_body_sha256 = row
    return ChannelPostDraftListItem(
        draft_id=draft.id, work_item_id=draft.work_item_id, channel=draft.channel,
        connection_id=draft.connection_id, current_version=latest.version,
        latest_author_kind=latest.author_kind, origin_author_kind=origin.author_kind,
        updated_at=latest.created_at.isoformat(),
        text_preview=build_text_preview(latest.text), text_length=text_char_count(latest.text),
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
    return [_to_draft_list_item(row) for row in rows]


@router.get(
    "/{org_id}/channel-posts/drafts/{draft_id}", response_model=ChannelPostDraftListItem,
)
async def get_channel_post_draft_detail_endpoint(
    org_id: uuid.UUID,
    draft_id: uuid.UUID,
    db: AsyncSession = Depends(get_db),
    verified_org_id: uuid.UUID = Depends(get_verified_org_id),
    auth: AuthContext = Depends(get_current_user),
) -> ChannelPostDraftListItem:
    """story #3403 — 단건 조회. 목록 항목(`ChannelPostDraftListItem`)과 완전히 같은
    shape·같은 직렬화 경로(`_to_draft_list_item`) — `list_channel_post_drafts()`를
    draft_id 필터로 그대로 재사용해 조인 축 드리프트가 구조적으로 없다. 권한도 목록과
    동일(휴먼·에이전트 둘 다, `_require_human()` 안 부름). org 스코프 밖이거나 존재하지
    않으면 404("존재 비노출" 관례, site_posts detail과 동형)."""
    if org_id != verified_org_id:
        raise HTTPException(status_code=403, detail="org_id mismatch")

    rows = await list_channel_post_drafts(db, org_id=org_id, draft_id=draft_id, limit=1)
    if not rows:
        raise HTTPException(status_code=404, detail=f"draft를 찾을 수 없습니다: {draft_id}")
    return _to_draft_list_item(rows[0])


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
            requester_member_id=uuid.UUID(auth.user_id), scheduled_at=body.scheduled_at,
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
    except ChannelPostGateAlreadyHeldError as exc:
        # story #3404 — site_posts.py의 SITE_POST_GATE_ALREADY_HELD와 동형 상태코드·모양.
        raise HTTPException(
            status_code=409,
            detail={
                "code": "CHANNEL_POST_GATE_ALREADY_HELD",
                "message": str(exc),
                "holding_draft_id": str(exc.holding_draft_id),
                "holding_channel": exc.holding_channel,
                "holding_connection_id": str(exc.holding_connection_id),
            },
        ) from exc

    return SubmitChannelPostDraftResponse(
        gate_id=gate.id, version_id=version_id, content_sha256=gate.sealed_content_sha256,
        status=gate.status,
        scheduled_at=gate.sealed_scheduled_at.isoformat() if gate.sealed_scheduled_at else None,
    )


class PublishChannelPostResponse(BaseModel):
    permalink: str | None = None
    external_id: str | None = None
    published_at: str | None = None
    version_id: uuid.UUID
    # story #3414 — 예약(scheduled_at 봉인됨)이면 이 요청은 command만 만들고 실제
    # 발행은 워커가 나중에 한다. 기존 필드(permalink 등)는 즉시 경로에서만 채워진다
    # (회귀 0 — 기존 FE는 이 셋을 그대로 읽는다, scheduled 필드는 새로 봐야 안다).
    scheduled: bool = False
    command_id: uuid.UUID | None = None
    scheduled_at: str | None = None


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
    """story #f8f7cb0f·#3414 — 휴먼 전용(AC1). 발행/예약 요청 둘 다 이 엔드포인트 하나
    (블루프린트 §3 "즉시 발행=scheduled_at 없음인 같은 명령", PO 確定). 게이트가 승인한
    scheduled_at(gate.sealed_scheduled_at)이 없으면 즉시 — 기존처럼 3중 재검증 뒤
    동기로 Threads 2-호출까지 완료한다. 있으면 `publication_commands` 행만 만들고
    반환 — 실제 발행은 cron 워커(AC3)가 그 시각에 처리한다.

    두 경로 다 `publication_command`를 감사·재시도 원장으로 upsert한다(멱등 —
    같은 draft/version 재요청은 새 행을 안 만든다). command upsert가 **3중
    재검증(게이트approved·seal일치·connection활성) 뒤**에 오도록 순서를 지킨다
    (카디르 QA⑥) — 재검증 실패로 요청이 거부되면 command 행 자체가 안 생긴다(고아
    pending 행이 남아 워커가 엉뚱하게 재시도하는 것을 원천 차단)."""
    if org_id != verified_org_id:
        raise HTTPException(status_code=403, detail="org_id mismatch")

    resolved = await _require_human(db, auth, org_id)

    from app.services.channel_posts import resolve_command_target
    from app.services.publication_command import apply_command_failure, create_or_get_publication_command

    try:
        draft, latest, gate = await resolve_command_target(db, org_id=org_id, draft_id=draft_id)
    except ChannelPostDraftNotFoundError as exc:
        raise HTTPException(status_code=404, detail=str(exc)) from exc
    except ExternalPublishGateNotApprovedError as exc:
        raise HTTPException(
            status_code=403,
            detail={"code": "EXTERNAL_PUBLISH_APPROVAL_REQUIRED", "message": str(exc)},
        ) from exc

    if gate.sealed_scheduled_at is not None:
        # 예약 — command만 만들고 여기서 끝(워커가 나중에 처리, AC3).
        command, _ = await create_or_get_publication_command(
            db, org_id=org_id, gate_id=gate.id, destination=draft.connection_id,
            approved_version=latest.id, requested_by_member_id=resolved.id,
            scheduled_at=gate.sealed_scheduled_at,
        )
        await db.commit()
        return PublishChannelPostResponse(
            version_id=latest.id, scheduled=True, command_id=command.id,
            scheduled_at=gate.sealed_scheduled_at.isoformat(),
        )

    # 즉시 — command를 pending으로 upsert한 뒤 기존처럼 동기 실행(AC2, 동기 유지).
    command, _ = await create_or_get_publication_command(
        db, org_id=org_id, gate_id=gate.id, destination=draft.connection_id,
        approved_version=latest.id, requested_by_member_id=resolved.id, scheduled_at=None,
    )
    await db.commit()
    now = datetime.now(timezone.utc)

    try:
        row = await publish_channel_post_draft(
            db, org_id=org_id, draft_id=draft_id, published_by_member_id=resolved.id,
        )
    except ChannelPostDraftNotFoundError as exc:
        await apply_command_failure(
            db, command, error_code="CHANNEL_POST_DRAFT_NOT_FOUND", last_error=str(exc), now=now,
        )
        await db.commit()
        raise HTTPException(status_code=404, detail=str(exc)) from exc
    except ExternalPublishGateNotApprovedError as exc:
        await apply_command_failure(
            db, command, error_code="EXTERNAL_PUBLISH_APPROVAL_REQUIRED", last_error=str(exc), now=now,
        )
        await db.commit()
        raise HTTPException(
            status_code=403,
            detail={"code": "EXTERNAL_PUBLISH_APPROVAL_REQUIRED", "message": str(exc)},
        ) from exc
    except ChannelTextTooLongError as exc:
        # 페드루 PO 확定(2026-09-03) — 발행 시점 재검사(UTM 태그된 링크가 붙은 실제 전송
        # 문자열 기준). draft 생성 시점의 매핑(422·max_length·current_length)과 동형 —
        # 코드 하나가 두 HTTP status를 갖지 않게 유지.
        await apply_command_failure(
            db, command, error_code="CHANNEL_TEXT_TOO_LONG", last_error=str(exc), now=now,
        )
        await db.commit()
        raise HTTPException(
            status_code=422,
            detail={
                "code": "CHANNEL_TEXT_TOO_LONG", "message": str(exc),
                "max_length": exc.max_length, "current_length": exc.current_length,
            },
        ) from exc
    except ChannelPostSealMissingError as exc:
        await apply_command_failure(
            db, command, error_code="SITE_POST_SEAL_MISSING", last_error=str(exc), now=now,
        )
        await db.commit()
        raise HTTPException(
            status_code=409, detail={"code": "SITE_POST_SEAL_MISSING", "message": str(exc)},
        ) from exc
    except ChannelPostReapprovalRequiredError as exc:
        # story #3414 — 추가② 훅이 대개 이 상황 전에 command를 이미 voided로 무효화해
        # 두지만, 놓친 경합 창은 여기서도 잡는다(이중 방어).
        command.status = "voided"
        command.reason_code = "CONTENT_CHANGED"
        command.last_error = str(exc)[:2000]
        await db.commit()
        raise HTTPException(
            status_code=409,
            detail={"code": "SITE_POST_REAPPROVAL_REQUIRED", "message": str(exc)},
        ) from exc
    except ChannelConnectionNotActiveError as exc:
        await apply_command_failure(
            db, command, error_code="CHANNEL_CONNECTION_NOT_ACTIVE", last_error=str(exc), now=now,
        )
        await db.commit()
        raise HTTPException(
            status_code=409,
            detail={"code": "CHANNEL_CONNECTION_NOT_ACTIVE", "message": str(exc)},
        ) from exc
    except ChannelTokenExpiredError as exc:
        await apply_command_failure(
            db, command, error_code="CHANNEL_TOKEN_EXPIRED", last_error=str(exc), now=now,
        )
        await db.commit()
        raise HTTPException(
            status_code=409,
            detail={"code": "CHANNEL_TOKEN_EXPIRED", "message": str(exc)},
        ) from exc
    except ChannelRateLimitedError as exc:
        retry_after_seconds = max(0, int((exc.reset_at - now).total_seconds()))
        await apply_command_failure(
            db, command, error_code="CHANNEL_RATE_LIMITED", last_error=str(exc), now=now,
            retry_after_seconds=retry_after_seconds,
        )
        await db.commit()
        raise HTTPException(
            status_code=429,
            detail={"code": "CHANNEL_RATE_LIMITED", "message": str(exc), "reset_at": exc.reset_at.isoformat()},
        ) from exc
    except ChannelPublishProviderError as exc:
        await apply_command_failure(
            db, command, error_code="CHANNEL_PUBLISH_PROVIDER_ERROR", last_error=str(exc), now=now,
        )
        await db.commit()
        raise HTTPException(
            status_code=502,
            detail={"code": "CHANNEL_PUBLISH_PROVIDER_ERROR", "message": str(exc)},
        ) from exc
    except ChannelPublishInProgressError as exc:
        # story #3395 — 같은 (gate_id, version_id) 동시 요청 경합에서 진 쪽이 이긴 쪽의
        # 완료를 기다렸는데도 못 끝났다(약 3초). 거짓 200도 무단 500도 아닌 정직한
        # "잠시 후 다시" — 클라이언트 재시도는 그때 남은 container_created 행으로 기존
        # 부분성공 재시도 경로를 그대로 탄다. command는 아직 in_progress로 남겨둔다
        # (실패로 단정 안 함 — 이긴 쪽이 곧 끝낼 것이므로).
        raise HTTPException(
            status_code=409,
            detail={"code": "CHANNEL_PUBLISH_IN_PROGRESS", "message": str(exc)},
        ) from exc

    command.status = "completed"
    command.last_error = None
    command.failure_kind = None
    await db.commit()

    return PublishChannelPostResponse(
        permalink=row.permalink, external_id=row.external_id,
        published_at=row.published_at.isoformat(), version_id=row.version_id,
        scheduled=False, command_id=command.id,
    )


class RetryPublicationCommandResponse(BaseModel):
    id: uuid.UUID
    status: str


@router.post(
    "/{org_id}/channel-posts/publication-commands/{command_id}/retry",
    response_model=RetryPublicationCommandResponse,
)
async def retry_publication_command_endpoint(
    org_id: uuid.UUID,
    command_id: uuid.UUID,
    db: AsyncSession = Depends(get_db),
    verified_org_id: uuid.UUID = Depends(get_verified_org_id),
    auth: AuthContext = Depends(get_current_user),
) -> RetryPublicationCommandResponse:
    """story #3414 AC5 — 휴먼 전용(발행 자체가 human-only인 것과 동형). `dead_letter`
    상태인 command만 다시 큐(`pending`)에 올린다 — 다른 상태(completed·voided·blocked
    등)는 404로 존재 비노출(카디르 QA와 동형 관례, 상태를 굳이 구별해 알려주지 않는다).
    `next_attempt_at`을 null로 되돌려야 다음 cron tick이 이 행을 실제로 다시 집는다
    (status만 바뀌고 next_attempt_at이 미래에 멈춰 있으면 WHERE절에서 계속 빠지는
    결함 — 카디르 QA⑤ 지적 그대로 반영)."""
    if org_id != verified_org_id:
        raise HTTPException(status_code=403, detail="org_id mismatch")
    await _require_human(db, auth, org_id)

    from app.services.publication_command import retry_dead_letter_command

    command = await retry_dead_letter_command(db, org_id=org_id, command_id=command_id)
    if command is None:
        raise HTTPException(status_code=404, detail="command를 찾을 수 없거나 재시도 대상이 아닙니다")
    await db.commit()
    return RetryPublicationCommandResponse(id=command.id, status=command.status)
