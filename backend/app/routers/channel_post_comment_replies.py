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
    CommentReplyDraftAlreadyOpenError,
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
    # 'draft'|'pending'|'sent'|'failed'(channel_post_comment.py 모델 docstring 그대로
    # — 'approved'는 실전이 대입 0곳이라 문서에서 뺌, 조각②-b 후속 정정).
    status: str
    gate_id: uuid.UUID | None
    # story #3516 조각②-b(additive, 후속 기록 갭 메움) — pending+command_id≠null=
    # 「승인됨(발송 대기, 워커가 아직 안 집음)」, FE 칩은 이 필드 하나에서 파생.
    command_id: uuid.UUID | None = None
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
    target_text: str | None = Field(
        default=None,
        description=(
            "조각②-b(additive) — 봉인 시점(submit) 대상 댓글 원문. null=아직 게이트가 "
            "없다(draft)이거나 이 필드 추가 前에 submit된 구버전 게이트. 표시 전용 — "
            "target_comment_state 판정은 여전히 target_text_sha256(비노출)만 쓴다."
        ),
    )
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
            "voided 사유(PublicationCommand.reason_code 그대로, 새 이름 짓지 않음 — "
            "이 컬럼은 channel_post 발행류(publication_command.py)와 공유라 열거를 "
            "닫지 않는다). 페드루 PO 대조(2026-09-06) — **현재 관측 값**: "
            "\"GATE_NOT_APPROVED_OR_RESEALED\"(게이트 재검증 실패) · "
            "\"TARGET_COMMENT_DELETED\"(승인 뒤 워커 도달 前 대상 댓글 삭제 레이스) · "
            "\"CONTENT_CHANGED\"(channel_posts.py 재승인 필요 전이 축, 댓글 답변 "
            "경로가 아니어도 같은 컬럼에 실린다). 이 외에도 미래 값이 더 생길 수 "
            "있다 — 화면은 아는 값만 문구로 대응하고 모르는 값은 원문 그대로/일반 "
            "문구로 안전히 처리해야 한다. voided 아니면 null."
        ),
    )


async def _reply_view(
    db: AsyncSession, reply, target_comment_state: str | None, target_text: str | None = None,
) -> ReplyView:
    command = None
    if reply.command_id is not None:
        from app.models.publication_command import PublicationCommand

        command = await db.get(PublicationCommand, reply.command_id)
    return ReplyView(
        id=reply.id, comment_id=reply.comment_id, text=reply.text, status=reply.status, gate_id=reply.gate_id,
        command_id=reply.command_id,
        external_reply_id=reply.external_reply_id, external_reply_url=reply.external_reply_url,
        last_error=reply.last_error, target_comment_state=target_comment_state, target_text=target_text,
        command_status=command.status if command is not None else None,
        failure_kind=command.failure_kind if command is not None else None,
        next_attempt_at=command.next_attempt_at.isoformat() if command is not None and command.next_attempt_at else None,
        reason_code=command.reason_code if command is not None else None,
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
    except CommentReplyDraftAlreadyOpenError as exc:
        raise HTTPException(
            status_code=409,
            detail={
                "code": "COMMENT_REPLY_DRAFT_ALREADY_OPEN",
                "message": "안 보낸 초안이 이미 있습니다.",
                "existing_reply_id": str(exc.existing_reply_id),
            },
        ) from exc
    return await _reply_view(db, reply, None)


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
        view = await get_comment_reply_view(db, org_id=org_id, reply_id=reply.id)
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
    except CommentNotFoundError as exc:
        # story #3531(2026-09-06) — create 엔드포인트는 이미 이 예외를 404로 잡는데
        # (자리마다 다름 클래스) 여기(submit_comment_reply 내부 재조회·get_comment_
        # reply_view 둘 다)는 안 잡아 500이 새던 갭. create와 같은 문장.
        raise HTTPException(status_code=404, detail=f"댓글을 찾을 수 없습니다: {comment_id}") from exc

    return await _reply_view(db, view["reply"], view["target_comment_state"], view["target_text"])


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

    에러: `404`(reply_id 없음/다른 org 소속) · `404`(대상 댓글 행이 하드 삭제됨,
    story #3531 — create 엔드포인트와 같은 문장으로 맞춘다)."""
    if org_id != verified_org_id:
        raise HTTPException(status_code=403, detail="org_id mismatch")

    try:
        view = await get_comment_reply_view(db, org_id=org_id, reply_id=reply_id)
    except CommentReplyNotFoundError as exc:
        raise HTTPException(status_code=404, detail=f"답변을 찾을 수 없습니다: {reply_id}") from exc
    except CommentNotFoundError as exc:
        # story #3531(2026-09-06, #3883 리뷰 中 발견) — get_comment_reply_view 안
        # _get_owned_comment가 던지는데(대상 댓글 행 하드 삭제) 이 라우터가 이 예외를
        # 못 잡아 500이 새던 갭. create 엔드포인트와 같은 문장으로 맞춘다.
        raise HTTPException(status_code=404, detail=f"댓글을 찾을 수 없습니다: {comment_id}") from exc
    return await _reply_view(db, view["reply"], view["target_comment_state"], view["target_text"])
