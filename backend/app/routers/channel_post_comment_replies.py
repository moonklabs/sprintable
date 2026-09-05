"""story #3516 조각②(Phase2·마케팅운영, 페드루 PO 確定 2026-09-05) — 댓글 「작업으로
전환」+ 답변 초안/상신/조회. 승인·발행은 gates.py(범용 게이트 전이)·publication_
command.py(워커)가 이어받는다 — 이 라우터는 draft/submit/read까지만."""
from __future__ import annotations

import uuid

from fastapi import APIRouter, Depends, HTTPException
from pydantic import BaseModel, Field
from sqlalchemy.ext.asyncio import AsyncSession

from app.dependencies.auth import AuthContext, get_current_user, get_verified_org_id
from app.dependencies.database import get_db
from app.services.channel_post_comment_replies import (
    CommentNotFoundError,
    CommentReplyChannelUnsupportedError,
    CommentReplyNotFoundError,
    CommentReplyTargetDeletedError,
    CommentReplyWrongStatusError,
    create_comment_follow_up,
    create_comment_reply_draft,
    get_comment_reply_view,
    submit_comment_reply,
)
from app.services.member_resolver import resolve_member
from app.services.site_posts import is_agent_caller

router = APIRouter(prefix="/api/v2/organizations", tags=["channel-post-comment-replies"])


async def _require_human(db: AsyncSession, auth: AuthContext, org_id: uuid.UUID):
    """channel_post_comments.py::_require_human과 동형(발행류 액션은 항상 휴먼)."""
    resolved = await resolve_member(auth, org_id, db)
    if resolved.type != "human":
        raise HTTPException(
            status_code=403,
            detail={"code": "COMMENT_REPLY_HUMAN_ONLY", "message": "이 액션은 휴먼 멤버만 가능합니다."},
        )
    return resolved


class CreateFollowUpRequest(BaseModel):
    title: str
    note: str | None = None


class CreateFollowUpResponse(BaseModel):
    story_id: uuid.UUID


@router.post(
    "/{org_id}/comments/{comment_id}/follow-ups", response_model=CreateFollowUpResponse, status_code=201,
    summary="댓글을 story로 전환",
)
async def create_comment_follow_up_endpoint(
    org_id: uuid.UUID,
    comment_id: uuid.UUID,
    body: CreateFollowUpRequest,
    db: AsyncSession = Depends(get_db),
    verified_org_id: uuid.UUID = Depends(get_verified_org_id),
    auth: AuthContext = Depends(get_current_user),
) -> CreateFollowUpResponse:
    """AC2 — 댓글을 story로 전환. 휴먼 전용(insights_board.py::create_publication_
    follow_up_endpoint와 동형 권한 폭). `title`은 서버가 기본값을 안 짓는다 —
    FE가 「[댓글] {게시물 제목}」 prefill을 책임지고, 여기엔 필수 값으로 온다.

    에러: `403 COMMENT_REPLY_HUMAN_ONLY`(에이전트 호출) · `404`(comment_id 없음/
    다른 org 소속)."""
    if org_id != verified_org_id:
        raise HTTPException(status_code=403, detail="org_id mismatch")
    resolved = await _require_human(db, auth, org_id)

    try:
        result = await create_comment_follow_up(
            db, org_id=org_id, comment_id=comment_id, title=body.title, note=body.note,
            requested_by_member_id=resolved.id,
        )
    except CommentNotFoundError as exc:
        raise HTTPException(status_code=404, detail=f"댓글을 찾을 수 없습니다: {comment_id}") from exc
    return CreateFollowUpResponse(**result)


class ReplyView(BaseModel):
    id: uuid.UUID
    comment_id: uuid.UUID
    text: str
    # 'draft'|'pending'|'approved'|'sent'|'failed'(channel_post_comment.py 모델 docstring 그대로).
    status: str
    gate_id: uuid.UUID | None
    external_reply_id: str | None
    external_reply_url: str | None
    last_error: str | None
    target_comment_state: str | None = Field(
        default=None,
        description=(
            "AC4 — 대상 댓글 상태를 읽는 시점에 계산(저장 안 함). null=아직 게이트가 "
            "없다(draft, 판정 대상 아님). \"current\"=봉인 시점과 동일. \"changed\"="
            "대상 댓글 본문이 봉인 이후 바뀜(sha 불일치) — 승인은 가능하나 이 사실이 "
            "실린다. \"deleted\"=대상 댓글이 삭제됨 — submit·approve 모두 409로 막힌다"
            "(deleted가 changed보다 우선)."
        ),
    )


def _reply_view(reply, target_comment_state: str | None) -> ReplyView:
    return ReplyView(
        id=reply.id, comment_id=reply.comment_id, text=reply.text, status=reply.status, gate_id=reply.gate_id,
        external_reply_id=reply.external_reply_id, external_reply_url=reply.external_reply_url,
        last_error=reply.last_error, target_comment_state=target_comment_state,
    )


class CreateReplyDraftRequest(BaseModel):
    text: str


@router.post(
    "/{org_id}/comments/{comment_id}/replies", response_model=ReplyView, status_code=201,
    summary="답변 초안 생성(에이전트 가능)",
)
async def create_comment_reply_draft_endpoint(
    org_id: uuid.UUID,
    comment_id: uuid.UUID,
    body: CreateReplyDraftRequest,
    db: AsyncSession = Depends(get_db),
    verified_org_id: uuid.UUID = Depends(get_verified_org_id),
    auth: AuthContext = Depends(get_current_user),
) -> ReplyView:
    """AC3 초안 — 에이전트도 가능(승인·발행은 human-only, submit부터). 작성 주체는
    인증 컨텍스트에서 서버가 판정(site_posts.py::submit_site_post_draft_version_
    endpoint와 동형 — body에 author 필드 자체가 없다). 답변 본문 편집 엔드포인트는
    없다 — 초안을 고치려면 새로 만든다(재상신/기존 행 수정 API 0, MVP 스코프 절제).

    에러: `404`(comment_id 없음/다른 org 소속). 이 답변 초안 상태는 항상 `status=
    "draft"`·`target_comment_state=null`(아직 게이트가 없어 판정 대상 아님)로 응답."""
    if org_id != verified_org_id:
        raise HTTPException(status_code=403, detail="org_id mismatch")

    member_id = uuid.UUID(auth.user_id)
    created_by_kind = "agent" if await is_agent_caller(db, org_id=org_id, member_id=member_id) else "human"

    try:
        reply = await create_comment_reply_draft(
            db, org_id=org_id, comment_id=comment_id, text=body.text,
            created_by_member_id=member_id, created_by_kind=created_by_kind,
        )
    except CommentNotFoundError as exc:
        raise HTTPException(status_code=404, detail=f"댓글을 찾을 수 없습니다: {comment_id}") from exc
    return _reply_view(reply, None)


@router.post(
    "/{org_id}/comments/{comment_id}/replies/{reply_id}/submit", response_model=ReplyView,
    summary="답변 상신(휴먼 전용) — external_publish 게이트 생성",
)
async def submit_comment_reply_endpoint(
    org_id: uuid.UUID,
    comment_id: uuid.UUID,
    reply_id: uuid.UUID,
    db: AsyncSession = Depends(get_db),
    verified_org_id: uuid.UUID = Depends(get_verified_org_id),
    auth: AuthContext = Depends(get_current_user),
) -> ReplyView:
    """AC3 상신 — 휴먼 전용. external_publish 게이트(scope_key="comment:{comment_id}")
    를 만들고 봉인한다(봉인=답변 본문 sha+대상 댓글 external id+대상 댓글 text sha256).
    승인은 이 라우터가 아니라 범용 `POST /api/v2/gates/{gate_id}/transition`에서
    한다(gate_id는 이 응답에 실린다) — 신규 승인 엔드포인트 0.

    에러: `404`(reply_id 없음) · `422 COMMENT_REPLY_WRONG_STATUS`(draft가 아닌
    상태에서 재상신 시도) · `409 COMMENT_REPLY_TARGET_DELETED`(대상 댓글이 이미
    삭제됨, AC4) · `422 COMMENT_REPLY_CHANNEL_UNSUPPORTED`(이 채널 어댑터가
    `supports_reply=False`)."""
    if org_id != verified_org_id:
        raise HTTPException(status_code=403, detail="org_id mismatch")
    resolved = await _require_human(db, auth, org_id)

    try:
        reply = await submit_comment_reply(db, org_id=org_id, reply_id=reply_id, requester_member_id=resolved.id)
    except CommentReplyNotFoundError as exc:
        raise HTTPException(status_code=404, detail=f"답변을 찾을 수 없습니다: {reply_id}") from exc
    except CommentReplyWrongStatusError as exc:
        raise HTTPException(
            status_code=422, detail={"code": "COMMENT_REPLY_WRONG_STATUS", "message": str(exc)},
        ) from exc
    except CommentReplyTargetDeletedError as exc:
        raise HTTPException(
            status_code=409,
            detail={"code": "COMMENT_REPLY_TARGET_DELETED", "message": "답변 대상 댓글이 삭제되어 상신할 수 없습니다."},
        ) from exc
    except CommentReplyChannelUnsupportedError as exc:
        raise HTTPException(
            status_code=422,
            detail={"code": "COMMENT_REPLY_CHANNEL_UNSUPPORTED", "message": "이 채널은 답변 발송을 지원하지 않습니다."},
        ) from exc

    view = await get_comment_reply_view(db, org_id=org_id, reply_id=reply.id)
    return _reply_view(view["reply"], view["target_comment_state"])


@router.get(
    "/{org_id}/comments/{comment_id}/replies/{reply_id}", response_model=ReplyView,
    summary="답변 단건 조회(에이전트 가능) — target_comment_state 포함",
)
async def get_comment_reply_endpoint(
    org_id: uuid.UUID,
    comment_id: uuid.UUID,
    reply_id: uuid.UUID,
    db: AsyncSession = Depends(get_db),
    verified_org_id: uuid.UUID = Depends(get_verified_org_id),
    auth: AuthContext = Depends(get_current_user),
) -> ReplyView:
    """조직 멤버(휴먼·에이전트 모두) 읽기 가능 — 목록 GET과 동형 권한 폭(AC6). 승인
    카드 화면은 이 응답의 `target_comment_state`(ReplyView 필드 설명 참고)를 그대로
    보여주면 된다(화면이 판정 X, 서버가 이미 계산해 실어 준다).

    에러: `404`(reply_id 없음/다른 org 소속)."""
    if org_id != verified_org_id:
        raise HTTPException(status_code=403, detail="org_id mismatch")

    try:
        view = await get_comment_reply_view(db, org_id=org_id, reply_id=reply_id)
    except CommentReplyNotFoundError as exc:
        raise HTTPException(status_code=404, detail=f"답변을 찾을 수 없습니다: {reply_id}") from exc
    return _reply_view(view["reply"], view["target_comment_state"])
