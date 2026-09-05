"""story #3502(Phase2·마케팅운영, 페드루 PO 確定 2026-09-05) — 성과 보드 API. GET은
publishing_metrics.py·insight_snapshots.py와 동형 권한 축(org 멤버 누구나 — 휴먼·
에이전트 모두, write 없음). POST(후속 작업 생성)는 campaigns.py::_require_human과
동형 — 휴먼 전용(에이전트는 표를 보고 제안만 할 뿐 스토리를 직접 못 만든다)."""
from __future__ import annotations

import uuid
from datetime import datetime
from typing import Any, Literal

from fastapi import APIRouter, Depends, HTTPException, Query
from pydantic import BaseModel
from sqlalchemy.ext.asyncio import AsyncSession

from app.dependencies.auth import AuthContext, get_current_user, get_verified_org_id
from app.dependencies.database import get_db
from app.services.insights_board import (
    FollowUpInvalidKindError,
    FollowUpPublicationNotFoundError,
    InsightsBoardInvalidSortError,
    InsightsBoardInvalidWindowError,
    create_publication_follow_up,
    list_insights_board,
)
from app.services.member_resolver import resolve_member

router = APIRouter(prefix="/api/v2/organizations", tags=["insights-board"])


async def _require_human(db: AsyncSession, auth: AuthContext, org_id: uuid.UUID):
    """campaigns.py::_require_human과 동형 — 추가 role 제한 없음(org 멤버인 휴먼이면
    누구나), 에이전트는 403."""
    resolved = await resolve_member(auth, org_id, db)
    if resolved.type != "human":
        raise HTTPException(
            status_code=403,
            detail={
                "code": "FOLLOW_UP_CREATE_HUMAN_ONLY",
                "message": "후속 작업 생성은 휴먼 멤버만 가능합니다(에이전트는 조회만).",
            },
        )
    return resolved


class InsightSnapshotBucketView(BaseModel):
    status: str
    normalized: dict[str, int | None] | None
    captured_at: datetime | None


class InsightsBoardRow(BaseModel):
    publication_id: uuid.UUID
    kind: Literal["site_post", "channel_publication"]
    channel: str
    work_item_id: uuid.UUID
    title: str
    published_at: datetime
    external_url: str | None
    connection_id: uuid.UUID | None
    d1: InsightSnapshotBucketView | None
    d7: InsightSnapshotBucketView | None
    # story #3516 — null="site_post(댓글 개념 없음)"·정수="channel_publication의 지금
    # 댓글 수"(미수집·0건 둘 다 0 — 정밀 구분은 댓글 목록 API 몫).
    comments_count: int | None = None


class InsightsBoardResponse(BaseModel):
    rows: list[InsightsBoardRow]
    has_more: bool
    next_cursor: str | None


@router.get("/{org_id}/insights-board", response_model=InsightsBoardResponse)
async def get_insights_board_endpoint(
    org_id: uuid.UUID,
    window: str = Query(default="30d"),
    channel: str | None = Query(default=None),
    status: str | None = Query(default=None),
    sort: str = Query(default="published_at"),
    sort_dir: str = Query(default="desc"),
    cursor: str | None = Query(default=None),
    limit: int = Query(default=50, ge=1, le=200),
    db: AsyncSession = Depends(get_db),
    verified_org_id: uuid.UUID = Depends(get_verified_org_id),
    _auth: AuthContext = Depends(get_current_user),
) -> InsightsBoardResponse:
    if org_id != verified_org_id:
        raise HTTPException(status_code=403, detail="org_id mismatch")

    try:
        result = await list_insights_board(
            db, org_id=org_id, window=window, channel=channel, status=status,
            sort=sort, sort_dir=sort_dir, cursor=cursor, limit=limit,
        )
    except InsightsBoardInvalidWindowError as exc:
        raise HTTPException(
            status_code=422,
            detail={"code": "INSIGHTS_BOARD_INVALID_WINDOW", "message": f"window must be 7d, 30d or 90d: {exc}"},
        ) from exc
    except InsightsBoardInvalidSortError as exc:
        raise HTTPException(
            status_code=422,
            detail={"code": "INSIGHTS_BOARD_INVALID_SORT", "message": str(exc)},
        ) from exc
    return InsightsBoardResponse(**result)


class CreateFollowUpRequest(BaseModel):
    kind: Literal["republish", "edit", "stop"]
    title: str | None = None
    note: str | None = None


class FollowUpCreateResponse(BaseModel):
    story_id: uuid.UUID


@router.post(
    "/{org_id}/publications/{publication_id}/follow-ups", response_model=FollowUpCreateResponse, status_code=201,
)
async def create_publication_follow_up_endpoint(
    org_id: uuid.UUID,
    publication_id: uuid.UUID,
    body: CreateFollowUpRequest,
    db: AsyncSession = Depends(get_db),
    verified_org_id: uuid.UUID = Depends(get_verified_org_id),
    auth: AuthContext = Depends(get_current_user),
) -> FollowUpCreateResponse:
    if org_id != verified_org_id:
        raise HTTPException(status_code=403, detail="org_id mismatch")
    resolved = await _require_human(db, auth, org_id)

    try:
        result = await create_publication_follow_up(
            db, org_id=org_id, publication_id=publication_id, kind=body.kind,
            title=body.title, note=body.note, requested_by_member_id=resolved.id,
        )
    except FollowUpPublicationNotFoundError as exc:
        raise HTTPException(status_code=404, detail=f"publication을 찾을 수 없습니다: {exc}") from exc
    except FollowUpInvalidKindError as exc:
        raise HTTPException(
            status_code=422,
            detail={"code": "FOLLOW_UP_INVALID_KIND", "message": str(exc)},
        ) from exc
    return FollowUpCreateResponse(**result)
