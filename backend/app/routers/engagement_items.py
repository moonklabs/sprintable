"""story #3805(Phase3·3-1, 페드루 PO 確定 2026-09-11) — 「반응」(Engagement) PR
1[BE]. 첫 출시 범위=댓글+답글만(그라운딩 ②·PO 確定: 멘션·DM은 어댑터·모델 0+App
Review scope 미확認이라 2차, 큐 항목 종류 예약값을 코드에 두지 않는다). org 단위
큐 목록·배정·상태 변경·연결별 수집 현황 셋 — service는 channel_post_comments.py에
얹는다(같은 테이블이 원본이라 두 번째 서비스 모듈을 새로 열지 않음).

08:14Z 낱말 정정(라우트 쓰기 前 PO 確定) — 화면 이름 「반응」(en Engagement), 채널
포스트 화면의 뷰 하나(목록·캘린더 옆, 새 사이드바 항목 0). 라우트도 이 이름으로
(`/inbox`는 알림이 이미 점유): FE `/content/channel-posts/engagement` · BE
`GET/PATCH /{org}/engagement/items` · `GET /{org}/engagement/collection-status`.
상태 4 enum 중 4번째 값은 `skipped`(ko 「넘김」·en Skipped — `ignored` 대신, 유나
대안 채택).

PR 3(페드루 PO 確定 2026-09-11 09:31Z) — 답글 편입. 응답에 `kind`(comment|reply)
판별자 추가. PATCH path segment 이름은 하위호환 위해 `{comment_id}` 그대로 두되
(FE BFF가 이미 그 이름으로 배선돼 있다 — 새 라우트 0) 실제로는 comment_id 또는
reply_id 어느 쪽이든 받는다(서비스 레이어가 두 테이블을 다 본다)."""
from __future__ import annotations

import uuid

from fastapi import APIRouter, Depends, Header, HTTPException, Query
from pydantic import BaseModel
from sqlalchemy.ext.asyncio import AsyncSession

from app.core.error_envelope import human_error
from app.dependencies.auth import AuthContext, get_current_user, get_verified_org_id
from app.dependencies.database import get_db
from app.services.agent_onboarding_config import resolve_locale_from_request
from app.services.channel_post_comments import (
    EngagementItemInvalidStatusError,
    EngagementItemNotFoundError,
    resolve_engagement_item_org_id,
    get_engagement_collection_status,
    list_engagement_items,
    patch_engagement_item,
)
from app.services.i18n_catalog import t
from app.services.member_resolver import resolve_member
from app.services.project_auth import assert_target_in_caller_org

router = APIRouter(prefix="/api/v2/organizations", tags=["engagement-items"])


async def _require_human(db: AsyncSession, auth: AuthContext, org_id: uuid.UUID, resolved_locale: str):
    """PATCH(배정·상태 변경)는 휴먼 전용 — channel_post_comments.py::_require_human과
    동형(그라운딩 PO 確定: 에이전트 키는 목록·collection-status 읽기만). `resolved_locale`
    은 호출부(라우트 진입점)가 이미 resolve_locale_from_request()로 푼 plain str(Header()
    마커가 라우트 경계를 못 넘는다, i18n_catalog.py 모듈 docstring 원칙)."""
    resolved = await resolve_member(auth, org_id, db)
    if resolved.type != "human":
        message = t("engagement_items.patch_human_only", resolved_locale)
        raise HTTPException(
            status_code=403,
            detail=human_error("ENGAGEMENT_ITEM_PATCH_HUMAN_ONLY", message, user_message=message),
        )
    return resolved


class EngagementItemResponse(BaseModel):
    id: uuid.UUID
    kind: str
    publication_id: uuid.UUID
    channel: str
    external_comment_id: str | None
    author_display_name: str | None
    text: str
    captured_at: str
    triage_status: str
    assignee_member_id: uuid.UUID | None
    linked_story_id: uuid.UUID | None


class EngagementItemListResponse(BaseModel):
    items: list[EngagementItemResponse]
    has_more: bool
    next_cursor: str | None


class EngagementItemPatchRequest(BaseModel):
    triage_status: str | None = None
    assignee_member_id: uuid.UUID | None = None


class EngagementCollectionStatusItem(BaseModel):
    connection_id: uuid.UUID
    channel: str
    account_label: str | None
    last_collected_at: str | None


class EngagementCollectionStatusResponse(BaseModel):
    connections: list[EngagementCollectionStatusItem]


def _item_response(c: dict) -> EngagementItemResponse:
    return EngagementItemResponse(
        id=c["id"], kind=c["kind"], publication_id=c["publication_id"], channel=c["channel"],
        external_comment_id=c["external_comment_id"], author_display_name=c["author_display_name"],
        text=c["text"], captured_at=c["captured_at"].isoformat(),
        triage_status=c["triage_status"], assignee_member_id=c["assignee_member_id"],
        linked_story_id=c["linked_story_id"],
    )


@router.get("/{org_id}/engagement/items", response_model=EngagementItemListResponse)
async def list_engagement_items_endpoint(
    org_id: uuid.UUID,
    status: str | None = Query(default=None),
    channel: str | None = Query(default=None),
    kind: str | None = Query(default=None),
    cursor: str | None = Query(default=None),
    limit: int = Query(default=50, ge=1, le=200),
    db: AsyncSession = Depends(get_db),
    verified_org_id: uuid.UUID = Depends(get_verified_org_id),
    auth: AuthContext = Depends(get_current_user),
) -> EngagementItemListResponse:
    """조직 멤버(휴먼·에이전트 모두) 읽기 가능 — 댓글 열람 관례(3516 AC4)와 동형.
    limit/offset이 아니라 cursor(그라운딩 ① — 3713류 재발 방지). PR 3(답글 편입)
    — `kind`(comment|reply) 필터 추가, 생략하면 두 갈래 다(UNION)."""
    if org_id != verified_org_id:
        raise HTTPException(status_code=403, detail="org_id mismatch")

    result = await list_engagement_items(
        db, org_id=org_id, status=status, channel=channel, kind=kind, cursor=cursor, limit=limit,
    )

    return EngagementItemListResponse(
        items=[_item_response(c) for c in result["items"]],
        has_more=result["has_more"], next_cursor=result["next_cursor"],
    )


@router.patch("/{org_id}/engagement/items/{comment_id}", response_model=EngagementItemResponse)
async def patch_engagement_item_endpoint(
    org_id: uuid.UUID,
    comment_id: uuid.UUID,
    body: EngagementItemPatchRequest,
    db: AsyncSession = Depends(get_db),
    verified_org_id: uuid.UUID = Depends(get_verified_org_id),
    auth: AuthContext = Depends(get_current_user),
    locale: str | None = None,
    accept_language: str | None = Header(None, alias="Accept-Language"),
) -> EngagementItemResponse:
    """CI 정정(2026-09-11) — `Header()` DI 마커는 라우트 진입점에서만 받는다(까심 QA
    CI FAILURE 원칙, i18n_catalog.py 모듈 docstring). 이 함수를 직접 호출하는 테스트가
    없어(전부 HTTP 클라이언트 경유) gates.py류의 `_xxx_endpoint` 내부 분리는 불요.

    CI 정정 ②(2026-09-11, 카디르 실측·페드루 전달) — PATH_ID 뮤테이션 축 가드: path
    `comment_id`를 org 스코프 없이 그대로 받는 PATCH라 정적 스캐너가 미가드로 잡는다.
    `assert_target_in_caller_org`(project_auth.py, IDOR 방어 공용 지점)로 대상의
    실제 org_id를 caller org와 대조 — 존재 비노출 404(assets.py::_scope_filter·
    channel_posts.py 형제 패턴과 동형, allowlist 등재가 아니라 실 가드로 해소). project
    access(has_project_access)까지는 이 스토리 범위 밖(댓글 계열 전체가 org 스코프뿐 —
    별건, 페드루 확認).

    PR 3(답글 편입) — path segment 이름은 하위호환 위해 `comment_id` 그대로지만
    실제로는 comment_id 또는 reply_id 어느 쪽이든 받는다(`resolve_engagement_item_
    org_id`가 두 테이블 다 본다 — 새 라우트 0)."""
    if org_id != verified_org_id:
        raise HTTPException(status_code=403, detail="org_id mismatch")
    resolved_locale = resolve_locale_from_request(locale, accept_language)
    await _require_human(db, auth, org_id, resolved_locale)

    target_org_id = await resolve_engagement_item_org_id(db, comment_id)
    assert_target_in_caller_org(
        org_id, target_org_id, not_found_detail=t("engagement_items.not_found", resolved_locale),
    )

    fields_set = body.model_fields_set
    try:
        item = await patch_engagement_item(
            db, org_id=org_id, item_id=comment_id,
            triage_status=body.triage_status,
            assignee_member_id=body.assignee_member_id,
            assignee_member_id_set="assignee_member_id" in fields_set,
        )
    except EngagementItemNotFoundError as exc:
        raise HTTPException(
            status_code=404, detail=t("engagement_items.not_found", resolved_locale),
        ) from exc
    except EngagementItemInvalidStatusError as exc:
        message = t("engagement_items.invalid_status", resolved_locale)
        raise HTTPException(
            status_code=422,
            detail=human_error("ENGAGEMENT_ITEM_INVALID_STATUS", str(exc), user_message=message),
        ) from exc

    return _item_response(item)


@router.get("/{org_id}/engagement/collection-status", response_model=EngagementCollectionStatusResponse)
async def get_engagement_collection_status_endpoint(
    org_id: uuid.UUID,
    db: AsyncSession = Depends(get_db),
    verified_org_id: uuid.UUID = Depends(get_verified_org_id),
    auth: AuthContext = Depends(get_current_user),
) -> EngagementCollectionStatusResponse:
    """조직 멤버(휴먼·에이전트 모두) 읽기 가능. null=이 연결로 수집이 한 번도 성공한
    적 없음(그라운딩 ⑤ — 「수집 안 됨≠0」)."""
    if org_id != verified_org_id:
        raise HTTPException(status_code=403, detail="org_id mismatch")

    rows = await get_engagement_collection_status(db, org_id=org_id)
    return EngagementCollectionStatusResponse(
        connections=[
            EngagementCollectionStatusItem(
                connection_id=r["connection_id"], channel=r["channel"], account_label=r["account_label"],
                last_collected_at=r["last_collected_at"].isoformat() if r["last_collected_at"] else None,
            )
            for r in rows
        ],
    )
