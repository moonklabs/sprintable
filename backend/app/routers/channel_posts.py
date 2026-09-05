"""story #3374(Phase1·마케팅운영, 페드루 PO 확定 2026-09-03) — 채널 포스트 초안·버전·상신
API. `app/routers/site_posts.py`(story #3365) 형태를 그대로 미러 — 새 패턴 발명 0."""
from __future__ import annotations

import uuid
from datetime import datetime, timedelta, timezone

from fastapi import APIRouter, Depends, HTTPException, Query
from pydantic import BaseModel, Field, field_validator
from sqlalchemy import select
from sqlalchemy.ext.asyncio import AsyncSession

from app.dependencies.auth import AuthContext, get_current_user, get_verified_org_id
from app.dependencies.database import get_db
from app.models.channel_post_version import ChannelPostVersion
from app.services.content_rules import get_org_content_rules, lint_content
from app.services.channel_posts import (
    ChannelConnectionNotActiveError,
    ChannelImageContainerFailedError,
    ChannelPostApproverRoleMissingError,
    ChannelPostDraftNotFoundError,
    ChannelPostGateAlreadyHeldError,
    ChannelPostGateNotFoundError,
    ChannelPostNotPublishedError,
    ChannelPostReapprovalRequiredError,
    ChannelPostSealMissingError,
    ChannelPostSourceContentItemNotFoundError,
    ChannelPostVersionNotFoundError,
    ChannelPublishInProgressError,
    ChannelPublishProviderError,
    ChannelRateLimitedError,
    ChannelScopeInsufficientError,
    ChannelTextTooLongError,
    ChannelTokenExpiredError,
    ChannelUnpublishUnsupportedError,
    ContentRuleViolationError,
    ExternalPublishGateNotApprovedError,
    PublicationCommandNotCancellableError,
    PublicationCommandNotFoundError,
    build_tagged_link,
    build_text_preview,
    cancel_scheduled_publication,
    create_channel_post_draft_version,
    get_channel_post_draft,
    get_site_post_draft,
    get_source_titles_and_latest_versions,
    is_agent_caller,
    list_channel_post_draft_versions,
    list_channel_post_drafts,
    publish_channel_post_draft,
    submit_channel_post_draft,
    text_char_count,
    unpublish_channel_post,
)
from app.services.channel_post_images import (
    ChannelImageAnimatedUnsupportedError,
    ChannelImageAspectRatioExceededError,
    ChannelImageAspectRatioTooNarrowError,
    ChannelImageConversionFailedError,
    ChannelImageObjectNotFoundError,
    ChannelImagePathNotScopedError,
    ChannelImageStorageNotConfiguredError,
    ChannelImageTooLargeError,
    ChannelImageUnsupportedError,
    ChannelImageUnsupportedFormatError,
    ChannelImageUndecodableError,
    ChannelImageUploadFailedError,
    confirm_channel_post_image_upload,
    create_channel_post_image_upload_url,
    get_channel_post_image_for_version,
    public_url_for_object_path,
)
from app.services.generation_budget import GenerationBudgetExceededError
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


async def _require_owner_or_admin(db: AsyncSession, auth: AuthContext, org_id: uuid.UUID):
    """story #3419 AC3 — 취소·회수는 site_posts.py::_require_owner_or_admin과 동형(발행
    보다 좁은 권한 — 되돌릴 수 있는 파괴적 상태전환이라 owner/admin 한 단계 더)."""
    resolved = await resolve_member(auth, org_id, db)
    if resolved.type != "human":
        raise HTTPException(
            status_code=403,
            detail={
                "code": "CHANNEL_POST_CANCEL_UNPUBLISH_HUMAN_ONLY",
                "message": "발행 취소·회수는 휴먼 멤버만 가능합니다(에이전트는 초안·상신까지).",
            },
        )
    if resolved.role not in ("owner", "admin"):
        raise HTTPException(
            status_code=403,
            detail={
                "code": "CHANNEL_POST_CANCEL_UNPUBLISH_OWNER_OR_ADMIN_ONLY",
                "message": "발행 취소·회수는 조직 owner 또는 admin만 가능합니다.",
            },
        )
    return resolved


class CreateChannelPostDraftVersionRequest(BaseModel):
    work_item_id: uuid.UUID
    connection_id: uuid.UUID
    text: str = Field(..., min_length=1)
    link_url: str | None = None

    # story #3437(후속 묶음, 페드루 PO 確定 2026-09-05) — conversations.py:1259-1265 정본
    # 미러(새 패턴 발명 0). 채널별 글자수 한도(_validate_text_length, 서비스 계층)는 이
    # strip 뒤 값을 그대로 잰다 — 공백 패딩이 한도 판정을 왜곡하지 않게 된다(부수 개선).
    @field_validator("text")
    @classmethod
    def _non_empty(cls, v: str) -> str:
        v = v.strip()
        if not v:
            raise ValueError("must not be empty")
        return v
    # story #3437(AC2·AC5, 페드루 PO 確定 2026-09-04) — 이 채널 변형이 파생된 원문
    # (content_item=site_post_drafts.id). 휴먼·에이전트 동형(둘 다 받는다) — 초안 생성
    # 시에만 반영, 편집(기존 draft) 호출은 무시된다(서비스 계층 docstring 참고).
    source_content_item_id: uuid.UUID | None = None


class ChannelPostDraftVersionResponse(BaseModel):
    draft_id: uuid.UUID
    version_id: uuid.UUID
    version: int
    author_kind: str
    body_sha256: str
    # story #3394(AC5) — link_url이 있을 때만 채워진다(없으면 null, 지어내지 않는다).
    # publish_channel_post_draft가 실제 발행에 쓰는 것과 같은 값(build_tagged_link 공용).
    tagged_link_preview: str | None = None
    # story #3471(페드루 PO 確定 2026-09-05) — 비차단 lint 결과(create/update 시점).
    # 빈 배열=위반 없음(지어내지 않는다 — organization이 규칙을 아예 안 정했으면 항상
    # 빈 배열).
    violations: list[dict] = []


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
    # story #3415(#3414 범위 절단 후속) — publication_commands(story #3414)의 예약·재시도
    # 상태를 목록/단건에 노출. 필드명은 유나 §17-2·§11-5(공통 어휘 정본) 그대로:
    # `next_retry_at`은 DB 컬럼명(`PublicationCommand.next_attempt_at`)과 다르다 — 화면
    # 계약(§17)이 이긴다, 응답 직렬화 지점에서만 이름을 맞춘다(DB 컬럼 리네임 아님).
    # 이 gate에 발행/예약 요청이 아직 없으면(command 자체가 없음) 전부 None.
    failure_kind: str | None = None
    next_retry_at: str | None = None
    dead_letter_at: str | None = None
    # 페드루 PO 리뷰(2026-09-04, PR#3773) — voided(재승인으로 무효)·pending(예약 대기)·
    # blocked가 위 세 필드만으로는 전부 None/None/None로 구별이 안 됐다. 유나 §17-10
    # 정본(command_status 값+라벨 표) 그대로 노출 — 이름은 PR#3769 즉시발행 실패 응답
    # body의 `command_status`와 동일(같은 latest_command 행, 같은 뜻).
    command_status: str | None = None
    command_reason_code: str | None = None
    # story 0e960006(#3448, 페드루 PO 확定 2026-09-04) — dead_letter 수동 재시도
    # (POST .../publication-commands/{command_id}/retry)를 화면이 부르려면 어느 명령
    # 행인지 알아야 한다 — command_status와 같은 latest_command 행에서 id만 additive로
    # 꺼낸다(신규 조회 0, N+1 없음).
    command_id: uuid.UUID | None = None
    # gate.sealed_scheduled_at — publication_command.scheduled_at이 아니다(그 값은 요청
    # 시점 스냅샷이라 재승인 뒤 갱신 안 됨, story #3414). 화면 캘린더(§11-1)가 보는 "지금
    # 승인된 예약 시각"은 이 값.
    scheduled_at: str | None = None
    # story 620beefc(AC6·§17-14) — 최신 버전에 이미지가 붙어 있으면 그 「나가는 파생본」
    # 공개 URL(카드 썸네일). 없으면 null. 원본/최종 width·bytes 둘 다 실어야 화면이
    # "너비 4000px → 1440px · 용량 12.4MB → 3.1MB" 배지 문구를 조립할 수 있다(서버는
    # 문구를 짓지 않고 값만 낸다 — was_converted=false면 원본=최종이라 배지 자체를 안
    # 그린다는 판단은 화면 몫).
    thumbnail_url: str | None = None
    image_original_width: int | None = None
    image_original_bytes: int | None = None
    image_final_width: int | None = None
    image_final_bytes: int | None = None
    image_was_converted: bool | None = None
    # story 620beefc(AC5·§17-15, 페드루 PO 決定) — command_status=pending ∧
    # publication_status=container_created를 서버가 이 값 하나로 파생(판정식은 여기
    # 한 곳에만 — 화면마다 두 필드를 조합판정하지 않는다). 'awaiting_container'=
    # IMAGE 컨테이너가 비동기로 이어서 처리 中(§17-15 "자동으로 이어서 처리 중입니다").
    # 그 외에는 항상 null.
    processing_kind: str | None = None
    # story #3437(ⓒ, 페드루 PO 確定 2026-09-04) — 단건/목록 응답에 파생 원문 노출.
    # 없으면 null(소스 없는 단독 채널 초안, 기존 회귀 그대로).
    source_content_item_id: uuid.UUID | None = None
    # story #3437(후속 묶음, 페드루 PO 確定 2026-09-05) — 원문 제목(배치조회, campaign_name과
    # 동일 클래스 갭 처방). source_content_item_id가 null이면 이것도 항상 null.
    source_title: str | None = None
    # 이 변형이 파생된 시점의 원문 latest version.id(버전 축, 초안 생성 시 고정 — 편집으로는
    # 안 바뀐다).
    source_site_post_version_id: uuid.UUID | None = None
    # 원문의 **지금** latest version.id(배치조회, 매 응답마다 최신값).
    source_current_site_post_version_id: uuid.UUID | None = None
    # story #3453 AC3 후속(유나 §14-4/§14-5, 페드루 PO 確定 2026-09-05) — source_site_
    # post_version_id/source_current_site_post_version_id 비교 판정을 서버가 한 곳에서
    # 낸다(FE 4곳이 각자 비교식을 들고 있으면 어긋날 표면이라 위 "비교는 FE 몫" 결정을
    # 뒤집는다). true=둘 다 non-null이고 서로 다름(원문이 파생 이후 개정됨) · false=둘 다
    # non-null이고 같음 · None=하나라도 null("모른다" — 레거시 파생분).
    source_changed: bool | None = None
    # story #3497 조각4(페드루 PO 決定 — 미르코 #3499 그라운딩 갭) — 3497 조회 API
    # (`/publications/{publication_id}/insights`)의 path 파라미터와 같은 값(latest_pub.id,
    # "최신 버전"의 publication 행 — publication_status·error_code와 같은 축). 아직 발행
    # 시도 자체가 없으면 null.
    publication_id: uuid.UUID | None = None
    # story #3514(Phase1·BE+FE·소형, 페드루 PO 確定 2026-09-05) — 단건 조회(lint-on-read)
    # 전용. 목록 응답에선 항상 None(행마다 lint하면 비용 N배, PO 明示 "단건만"). None=
    # "이 응답에선 안 쟀다"·[]="쟀는데 위반 0"(null≠0 원칙 그대로, site_posts.py::
    # SitePostDraftListItem.violations와 동형).
    violations: list[dict] | None = None


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


class CreateChannelPostImageUploadUrlRequest(BaseModel):
    content_type: str


class ChannelPostImageUploadUrlResponse(BaseModel):
    upload_url: str
    object_path: str
    expires_at: str
    max_bytes: int
    # story 620beefc(페드루 리뷰 블로커 B4) — create_only 서명(GCS:
    # x-goog-if-generation-match)이 PUT 요청에도 정확히 실려야 서명이 valid하다 — FE는
    # 이 헤더를 그대로 PUT에 붙여야 한다(assets.py AssetUploadUrlResponse와 동형 계약).
    required_put_headers: dict[str, str] = {}


class ConfirmChannelPostImageUploadRequest(BaseModel):
    object_path: str


class ChannelPostImageResponse(BaseModel):
    draft_id: uuid.UUID
    version_id: uuid.UUID
    version: int
    # story 620beefc(AC6/§17-14) — 원본·최종(파생본 있으면 그것, 없으면 원본) 둘 다
    # 실어야 화면이 배지 문구("너비 4000px → 1440px · 용량 12.4MB → 3.1MB")를 조립할
    # 수 있다(페드루 PO §17-14 요구, 서버가 문구를 짓지 않고 값만 낸다).
    original_width: int
    original_height: int
    original_bytes: int
    final_width: int
    final_height: int
    final_bytes: int
    was_converted: bool
    image_url: str | None = None


class SubmitChannelPostDraftRequest(BaseModel):
    version_id: uuid.UUID | None = None
    # story #3414(PO 確定, 2026-09-04) — 예약 발행 시각도 게이트 봉인 범위(블루프린트
    # v3 §3). 생략/null=즉시. 승인 뒤 이 값만 바꿔도(본문은 그대로) 재승인이 필요하다 —
    # submit_channel_post_draft가 그 판정을 한다(신규 엔드포인트 없음).
    scheduled_at: datetime | None = None
    # story #3498(페드루 PO 決定 2026-09-05) — site_posts.py와 동형(submit 전용, draft
    # 컬럼 아님). 생략/null=검사 없음(AC2).
    estimated_cost_minor: int | None = None

    @field_validator("scheduled_at")
    @classmethod
    def _scheduled_at_must_be_tz_aware_future(cls, v: datetime | None) -> datetime | None:
        """페드루 리뷰 nit J — naive datetime을 그대로 받으면
        `submit_channel_post_draft`의 `existing.sealed_scheduled_at != scheduled_at`
        비교가 aware(기존 봉인값)와 naive(이번 요청) 사이에서 값이 실제로 같아도 항상
        "다르다"로 나온다(Python은 naive/aware `!=` 비교를 예외 없이 그냥 다르다고
        본다 — 순서 비교(`<`)만 TypeError) → 헛 재승인·대기 명령 誤void. 422로 앞단에서
        막는다. 과거 시각도 거부(예약이 즉시 도래해 버려 "예약"이라는 사용자 의도와
        어긋난다 — cron이 자가치유로 집기야 하겠지만 애초에 요청을 받지 않는 편이
        정직하다)."""
        if v is None:
            return v
        if v.tzinfo is None:
            raise ValueError("scheduled_at은 timezone 정보가 있어야 합니다(예: Z 또는 +09:00)")
        if v <= datetime.now(timezone.utc):
            raise ValueError("scheduled_at은 현재 시각 이후여야 합니다")
        return v


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
        version, channel, violations = await create_channel_post_draft_version(
            db, org_id=org_id, work_item_id=body.work_item_id, connection_id=body.connection_id,
            text=body.text, link_url=body.link_url, author_member_id=member_id, author_kind=actor_type,
            source_content_item_id=body.source_content_item_id,
        )
    except ChannelPostSourceContentItemNotFoundError as exc:
        raise HTTPException(
            status_code=422,
            detail={"code": "CHANNEL_POST_SOURCE_CONTENT_ITEM_NOT_FOUND", "message": str(exc)},
        ) from exc
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

    utm_rule_row = await get_org_content_rules(db, org_id=org_id)
    utm_rules = (utm_rule_row.rules or {}).get("utm_rules") if utm_rule_row else None
    tagged_link_preview = (
        build_tagged_link(channel=channel, link_url=body.link_url, draft_id=version.draft_id, utm_rules=utm_rules)
        if body.link_url else None
    )
    return ChannelPostDraftVersionResponse(
        draft_id=version.draft_id, version_id=version.id, version=version.version,
        author_kind=version.author_kind, body_sha256=version.body_sha256,
        tagged_link_preview=tagged_link_preview, violations=violations,
    )


def _image_response(version, image_row) -> ChannelPostImageResponse:
    return ChannelPostImageResponse(
        draft_id=version.draft_id, version_id=version.id, version=version.version,
        original_width=image_row.original_width, original_height=image_row.original_height,
        original_bytes=image_row.original_bytes,
        final_width=image_row.final_width, final_height=image_row.final_height,
        final_bytes=image_row.final_bytes, was_converted=image_row.was_converted,
        image_url=public_url_for_object_path(image_row.final_object_path),
    )


@router.post(
    "/{org_id}/channel-posts/drafts/{draft_id}/assets/upload-url",
    response_model=ChannelPostImageUploadUrlResponse,
)
async def post_channel_post_image_upload_url(
    org_id: uuid.UUID, draft_id: uuid.UUID, body: CreateChannelPostImageUploadUrlRequest,
    db: AsyncSession = Depends(get_db),
    verified_org_id: uuid.UUID = Depends(get_verified_org_id),
    auth: AuthContext = Depends(get_current_user),
) -> ChannelPostImageUploadUrlResponse:
    """AC1 — 고객 에이전트·휴먼 공용(초안 제출 엔드포인트와 동형 폭). avatar_upload.py와
    같은 2단계(signed URL 발급→FE 직접 PUT→confirm) — 대용량 바이너리가 이 서버를
    경유하지 않는다(storage/base.py D3 원칙)."""
    if org_id != verified_org_id:
        raise HTTPException(status_code=403, detail="org_id mismatch")

    draft = await get_channel_post_draft(db, org_id=org_id, draft_id=draft_id)
    if draft is None:
        raise HTTPException(status_code=404, detail={"code": "CHANNEL_POST_DRAFT_NOT_FOUND", "message": str(draft_id)})

    try:
        result = await create_channel_post_image_upload_url(
            org_id=org_id, draft_id=draft_id, channel=draft.channel, content_type=body.content_type,
        )
    except ChannelImageStorageNotConfiguredError as exc:
        # story 620beefc(페드루 리뷰 B5) — avatar_upload.py 503(AVATAR_UPLOAD_NOT_
        # CONFIGURED)과 동형 축. 채널이 이미지를 지원 안 하는 것(422)과 다른 실패 —
        # 이 환경(dev/prod)에 GCS_CHANNEL_MEDIA_BUCKET 배선이 아직 안 됐을 뿐(배포 갭).
        raise HTTPException(
            status_code=503, detail={"code": "CHANNEL_IMAGE_STORAGE_NOT_CONFIGURED", "message": str(exc)},
        ) from exc
    except ChannelImageUnsupportedError as exc:
        raise HTTPException(
            status_code=422, detail={"code": "CHANNEL_IMAGE_UNSUPPORTED", "message": str(exc), "channel": exc.channel},
        ) from exc
    except ChannelImageUnsupportedFormatError as exc:
        raise HTTPException(
            status_code=422,
            detail={
                "code": "CHANNEL_IMAGE_UNSUPPORTED_FORMAT", "message": str(exc),
                "content_type": exc.content_type, "allowed_formats": list(exc.allowed),
            },
        ) from exc
    except ChannelImageUploadFailedError as exc:
        raise HTTPException(status_code=502, detail={"code": "CHANNEL_IMAGE_UPLOAD_FAILED", "message": str(exc)}) from exc
    return ChannelPostImageUploadUrlResponse(**result)


@router.post(
    "/{org_id}/channel-posts/drafts/{draft_id}/assets/confirm",
    response_model=ChannelPostImageResponse, status_code=201,
)
async def post_channel_post_image_confirm(
    org_id: uuid.UUID, draft_id: uuid.UUID, body: ConfirmChannelPostImageUploadRequest,
    db: AsyncSession = Depends(get_db),
    verified_org_id: uuid.UUID = Depends(get_verified_org_id),
    auth: AuthContext = Depends(get_current_user),
) -> ChannelPostImageResponse:
    """AC1/AC3 — 업로드 확인+자동 변환(필요 시)+계보 기록. 이 호출 자체가 새
    `ChannelPostVersion`을 만든다(text/link_url은 직전 버전에서 캐리포워드, image_sha256만
    갱신) — 텍스트 편집과 동형 축(재승인 판정은 create_channel_post_draft_version의
    기존 재봉인 훅이 그대로 처리, 신규 메커니즘 0)."""
    if org_id != verified_org_id:
        raise HTTPException(status_code=403, detail="org_id mismatch")

    member_id = uuid.UUID(auth.user_id)
    actor_type = "agent" if await is_agent_caller(db, org_id=org_id, member_id=member_id) else "human"

    try:
        version, image_row = await confirm_channel_post_image_upload(
            db, org_id=org_id, draft_id=draft_id, object_path=body.object_path,
            member_id=member_id, member_kind=actor_type,
        )
    except ChannelPostDraftNotFoundError as exc:
        raise HTTPException(status_code=404, detail={"code": "CHANNEL_POST_DRAFT_NOT_FOUND", "message": str(exc)}) from exc
    except ChannelImageStorageNotConfiguredError as exc:
        # story 620beefc(페드루 리뷰 B5) — avatar_upload.py 503(AVATAR_UPLOAD_NOT_
        # CONFIGURED)과 동형 축. 채널이 이미지를 지원 안 하는 것(422)과 다른 실패 —
        # 이 환경(dev/prod)에 GCS_CHANNEL_MEDIA_BUCKET 배선이 아직 안 됐을 뿐(배포 갭).
        raise HTTPException(
            status_code=503, detail={"code": "CHANNEL_IMAGE_STORAGE_NOT_CONFIGURED", "message": str(exc)},
        ) from exc
    except ChannelImageUnsupportedError as exc:
        raise HTTPException(
            status_code=422, detail={"code": "CHANNEL_IMAGE_UNSUPPORTED", "message": str(exc), "channel": exc.channel},
        ) from exc
    except ChannelImagePathNotScopedError as exc:
        raise HTTPException(status_code=403, detail={"code": "CHANNEL_IMAGE_PATH_NOT_SCOPED", "message": str(exc)}) from exc
    except ChannelImageObjectNotFoundError as exc:
        raise HTTPException(status_code=404, detail={"code": "CHANNEL_IMAGE_OBJECT_NOT_FOUND", "message": str(exc)}) from exc
    except ChannelImageTooLargeError as exc:
        raise HTTPException(
            status_code=413,
            detail={
                "code": "CHANNEL_IMAGE_TOO_LARGE", "message": str(exc),
                "size_bytes": exc.size_bytes, "max_bytes": exc.max_bytes,
            },
        ) from exc
    except ChannelImageUndecodableError as exc:
        raise HTTPException(status_code=422, detail={"code": "CHANNEL_IMAGE_UNDECODABLE", "message": str(exc)}) from exc
    except ChannelImageAnimatedUnsupportedError as exc:
        raise HTTPException(
            status_code=422,
            detail={"code": "CHANNEL_IMAGE_ANIMATED_UNSUPPORTED", "message": str(exc), "frame_count": exc.frame_count},
        ) from exc
    except ChannelImageAspectRatioExceededError as exc:
        raise HTTPException(
            status_code=422,
            detail={
                "code": "CHANNEL_IMAGE_ASPECT_RATIO_EXCEEDED", "message": str(exc),
                "aspect_ratio": exc.aspect_ratio, "max_aspect_ratio": exc.max_aspect_ratio,
            },
        ) from exc
    except ChannelImageAspectRatioTooNarrowError as exc:
        raise HTTPException(
            status_code=422,
            detail={
                "code": "CHANNEL_IMAGE_ASPECT_RATIO_TOO_NARROW", "message": str(exc),
                "width_height_ratio": exc.width_height_ratio, "min_width_height_ratio": exc.min_width_height_ratio,
            },
        ) from exc
    except ChannelImageConversionFailedError as exc:
        raise HTTPException(
            status_code=422,
            detail={
                "code": "CHANNEL_IMAGE_CONVERSION_FAILED", "message": str(exc),
                "final_bytes": exc.final_bytes, "max_bytes": exc.max_bytes,
            },
        ) from exc
    except ChannelImageUploadFailedError as exc:
        raise HTTPException(status_code=502, detail={"code": "CHANNEL_IMAGE_UPLOAD_FAILED", "message": str(exc)}) from exc
    return _image_response(version, image_row)


@router.get(
    "/{org_id}/channel-posts/drafts/{draft_id}/versions/{version_id}/asset",
    response_model=ChannelPostImageResponse,
)
async def get_channel_post_image_for_version_endpoint(
    org_id: uuid.UUID, draft_id: uuid.UUID, version_id: uuid.UUID,
    db: AsyncSession = Depends(get_db),
    verified_org_id: uuid.UUID = Depends(get_verified_org_id),
    auth: AuthContext = Depends(get_current_user),
) -> ChannelPostImageResponse:
    """AC6 — 목록/단건 위젯이 썸네일을 그리려면 어느 버전에 무슨 이미지가 붙었는지가
    필요하다. 조직 멤버(휴먼·에이전트 모두) 읽기 가능 — 목록 엔드포인트와 동형 권한 폭."""
    if org_id != verified_org_id:
        raise HTTPException(status_code=403, detail="org_id mismatch")

    version = (await db.execute(
        select(ChannelPostVersion).where(
            ChannelPostVersion.id == version_id, ChannelPostVersion.draft_id == draft_id,
        )
    )).scalar_one_or_none()
    if version is None:
        raise HTTPException(status_code=404, detail={"code": "CHANNEL_POST_VERSION_NOT_FOUND", "message": str(version_id)})

    image_row = await get_channel_post_image_for_version(db, version_id=version_id)
    if image_row is None:
        raise HTTPException(status_code=404, detail={"code": "CHANNEL_POST_IMAGE_NOT_FOUND", "message": str(version_id)})
    return _image_response(version, image_row)


def _to_draft_list_item(
    row: tuple,
    source_titles: dict[uuid.UUID, tuple[str, uuid.UUID]] | None = None,
) -> ChannelPostDraftListItem:
    """story #3403 — 목록·단건 두 엔드포인트가 공유하는 유일한 직렬화 지점. 손으로 두
    번 짜지 않는다(드리프트 원천 차단, list_channel_post_drafts()가 draft_id 필터를
    똑같이 지원하는 것과 동형 사상).

    story #3437(후속 묶음) — `source_titles`는 {content_item_id: (title, latest_
    version_id)} 배치조회 결과(호출부가 미리 구해 넘긴다 — 이 함수 자체는 쿼리를
    안 돈다, N+1 방지 원칙 유지). None/미스=소스 없거나 조회 결과에 없음(둘 다 null로
    떨어진다 — "모른다≠다르다" 원칙과 달리 여긴 순수 배치 미스 표현)."""
    (
        draft, latest, origin, gate, published_pub, latest_pub, published_body_sha256,
        latest_command, latest_image,
    ) = row
    source_title: str | None = None
    source_current_site_post_version_id: uuid.UUID | None = None
    if draft.source_content_item_id is not None and source_titles is not None:
        entry = source_titles.get(draft.source_content_item_id)
        if entry is not None:
            source_title, source_current_site_post_version_id = entry
    # story #3453 AC3 후속 — 판정은 여기 한 곳에서만(FE 4곳이 각자 비교식을 안 들고
    # 다니게). 하나라도 null이면 "모른다"(레거시 파생분 — source_site_post_version_id가
    # #3437 후속 착지 前에 만들어진 초안은 항상 null).
    source_changed: bool | None = None
    if draft.source_site_post_version_id is not None and source_current_site_post_version_id is not None:
        source_changed = draft.source_site_post_version_id != source_current_site_post_version_id
    command_status = latest_command.status if latest_command else None
    publication_status = latest_pub.status if latest_pub else None
    # story 620beefc(AC5·§17-15, 페드루 PO 決定) — 판정식은 이 자리 한 곳에서만.
    processing_kind = (
        "awaiting_container"
        if command_status == "pending" and publication_status == "container_created"
        else None
    )
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
        publication_status=publication_status,
        permalink=published_pub.permalink if published_pub else None,
        external_id=published_pub.external_id if published_pub else None,
        error_code=latest_pub.error_code if latest_pub else None,
        failure_kind=latest_command.failure_kind if latest_command else None,
        next_retry_at=(
            latest_command.next_attempt_at.isoformat()
            if latest_command and latest_command.next_attempt_at else None
        ),
        dead_letter_at=(
            latest_command.dead_letter_at.isoformat()
            if latest_command and latest_command.dead_letter_at else None
        ),
        scheduled_at=gate.sealed_scheduled_at.isoformat() if gate and gate.sealed_scheduled_at else None,
        command_status=command_status,
        command_reason_code=latest_command.reason_code if latest_command else None,
        command_id=latest_command.id if latest_command else None,
        thumbnail_url=public_url_for_object_path(latest_image.final_object_path) if latest_image else None,
        image_original_width=latest_image.original_width if latest_image else None,
        image_original_bytes=latest_image.original_bytes if latest_image else None,
        image_final_width=latest_image.final_width if latest_image else None,
        image_final_bytes=latest_image.final_bytes if latest_image else None,
        image_was_converted=latest_image.was_converted if latest_image else None,
        processing_kind=processing_kind,
        publication_id=latest_pub.id if latest_pub else None,
        source_content_item_id=draft.source_content_item_id,
        source_title=source_title,
        source_site_post_version_id=draft.source_site_post_version_id,
        source_current_site_post_version_id=source_current_site_post_version_id,
        source_changed=source_changed,
    )


@router.get("/{org_id}/channel-posts/drafts", response_model=list[ChannelPostDraftListItem])
async def list_channel_post_drafts_endpoint(
    org_id: uuid.UUID,
    limit: int = Query(default=50, ge=1, le=200),
    offset: int = Query(default=0, ge=0),
    scheduled_from: datetime | None = Query(
        default=None,
        description="예약 시각 범위 시작(tz-aware ISO, gate.sealed_scheduled_at 기준 — "
        "publication_command의 스냅샷 값이 아니다). unscheduled와 함께 줄 수 없다.",
    ),
    scheduled_to: datetime | None = Query(
        default=None,
        description="예약 시각 범위 끝(tz-aware ISO, gate.sealed_scheduled_at 기준). "
        "unscheduled와 함께 줄 수 없다.",
    ),
    unscheduled: bool = Query(
        default=False,
        description="true면 gate.sealed_scheduled_at이 null인 draft만(캘린더 「날짜 미정」 "
        "레인). scheduled_from/scheduled_to와 상호 배타. 게이트 자체가 없는(아직 상신 "
        "안 한) 순수 초안도 포함한다 — 둘 다 「날짜 미정」이라는 점에서 같은 부류다(유나 §11-1).",
    ),
    db: AsyncSession = Depends(get_db),
    verified_org_id: uuid.UUID = Depends(get_verified_org_id),
    auth: AuthContext = Depends(get_current_user),
) -> list[ChannelPostDraftListItem]:
    """조직 멤버(휴먼·에이전트 모두) 읽기 가능 — site_posts 목록과 동형(승인·발행 경계
    밖이라 human-only 제약 없음).

    story #3423(캘린더 #3422 선행) — 날짜 필터 셋(scheduled_from/scheduled_to/
    unscheduled)이 없으면 기존 응답과 완전히 동일(회귀 0). 있으면 tz-aware를
    강제(naive는 비교 결과가 항상 어긋나는 #3414 nit J와 동일 함정)하고, unscheduled는
    범위 파라미터와 상호 배타(둘 다 주면 "무엇을 원하는지" 모호해진다)."""
    if org_id != verified_org_id:
        raise HTTPException(status_code=403, detail="org_id mismatch")

    if unscheduled and (scheduled_from is not None or scheduled_to is not None):
        raise HTTPException(
            status_code=422,
            detail={
                "code": "CHANNEL_POST_LIST_FILTER_CONFLICT",
                "message": "unscheduled는 scheduled_from/scheduled_to와 함께 줄 수 없습니다.",
            },
        )
    for _label, _value in (("scheduled_from", scheduled_from), ("scheduled_to", scheduled_to)):
        if _value is not None and _value.tzinfo is None:
            raise HTTPException(
                status_code=422,
                detail={
                    "code": "CHANNEL_POST_LIST_FILTER_NAIVE_DATETIME",
                    "message": f"{_label}은 timezone 정보가 있어야 합니다(예: Z 또는 +09:00).",
                },
            )
    if scheduled_from is not None and scheduled_to is not None and scheduled_from > scheduled_to:
        raise HTTPException(
            status_code=422,
            detail={
                "code": "CHANNEL_POST_LIST_FILTER_RANGE_INVALID",
                "message": "scheduled_from은 scheduled_to보다 늦을 수 없습니다.",
            },
        )

    rows = await list_channel_post_drafts(
        db, org_id=org_id, limit=limit, offset=offset,
        scheduled_from=scheduled_from, scheduled_to=scheduled_to, unscheduled=unscheduled,
    )
    source_titles = await get_source_titles_and_latest_versions(
        db, org_id=org_id,
        content_item_ids={row[0].source_content_item_id for row in rows if row[0].source_content_item_id},
    )
    return [_to_draft_list_item(row, source_titles) for row in rows]


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
    않으면 404("존재 비노출" 관례, site_posts detail과 동형).

    story #3514(Phase1·BE+FE·소형, 페드루 PO 確定 2026-09-05) — lint-on-read(유나 13회차
    ③ 관찰). 저장 시점 스냅샷(`draft.lint_result`)이 아니라 **지금** org 규칙으로 최신
    버전을 다시 lint한다 — 목록 응답엔 안 실음(단건만, 비용 N배 방지)."""
    if org_id != verified_org_id:
        raise HTTPException(status_code=403, detail="org_id mismatch")

    rows = await list_channel_post_drafts(db, org_id=org_id, draft_id=draft_id, limit=1)
    if not rows:
        raise HTTPException(status_code=404, detail=f"draft를 찾을 수 없습니다: {draft_id}")
    source_titles = await get_source_titles_and_latest_versions(
        db, org_id=org_id,
        content_item_ids={rows[0][0].source_content_item_id} if rows[0][0].source_content_item_id else set(),
    )
    item = _to_draft_list_item(rows[0], source_titles)

    latest_version = rows[0][1]
    rule_row = await get_org_content_rules(db, org_id=org_id)
    item.violations = lint_content(
        rule_row.rules if rule_row else None, text=latest_version.text, link_url=latest_version.link_url,
    )
    return item


@router.get(
    "/{org_id}/site-posts/drafts/{content_item_id}/variants", response_model=list[ChannelPostDraftListItem],
)
async def list_content_item_variants_endpoint(
    org_id: uuid.UUID,
    content_item_id: uuid.UUID,
    db: AsyncSession = Depends(get_db),
    verified_org_id: uuid.UUID = Depends(get_verified_org_id),
    auth: AuthContext = Depends(get_current_user),
) -> list[ChannelPostDraftListItem]:
    """story #3437(AC2) — 원문(content_item=site_post_drafts.id) 쪽에서 그 원문에서
    파생된 채널 변형 목록(채널·상태)을 조회한다. `list_channel_post_drafts()`를
    `source_content_item_id` 필터로 그대로 재사용(`_to_draft_list_item`과 함께 —
    단건/목록 조회와 조인·직렬화 축 드리프트 0). 조직 멤버(휴먼·에이전트 모두) 읽기
    가능 — 목록/단건 조회와 동형 권한 폭(승인·발행 경계 밖)."""
    if org_id != verified_org_id:
        raise HTTPException(status_code=403, detail="org_id mismatch")

    content_item = await get_site_post_draft(db, org_id=org_id, draft_id=content_item_id)
    if content_item is None:
        raise HTTPException(status_code=404, detail=f"원문을 찾을 수 없습니다: {content_item_id}")

    rows = await list_channel_post_drafts(
        db, org_id=org_id, source_content_item_id=content_item_id, limit=200,
    )
    # story #3437(후속 묶음) — 이 엔드포인트는 filter 자체가 content_item_id 단건이라
    # source_content_item_id가 전부 이 값 하나 — 배치라 해도 실질 단건 조회.
    source_titles = await get_source_titles_and_latest_versions(
        db, org_id=org_id, content_item_ids={content_item_id},
    )
    return [_to_draft_list_item(row, source_titles) for row in rows]


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
    utm_rule_row = await get_org_content_rules(db, org_id=org_id)
    utm_rules = (utm_rule_row.rules or {}).get("utm_rules") if utm_rule_row else None
    return [
        ChannelPostVersionHistoryItem(
            version_id=v.id, version=v.version, draft_id=draft.id, text=v.text, link_url=v.link_url,
            body_sha256=v.body_sha256, author_member_id=v.author_member_id, author_kind=v.author_kind,
            created_at=v.created_at.isoformat(),
            tagged_link_preview=(
                build_tagged_link(channel=draft.channel, link_url=v.link_url, draft_id=draft.id, utm_rules=utm_rules)
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
            estimated_cost_minor=body.estimated_cost_minor,
        )
    except GenerationBudgetExceededError as exc:
        # story #3498(AC2) — site_posts.py와 동형 4값 detail.
        raise HTTPException(
            status_code=422,
            detail={
                "code": "GENERATION_BUDGET_EXCEEDED",
                "limit_minor": exc.limit_minor, "spent_minor": exc.spent_minor,
                "estimated_cost_minor": exc.estimated_cost_minor, "remaining_minor": exc.remaining_minor,
            },
        ) from exc
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
    except ContentRuleViolationError as exc:
        # story #3471(페드루 PO 確定 2026-09-05) — 금지 AC=서버 거부. 422 body는
        # {code, rules_version, violations[]}(3343 구조화 형 준용, story #3471 확定).
        raise HTTPException(
            status_code=422,
            detail={
                "code": "CONTENT_RULE_VIOLATION", "rules_version": exc.rules_version,
                "violations": exc.violations,
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
    # story 620beefc(AC5·§17-15) — IMAGE 컨테이너는 비동기라, 예약이 아닌 "즉시" 요청도
    # 이 응답 시점엔 아직 발행이 안 끝났을 수 있다(`scheduled`=사용자가 미래 시각을
    # 지정했다는 뜻과는 다른 축 — 이건 "지금 요청했는데 서버가 자동으로 이어서
    # 처리 중"). true면 permalink/external_id/published_at은 전부 null(아직 없다).
    processing: bool = False


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
    같은 draft/version 재요청은 새 행을 안 만든다).

    페드루 리뷰 F(제품 의미 확定) — command upsert는 **3중 재검증 앞이 아니라**
    `resolve_command_target`의 게이트-승인 확인 **뒤**에 온다(카디르 QA⑥, 재검증
    실패로 요청 자체가 거부되면 command 행이 안 생겨 고아 pending을 막는다). 다만
    나머지 두 재검증(seal 일치·connection 활성)은 `publish_channel_post_draft` 호출
    **안에서** 일어난다 — 즉 command가 이미 만들어진 뒤에 그 두 검증이 실패할 수
    있다는 뜻이고, 그러면 이 command는 (고아가 아니라) "사람이 실제로 요청한
    명령"으로 pending에 남는다. 그 실패가 결정적(needs_check — 예:
    SITE_POST_REAPPROVAL_REQUIRED류)이면 즉시 dead_letter로 멈추고(자동 재시도
    없음), 일시적(transient/quota)이면 백오프 재시도, connection이면 blocked로
    넘어간다 — 사람이 모르게 방치되지 않도록 실패 응답 body에 `command_status`·
    `next_attempt_at`을 함께 낸다(화면 문구는 후속)."""
    if org_id != verified_org_id:
        raise HTTPException(status_code=403, detail="org_id mismatch")

    resolved = await _require_human(db, auth, org_id)

    from app.services.channel_posts import resolve_command_target
    from app.services.publication_command import record_publication_attempt, apply_command_failure, create_or_get_publication_command

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
    attempt_started_at = now

    async def _record_this_attempt(*, approval_check: str, adapter_called: bool, result_code: str | None) -> None:
        # story #3474(페드루 보정, 2026-09-05) — 즉시 발행은 `_process_one_command`
        # (cron 워커)를 안 거치는 별도 동기 경로라, 그쪽에 심은 원장 기록이 이 경로엔
        # 하나도 안 닿는다. 실제 채널 발행 트래픽 대부분이 이 경로(즉시)를 타므로
        # 여기서 빠지면 원장이 소수(예약분)만 세는 반쪽 계측이 된다 — 워커와 같은
        # 지점(publish_channel_post_draft 호출 전후)에 동일하게 심는다.
        await record_publication_attempt(
            db, command=command, approval_check=approval_check, adapter_called=adapter_called,
            started_at=attempt_started_at, finished_at=datetime.now(timezone.utc), result_code=result_code,
        )

    def _with_command_state(detail: dict) -> dict:
        # 페드루 리뷰 F(제품 의미 확定) — 즉시 발행 실패로 command가 pending(자동
        # 재시도 대기)/dead_letter(재시도 없음)/blocked(연결 복구 대기)/voided로 남을
        # 수 있다. 사람이 요청한 명령이 사람 모르게 방치되지 않도록 실패 응답에 그
        # 상태와 다음 자동 재시도 시각을 함께 낸다(화면 문구는 후속 스토리).
        return {
            **detail,
            "command_status": command.status,
            "next_attempt_at": command.next_attempt_at.isoformat() if command.next_attempt_at else None,
        }

    try:
        row = await publish_channel_post_draft(
            db, org_id=org_id, draft_id=draft_id, published_by_member_id=resolved.id,
        )
    except ChannelPostDraftNotFoundError as exc:
        await _record_this_attempt(approval_check="ok", adapter_called=False, result_code="CHANNEL_POST_DRAFT_NOT_FOUND")
        await apply_command_failure(
            db, command, error_code="CHANNEL_POST_DRAFT_NOT_FOUND", last_error=str(exc), now=now,
        )
        await db.commit()
        raise HTTPException(
            status_code=404,
            detail=_with_command_state({"code": "CHANNEL_POST_DRAFT_NOT_FOUND", "message": str(exc)}),
        ) from exc
    except ExternalPublishGateNotApprovedError as exc:
        # story #3474 — publish_channel_post_draft 내부 게이트 재검증이 여기서 막았다
        # (adapter 미호출). 워커의 blocked_unapproved와 같은 결이지만, 이 즉시-발행
        # 경로는 사람이 그 자리에서 받는 HTTP 실패라 command 종결 정책은 기존
        # apply_command_failure(needs_check→dead_letter) 그대로 둔다(페드루 확定 —
        # 이 코드 경로 자체의 재시도/종결 정책 변경은 이 스토리 스코프 밖, 원장
        # 기록만 추가).
        await _record_this_attempt(approval_check="missing", adapter_called=False, result_code=None)
        await apply_command_failure(
            db, command, error_code="EXTERNAL_PUBLISH_APPROVAL_REQUIRED", last_error=str(exc), now=now,
        )
        await db.commit()
        raise HTTPException(
            status_code=403,
            detail=_with_command_state({"code": "EXTERNAL_PUBLISH_APPROVAL_REQUIRED", "message": str(exc)}),
        ) from exc
    except GenerationBudgetExceededError as exc:
        # story #3498(AC4) — 위 EXTERNAL_PUBLISH_APPROVAL_REQUIRED와 동형 처리(adapter
        # 미호출, 원장 기록만 추가·재시도/종결 정책 변경 없음).
        await _record_this_attempt(approval_check="budget_exceeded", adapter_called=False, result_code=None)
        await apply_command_failure(
            db, command, error_code="GENERATION_BUDGET_EXCEEDED", last_error=str(exc), now=now,
        )
        await db.commit()
        raise HTTPException(
            status_code=422,
            detail=_with_command_state({
                "code": "GENERATION_BUDGET_EXCEEDED",
                "limit_minor": exc.limit_minor, "spent_minor": exc.spent_minor,
                "estimated_cost_minor": exc.estimated_cost_minor, "remaining_minor": exc.remaining_minor,
            }),
        ) from exc
    except ChannelTextTooLongError as exc:
        # 페드루 PO 확定(2026-09-03) — 발행 시점 재검사(UTM 태그된 링크가 붙은 실제 전송
        # 문자열 기준). draft 생성 시점의 매핑(422·max_length·current_length)과 동형 —
        # 코드 하나가 두 HTTP status를 갖지 않게 유지. story #3474(페드루 리뷰 보정①,
        # 2026-09-05) — `_validate_text_length`는 channel_posts.py:1158, httpx 클라이언트
        # 블록(1160) *앞* — Threads에 아무 HTTP도 안 나간 시점(adapter_called=False).
        await _record_this_attempt(approval_check="ok", adapter_called=False, result_code="CHANNEL_TEXT_TOO_LONG")
        await apply_command_failure(
            db, command, error_code="CHANNEL_TEXT_TOO_LONG", last_error=str(exc), now=now,
        )
        await db.commit()
        raise HTTPException(
            status_code=422,
            detail=_with_command_state({
                "code": "CHANNEL_TEXT_TOO_LONG", "message": str(exc),
                "max_length": exc.max_length, "current_length": exc.current_length,
            }),
        ) from exc
    except ChannelPostSealMissingError as exc:
        # story #3474(페드루 리뷰 보정①) — channel_posts.py:1095, httpx 클라이언트 블록
        # 앞(같은 이유로 adapter_called=False).
        await _record_this_attempt(approval_check="ok", adapter_called=False, result_code="SITE_POST_SEAL_MISSING")
        await apply_command_failure(
            db, command, error_code="SITE_POST_SEAL_MISSING", last_error=str(exc), now=now,
        )
        await db.commit()
        raise HTTPException(
            status_code=409,
            detail=_with_command_state({"code": "SITE_POST_SEAL_MISSING", "message": str(exc)}),
        ) from exc
    except ChannelPostReapprovalRequiredError as exc:
        # story #3414 — 추가② 훅이 대개 이 상황 전에 command를 이미 voided로 무효화해
        # 두지만, 놓친 경합 창은 여기서도 잡는다(이중 방어). story #3474 — 봉인 sha256
        # 불일치라 adapter 미호출(워커의 version_mismatch와 동형).
        await _record_this_attempt(approval_check="version_mismatch", adapter_called=False, result_code=None)
        command.status = "voided"
        command.reason_code = "CONTENT_CHANGED"
        command.last_error = str(exc)[:2000]
        await db.commit()
        raise HTTPException(
            status_code=409,
            detail=_with_command_state({"code": "SITE_POST_REAPPROVAL_REQUIRED", "message": str(exc)}),
        ) from exc
    except ChannelConnectionNotActiveError as exc:
        # story #3474(페드루 리뷰 보정①) — channel_posts.py:1129, `create_container`
        # 호출(1255) 전이라 adapter_called=False.
        await _record_this_attempt(approval_check="ok", adapter_called=False, result_code="CHANNEL_CONNECTION_NOT_ACTIVE")
        await apply_command_failure(
            db, command, error_code="CHANNEL_CONNECTION_NOT_ACTIVE", last_error=str(exc), now=now,
        )
        await db.commit()
        raise HTTPException(
            status_code=409,
            detail=_with_command_state({"code": "CHANNEL_CONNECTION_NOT_ACTIVE", "message": str(exc)}),
        ) from exc
    except ChannelTokenExpiredError as exc:
        await _record_this_attempt(approval_check="ok", adapter_called=True, result_code="CHANNEL_TOKEN_EXPIRED")
        await apply_command_failure(
            db, command, error_code="CHANNEL_TOKEN_EXPIRED", last_error=str(exc), now=now,
        )
        await db.commit()
        raise HTTPException(
            status_code=409,
            detail=_with_command_state({"code": "CHANNEL_TOKEN_EXPIRED", "message": str(exc)}),
        ) from exc
    except ChannelRateLimitedError as exc:
        retry_after_seconds = max(0, int((exc.reset_at - now).total_seconds()))
        await _record_this_attempt(approval_check="ok", adapter_called=True, result_code="CHANNEL_RATE_LIMITED")
        await apply_command_failure(
            db, command, error_code="CHANNEL_RATE_LIMITED", last_error=str(exc), now=now,
            retry_after_seconds=retry_after_seconds,
        )
        await db.commit()
        raise HTTPException(
            status_code=429,
            detail=_with_command_state({
                "code": "CHANNEL_RATE_LIMITED", "message": str(exc), "reset_at": exc.reset_at.isoformat(),
            }),
            # 페드루 리뷰 블로커E — Retry-After 헤더가 빠져 있었다(main.py의 헤더
            # 처리기는 slowapi 429 경로만 커버, 이 429는 그 경로가 아니다). 실값
            # (retry_after_seconds)은 바로 위에서 이미 계산했다 — 그대로 싣는다.
            headers={"Retry-After": str(retry_after_seconds)},
        ) from exc
    except ChannelPublishProviderError as exc:
        await _record_this_attempt(approval_check="ok", adapter_called=True, result_code="CHANNEL_PUBLISH_PROVIDER_ERROR")
        await apply_command_failure(
            db, command, error_code="CHANNEL_PUBLISH_PROVIDER_ERROR", last_error=str(exc), now=now,
        )
        await db.commit()
        raise HTTPException(
            status_code=502,
            detail=_with_command_state({"code": "CHANNEL_PUBLISH_PROVIDER_ERROR", "message": str(exc)}),
        ) from exc
    except ChannelPublishInProgressError as exc:
        # story #3395 — 같은 (gate_id, version_id) 동시 요청 경합에서 진 쪽이 이긴 쪽의
        # 완료를 기다렸는데도 못 끝났다(약 3초). 거짓 200도 무단 500도 아닌 정직한
        # "잠시 후 다시" — 클라이언트 재시도는 그때 남은 container_created 행으로 기존
        # 부분성공 재시도 경로를 그대로 탄다. 페드루 리뷰 nit I — command는 여기서
        # 손대지 않는다(apply_command_failure를 안 부른다) — 생성 시점 그대로
        # `pending`이다("in_progress로 남긴다"던 원래 주석이 틀렸다 — in_progress는
        # 워커·이 함수의 성공 직전에만 대입되는 값이지 여기선 대입한 적이 없다). 다음
        # 요청(재시도)이 같은 멱등키로 이 pending command를 그대로 재사용한다.
        raise HTTPException(
            status_code=409,
            detail=_with_command_state({"code": "CHANNEL_PUBLISH_IN_PROGRESS", "message": str(exc)}),
        ) from exc
    except ChannelImageContainerFailedError as exc:
        # story 620beefc(AC5) — Threads가 IMAGE 컨테이너를 ERROR/EXPIRED로 끝냈다(결정적,
        # 재시도해도 안 바뀐다). needs_check 분류라 자동 재시도 없이 사람 재시도(retry
        # 엔드포인트, AC5)만 남긴다.
        await _record_this_attempt(approval_check="ok", adapter_called=True, result_code="CHANNEL_IMAGE_CONTAINER_FAILED")
        await apply_command_failure(
            db, command, error_code="CHANNEL_IMAGE_CONTAINER_FAILED", last_error=str(exc), now=now,
        )
        await db.commit()
        raise HTTPException(
            status_code=502,
            detail=_with_command_state({
                "code": "CHANNEL_IMAGE_CONTAINER_FAILED", "message": str(exc),
                "container_status": exc.container_status,
            }),
        ) from exc

    if row.status != "published":
        # story 620beefc(AC5) — IMAGE 컨테이너가 아직 처리 中. 예외가 안 났다는 것
        # 자체가 "지금까지는 정상, 아직 안 끝났다"는 뜻 — command는 pending에
        # 남기고(다음 cron tick이 이어 폴링) 사람에게는 "처리 中"임을 그대로 알린다.
        await _record_this_attempt(approval_check="ok", adapter_called=True, result_code=row.status)
        command.status = "pending"
        command.next_attempt_at = now + timedelta(seconds=30)
        command.last_error = None
        command.failure_kind = None
        await db.commit()
        return PublishChannelPostResponse(
            version_id=row.version_id, scheduled=False, processing=True,
            command_id=command.id, scheduled_at=None,
        )

    await _record_this_attempt(approval_check="ok", adapter_called=True, result_code="published")
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


async def _retry_publication_command(
    db: AsyncSession, *, org_id: uuid.UUID, command_id: uuid.UUID, auth: AuthContext,
) -> RetryPublicationCommandResponse:
    """story #3414 AC5·#3476(페드루 보정②, 미르코 FE 그라운딩 2026-09-05) — 휴먼
    전용, `dead_letter`/`blocked` 상태인 command만 `pending`으로 되돌린다(그 외는
    404로 존재 비노출). `retry_dead_letter_command` 자체가 `content_kind`를 안
    본다(org_id+command_id로만 조회) — channel_post·site_post 양쪽 어느 경로에서
    호출돼도 그대로 맞는다, 이 함수 자체엔 분기 코드가 없다(불필요)."""
    await _require_human(db, auth, org_id)

    from app.services.publication_command import retry_dead_letter_command

    command = await retry_dead_letter_command(db, org_id=org_id, command_id=command_id)
    if command is None:
        raise HTTPException(status_code=404, detail="command를 찾을 수 없거나 재시도 대상이 아닙니다")
    await db.commit()
    return RetryPublicationCommandResponse(id=command.id, status=command.status)


@router.post(
    "/{org_id}/publication-commands/{command_id}/retry",
    response_model=RetryPublicationCommandResponse,
)
async def retry_publication_command_shared_endpoint(
    org_id: uuid.UUID,
    command_id: uuid.UUID,
    db: AsyncSession = Depends(get_db),
    verified_org_id: uuid.UUID = Depends(get_verified_org_id),
    auth: AuthContext = Depends(get_current_user),
) -> RetryPublicationCommandResponse:
    """story #3476(페드루 보정②) — content_kind 무관 공용 경로. 기존
    `/channel-posts/publication-commands/{id}/retry`는 경로 자체에 channel-posts가
    박혀 있어 site_post 화면이 재사용할 수 없었다(미르코 FE 그라운딩). FE의
    새 호출은 전부 이 경로로 옮긴다 — 구 경로는 하위호환으로 이 함수에 위임만."""
    if org_id != verified_org_id:
        raise HTTPException(status_code=403, detail="org_id mismatch")
    return await _retry_publication_command(db, org_id=org_id, command_id=command_id, auth=auth)


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
    **또는 `blocked`**(연결 복구 대기 — 페드루 리뷰 블로커B: 원래 dead_letter만
    받아 owner 재인증 뒤 blocked 예약 명령이 갈 길이 없었다) 상태인 command만 다시
    큐(`pending`)에 올린다 — 그 외 상태(completed·voided 등)는 404로 존재 비노출
    (카디르 QA와 동형 관례, 상태를 굳이 구별해 알려주지 않는다).
    `next_attempt_at`을 null로 되돌려야 다음 cron tick이 이 행을 실제로 다시 집는다
    (status만 바뀌고 next_attempt_at이 미래에 멈춰 있으면 WHERE절에서 계속 빠지는
    결함 — 카디르 QA⑤ 지적 그대로 반영).

    story #3476 — 공용 엔드포인트(`retry_publication_command_shared_endpoint`)로
    위임만(동작 무변, 구 경로 호환 유지 — FE 마이그레이션 전까지 죽이지 않는다)."""
    if org_id != verified_org_id:
        raise HTTPException(status_code=403, detail="org_id mismatch")
    return await _retry_publication_command(db, org_id=org_id, command_id=command_id, auth=auth)


class CancelScheduledCommandResponse(BaseModel):
    command_id: uuid.UUID
    status: str
    reason_code: str | None = None


@router.post(
    "/{org_id}/channel-posts/drafts/{draft_id}/cancel-scheduled",
    response_model=CancelScheduledCommandResponse,
)
async def cancel_scheduled_command_endpoint(
    org_id: uuid.UUID,
    draft_id: uuid.UUID,
    db: AsyncSession = Depends(get_db),
    verified_org_id: uuid.UUID = Depends(get_verified_org_id),
    auth: AuthContext = Depends(get_current_user),
) -> CancelScheduledCommandResponse:
    """story #3419 AC1 — owner/admin 전용(휴먼 전용 안의 좁은 축, `_require_owner_or_admin`
    — 되돌릴 수 있는 파괴적 상태전환이라 발행 자체보다 한 단계 더). 이 draft의 gate에
    걸린 **가장 최근** publication_command가 pending·blocked·dead_letter면 `cancelled`로
    전이한다. 그 외 상태는 409(코드 명시) — «이미 실행 중/끝난 것을 취소하려 했다»를
    정직하게 알린다."""
    if org_id != verified_org_id:
        raise HTTPException(status_code=403, detail="org_id mismatch")
    resolved = await _require_owner_or_admin(db, auth, org_id)

    try:
        command = await cancel_scheduled_publication(
            db, org_id=org_id, draft_id=draft_id, cancelled_by_member_id=resolved.id,
        )
    except ChannelPostDraftNotFoundError as exc:
        raise HTTPException(status_code=404, detail=str(exc)) from exc
    except ChannelPostGateNotFoundError as exc:
        raise HTTPException(status_code=404, detail=str(exc)) from exc
    except PublicationCommandNotFoundError as exc:
        raise HTTPException(
            status_code=404,
            detail={"code": "PUBLICATION_COMMAND_NOT_FOUND", "message": str(exc)},
        ) from exc
    except PublicationCommandNotCancellableError as exc:
        raise HTTPException(
            status_code=409,
            detail={
                "code": "PUBLICATION_COMMAND_NOT_CANCELLABLE", "message": str(exc),
                "current_status": exc.current_status,
            },
        ) from exc

    return CancelScheduledCommandResponse(
        command_id=command.id, status=command.status, reason_code=command.reason_code,
    )


class UnpublishChannelPostResponse(BaseModel):
    publication_id: uuid.UUID
    status: str
    external_id: str | None = None
    unpublished_at: str


@router.post(
    "/{org_id}/channel-posts/drafts/{draft_id}/unpublish", response_model=UnpublishChannelPostResponse,
)
async def unpublish_channel_post_endpoint(
    org_id: uuid.UUID,
    draft_id: uuid.UUID,
    db: AsyncSession = Depends(get_db),
    verified_org_id: uuid.UUID = Depends(get_verified_org_id),
    auth: AuthContext = Depends(get_current_user),
) -> UnpublishChannelPostResponse:
    """story #3419 AC2 — owner/admin 전용(site_posts.py unpublish 관례와 동형). 이
    draft의 gate에서 가장 최근 발행된(status='published') 글을 Threads 공식 삭제
    API로 회수한다. 어댑터 미지원(422)·연결 스코프 부족(422, required_scopes 실림 —
    기존 연결은 threads_delete 스코프 없이 저장돼 있어 재인증 前까지 여기 걸린다,
    PO 確定 ②-a)·연결 비활성(409)·이미 회수/미발행(409)·provider 오류(401/403→토큰
    만료 409, 그 외→502)를 각각 명시 코드로 구분한다."""
    if org_id != verified_org_id:
        raise HTTPException(status_code=403, detail="org_id mismatch")
    resolved = await _require_owner_or_admin(db, auth, org_id)

    try:
        pub = await unpublish_channel_post(
            db, org_id=org_id, draft_id=draft_id, unpublished_by_member_id=resolved.id,
        )
    except ChannelPostDraftNotFoundError as exc:
        raise HTTPException(status_code=404, detail=str(exc)) from exc
    except ChannelPostGateNotFoundError as exc:
        raise HTTPException(status_code=404, detail=str(exc)) from exc
    except ChannelPostNotPublishedError as exc:
        raise HTTPException(
            status_code=409, detail={"code": "CHANNEL_POST_NOT_PUBLISHED", "message": str(exc)},
        ) from exc
    except ChannelUnpublishUnsupportedError as exc:
        raise HTTPException(
            status_code=422, detail={"code": "CHANNEL_UNPUBLISH_UNSUPPORTED", "message": str(exc)},
        ) from exc
    except ChannelScopeInsufficientError as exc:
        raise HTTPException(
            status_code=422,
            detail={
                "code": "CHANNEL_SCOPE_INSUFFICIENT", "message": str(exc),
                "required_scopes": exc.required_scopes,
            },
        ) from exc
    except ChannelConnectionNotActiveError as exc:
        raise HTTPException(
            status_code=409,
            detail={"code": "CHANNEL_CONNECTION_NOT_ACTIVE", "message": str(exc)},
        ) from exc
    except ChannelTokenExpiredError as exc:
        raise HTTPException(
            status_code=409, detail={"code": "CHANNEL_TOKEN_EXPIRED", "message": str(exc)},
        ) from exc
    except ChannelRateLimitedError as exc:
        # story 5b27b32f — 이 핸들러가 원래 빠져 있었다(gap 발견: _classify_threads_error에
        # 429 분기를 추가하니 delete_media 실패도 이제 이 예외를 낼 수 있는데 unpublish
        # 엔드포인트만 못 잡고 있었다 — 발행(publish) 엔드포인트의 기존 핸들러와 동형,
        # 다만 unpublish엔 publication_command가 없어 apply_command_failure 호출은 없다).
        retry_after_seconds = max(0, int((exc.reset_at - datetime.now(timezone.utc)).total_seconds()))
        raise HTTPException(
            status_code=429,
            detail={
                "code": "CHANNEL_RATE_LIMITED", "message": str(exc), "reset_at": exc.reset_at.isoformat(),
            },
            headers={"Retry-After": str(retry_after_seconds)},
        ) from exc
    except ChannelPublishProviderError as exc:
        raise HTTPException(
            status_code=502,
            detail={"code": "CHANNEL_PUBLISH_PROVIDER_ERROR", "message": str(exc)},
        ) from exc

    return UnpublishChannelPostResponse(
        publication_id=pub.id, status=pub.status, external_id=pub.external_id,
        unpublished_at=pub.updated_at.isoformat(),
    )
