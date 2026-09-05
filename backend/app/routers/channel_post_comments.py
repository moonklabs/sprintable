"""story #3516(Phase2·마케팅운영, 페드루 PO 確定 2026-09-05) — 댓글 목록+수동 재수집.
블루프린트 v3 §2 「댓글·반응 대응」 MVP 조각①. 답변(reply) 경로는 조각②."""
from __future__ import annotations

import uuid

from fastapi import APIRouter, Depends, HTTPException, Query
from pydantic import BaseModel
from sqlalchemy.ext.asyncio import AsyncSession

from app.dependencies.auth import AuthContext, get_current_user, get_verified_org_id
from app.dependencies.database import get_db
from app.services.channel_post_comments import (
    CommentCollectionUnsupportedError,
    CommentFetchError,
    CommentPublicationNotFoundError,
    CommentRefreshRateLimitedError,
    list_comments_for_publication,
    refresh_comments_now,
)
from app.services.member_resolver import resolve_member

router = APIRouter(prefix="/api/v2/organizations", tags=["channel-post-comments"])


async def _require_human(db: AsyncSession, auth: AuthContext, org_id: uuid.UUID):
    """story #3516 AC4 — 목록 GET은 에이전트도 가능(읽기), 수동 재수집은 휴먼 전용
    (channel_posts.py::_require_human과 동형 권한 폭 — 발행류 액션은 항상 휴먼)."""
    resolved = await resolve_member(auth, org_id, db)
    if resolved.type != "human":
        raise HTTPException(
            status_code=403,
            detail={
                "code": "COMMENT_REFRESH_HUMAN_ONLY",
                "message": "댓글 재수집은 휴먼 멤버만 가능합니다.",
            },
        )
    return resolved


class CommentItem(BaseModel):
    id: uuid.UUID
    external_comment_id: str
    author_display_name: str | None
    text: str
    external_created_at: str | None
    captured_at: str
    deleted_at: str | None


class CommentListResponse(BaseModel):
    # story #3516 — null="미수집"(한 번도 captured 없음)·값="가장 최근 수집 시각"
    # (그 시각의 댓글 수가 0이어도 이 필드는 채워진다 — null≠0 원칙 그대로).
    last_collected_at: str | None
    comments: list[CommentItem]


class CommentRefreshResponse(BaseModel):
    fetched: int
    deleted: int
    captured_at: str


@router.get(
    "/{org_id}/publications/{publication_id}/comments", response_model=CommentListResponse,
)
async def list_publication_comments_endpoint(
    org_id: uuid.UUID,
    publication_id: uuid.UUID,
    limit: int = Query(default=50, ge=1, le=200),
    offset: int = Query(default=0, ge=0),
    db: AsyncSession = Depends(get_db),
    verified_org_id: uuid.UUID = Depends(get_verified_org_id),
    auth: AuthContext = Depends(get_current_user),
) -> CommentListResponse:
    """조직 멤버(휴먼·에이전트 모두) 읽기 가능 — 댓글 열람은 승인·발행 경계 밖(story
    #3516 AC4, 목록/단건 조회 관례와 동형)."""
    if org_id != verified_org_id:
        raise HTTPException(status_code=403, detail="org_id mismatch")

    try:
        result = await list_comments_for_publication(
            db, org_id=org_id, publication_id=publication_id, limit=limit, offset=offset,
        )
    except CommentPublicationNotFoundError as exc:
        raise HTTPException(status_code=404, detail=f"발행 기록을 찾을 수 없습니다: {publication_id}") from exc

    return CommentListResponse(
        last_collected_at=result["last_collected_at"].isoformat() if result["last_collected_at"] else None,
        comments=[
            CommentItem(
                id=c.id, external_comment_id=c.external_comment_id, author_display_name=c.author_display_name,
                text=c.text, external_created_at=c.external_created_at.isoformat() if c.external_created_at else None,
                captured_at=c.captured_at.isoformat(), deleted_at=c.deleted_at.isoformat() if c.deleted_at else None,
            )
            for c in result["comments"]
        ],
    )


@router.post(
    "/{org_id}/publications/{publication_id}/comments/refresh", response_model=CommentRefreshResponse,
)
async def refresh_publication_comments_endpoint(
    org_id: uuid.UUID,
    publication_id: uuid.UUID,
    db: AsyncSession = Depends(get_db),
    verified_org_id: uuid.UUID = Depends(get_verified_org_id),
    auth: AuthContext = Depends(get_current_user),
) -> CommentRefreshResponse:
    """PO 決定 — publication당 5분에 1회(그 이내 재요청은 429). 지속 폴링/커서는
    후속 스코프."""
    if org_id != verified_org_id:
        raise HTTPException(status_code=403, detail="org_id mismatch")
    await _require_human(db, auth, org_id)

    try:
        result = await refresh_comments_now(db, org_id=org_id, publication_id=publication_id)
    except CommentRefreshRateLimitedError as exc:
        raise HTTPException(
            status_code=429,
            detail={"code": "COMMENT_REFRESH_RATE_LIMITED", "message": str(exc)},
            headers={"Retry-After": str(exc.retry_after_seconds)},
        ) from exc
    except CommentCollectionUnsupportedError as exc:
        raise HTTPException(
            status_code=422,
            detail={"code": "COMMENT_COLLECTION_UNSUPPORTED", "message": "이 채널은 댓글 수집을 지원하지 않습니다."},
        ) from exc
    except CommentFetchError as exc:
        if exc.error_code == "COMMENT_PUBLICATION_NOT_FOUND":
            raise HTTPException(status_code=404, detail=str(exc)) from exc
        raise HTTPException(status_code=502, detail={"code": exc.error_code, "message": str(exc)}) from exc

    return CommentRefreshResponse(
        fetched=result["fetched"], deleted=result["deleted"], captured_at=result["captured_at"].isoformat(),
    )
