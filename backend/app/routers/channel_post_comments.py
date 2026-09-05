"""story #3516(Phase2·마케팅운영, 페드루 PO 確定 2026-09-05) — 댓글 목록+수동 재수집.
블루프린트 v3 §2 「댓글·반응 대응」 MVP 조각①. 답변(reply) 경로는 조각②."""
from __future__ import annotations

import uuid

from fastapi import APIRouter, Depends, HTTPException, Query
from pydantic import BaseModel, Field
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


class CommentReplySummary(BaseModel):
    """조각②-b(additive) — 댓글당 최신 답변 1건 요약(배치 조인, N+1 X). FE 칩
    (무응답/초안/상신/발송 대기/발행/실패)은 이 필드 하나에서 파생 — null=무응답."""
    id: uuid.UUID
    status: str
    external_reply_url: str | None
    command_id: uuid.UUID | None
    # story #3529(additive, 유나 §22-15 채택) — PublicationCommand 4필드 그대로
    # (새 이름/새 값 0). command_id가 null이면 넷 다 null.
    command_status: str | None = Field(
        default=None,
        description=(
            "PublicationCommand.status 그대로 — 다음 할 일이 갈리는 네 값(유나 §22-15): "
            "\"pending\"(백오프 대기 중, 기다리면 자동 재시도) · \"blocked\"(연결 복구 "
            "필요, 사람이 재인증해야 함) · \"dead_letter\"(자동 재시도 포기, 사람 판단 "
            "필요) · \"voided\"(전제가 바뀌어 종결, 재시도 개념 자체가 안 맞음). "
            "그 외 \"completed\" 등은 성공/진행 중."
        ),
    )
    failure_kind: str | None = Field(
        default=None,
        description="유나 design §11-5 세 값(connection|needs_check|transient) — 실패 없었으면 null.",
    )
    next_attempt_at: str | None = Field(
        default=None, description="transient 백오프 다음 시도 시각(ISO) — 없으면 null.",
    )
    reason_code: str | None = Field(
        default=None,
        description=(
            "voided 사유(실재 값 그대로, 새 이름 짓지 않음) — "
            "\"GATE_NOT_APPROVED_OR_RESEALED\"(게이트 재검증 실패) 또는 "
            "\"TARGET_COMMENT_DELETED\"(승인 뒤 워커 도달 前 대상 댓글 삭제 레이스). "
            "voided 아니면 null."
        ),
    )


def _comment_reply_summary(reply, command_by_id: dict) -> CommentReplySummary:
    """story #3529 — command_id가 있으면 배치 조회된 PublicationCommand에서 4필드를
    그대로 옮긴다(command 행 자체가 없으면(레이스·오탐) 4필드 전부 null — fail-closed,
    지어내지 않는다)."""
    command = command_by_id.get(reply.command_id) if reply.command_id is not None else None
    return CommentReplySummary(
        id=reply.id, status=reply.status, external_reply_url=reply.external_reply_url,
        command_id=reply.command_id,
        command_status=command.status if command is not None else None,
        failure_kind=command.failure_kind if command is not None else None,
        next_attempt_at=(
            command.next_attempt_at.isoformat() if command is not None and command.next_attempt_at else None
        ),
        reason_code=command.reason_code if command is not None else None,
    )


class CommentItem(BaseModel):
    id: uuid.UUID
    external_comment_id: str
    author_display_name: str | None
    text: str
    external_created_at: str | None
    captured_at: str
    deleted_at: str | None
    reply: CommentReplySummary | None = None


class CommentListResponse(BaseModel):
    # story #3516 — null="미수집"(한 번도 captured 없음)·값="가장 최근 수집 시각"
    # (그 시각의 댓글 수가 0이어도 이 필드는 채워진다 — null≠0 원칙 그대로).
    last_collected_at: str | None
    comments: list[CommentItem]
    # 페드루 PO REQUIRED(2026-09-05, PR#3865 리뷰, 유나 §22-9) — 페이지(limit/offset)
    # 무관 서버 전체 수. active_count는 insights_board.py comments_count와 정의가
    # 완전히 같다(deleted_at IS NULL, count_comments_by_publication_ids 재사용).
    active_count: int
    deleted_count: int
    # 조각②-b 추가(유나 16회차, additive) — publication당 refresh 5분 창의 다음
    # 허용 시각. null=지금 바로 재수집 가능. last_collected_at과 같은 계산 자리
    # (다른 세션이 누른 429 창을 로드 시점에 화면이 미리 알게 — 버튼 비활성+사유).
    comments_next_allowed_at: str | None = None


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

    reply_by_comment_id = result["reply_by_comment_id"]
    command_by_id = result["command_by_id"]
    return CommentListResponse(
        last_collected_at=result["last_collected_at"].isoformat() if result["last_collected_at"] else None,
        comments=[
            CommentItem(
                id=c.id, external_comment_id=c.external_comment_id, author_display_name=c.author_display_name,
                text=c.text, external_created_at=c.external_created_at.isoformat() if c.external_created_at else None,
                captured_at=c.captured_at.isoformat(), deleted_at=c.deleted_at.isoformat() if c.deleted_at else None,
                reply=(
                    _comment_reply_summary(reply_by_comment_id[c.id], command_by_id)
                    if c.id in reply_by_comment_id else None
                ),
            )
            for c in result["comments"]
        ],
        active_count=result["active_count"], deleted_count=result["deleted_count"],
        comments_next_allowed_at=(
            result["comments_next_allowed_at"].isoformat() if result["comments_next_allowed_at"] else None
        ),
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
