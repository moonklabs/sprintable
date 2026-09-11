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
대안 채택)."""
from __future__ import annotations

import uuid

from fastapi import APIRouter, Depends, HTTPException, Query
from pydantic import BaseModel
from sqlalchemy.ext.asyncio import AsyncSession

from app.core.error_envelope import human_error
from app.dependencies.auth import AuthContext, get_current_user, get_verified_org_id
from app.dependencies.database import get_db
from app.services.channel_post_comments import (
    EngagementItemInvalidStatusError,
    EngagementItemNotFoundError,
    get_engagement_collection_status,
    list_engagement_items,
    patch_engagement_item,
)
from app.services.member_resolver import resolve_member

router = APIRouter(prefix="/api/v2/organizations", tags=["engagement-items"])


async def _require_human(db: AsyncSession, auth: AuthContext, org_id: uuid.UUID):
    """PATCH(배정·상태 변경)는 휴먼 전용 — channel_post_comments.py::_require_human과
    동형(그라운딩 PO 確定: 에이전트 키는 목록·collection-status 읽기만)."""
    resolved = await resolve_member(auth, org_id, db)
    if resolved.type != "human":
        raise HTTPException(
            status_code=403,
            detail=human_error(
                "ENGAGEMENT_ITEM_PATCH_HUMAN_ONLY", "반응 항목의 배정·상태 변경은 휴먼 멤버만 가능합니다.",
                user_message="반응 항목의 배정·상태 변경은 휴먼 멤버만 가능합니다.",
            ),
        )
    return resolved


class EngagementItemResponse(BaseModel):
    id: uuid.UUID
    publication_id: uuid.UUID
    channel: str
    external_comment_id: str
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


def _item_response(c) -> EngagementItemResponse:
    return EngagementItemResponse(
        id=c.id, publication_id=c.publication_id, channel=c.channel, external_comment_id=c.external_comment_id,
        author_display_name=c.author_display_name, text=c.text, captured_at=c.captured_at.isoformat(),
        triage_status=c.triage_status, assignee_member_id=c.assignee_member_id, linked_story_id=c.linked_story_id,
    )


@router.get("/{org_id}/engagement/items", response_model=EngagementItemListResponse)
async def list_engagement_items_endpoint(
    org_id: uuid.UUID,
    status: str | None = Query(default=None),
    channel: str | None = Query(default=None),
    cursor: str | None = Query(default=None),
    limit: int = Query(default=50, ge=1, le=200),
    db: AsyncSession = Depends(get_db),
    verified_org_id: uuid.UUID = Depends(get_verified_org_id),
    auth: AuthContext = Depends(get_current_user),
) -> EngagementItemListResponse:
    """조직 멤버(휴먼·에이전트 모두) 읽기 가능 — 댓글 열람 관례(3516 AC4)와 동형.
    limit/offset이 아니라 cursor(그라운딩 ① — 3713류 재발 방지)."""
    if org_id != verified_org_id:
        raise HTTPException(status_code=403, detail="org_id mismatch")

    result = await list_engagement_items(
        db, org_id=org_id, status=status, channel=channel, cursor=cursor, limit=limit,
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
) -> EngagementItemResponse:
    if org_id != verified_org_id:
        raise HTTPException(status_code=403, detail="org_id mismatch")
    await _require_human(db, auth, org_id)

    fields_set = body.model_fields_set
    try:
        comment = await patch_engagement_item(
            db, org_id=org_id, comment_id=comment_id,
            triage_status=body.triage_status,
            assignee_member_id=body.assignee_member_id,
            assignee_member_id_set="assignee_member_id" in fields_set,
        )
    except EngagementItemNotFoundError as exc:
        raise HTTPException(status_code=404, detail=f"반응 항목을 찾을 수 없습니다: {comment_id}") from exc
    except EngagementItemInvalidStatusError as exc:
        raise HTTPException(
            status_code=422,
            detail=human_error(
                "ENGAGEMENT_ITEM_INVALID_STATUS", str(exc),
                user_message="알 수 없는 처리 상태입니다.",
            ),
        ) from exc

    return _item_response(comment)


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
