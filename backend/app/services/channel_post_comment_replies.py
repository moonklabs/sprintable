"""story #3516 조각②(Phase2·마케팅운영, 페드루 PO 確定 2026-09-05) — 댓글 「작업으로
전환」(story 생성) + 답변(초안→상신→external_publish 게이트→publication_command→
워커 어댑터 reply). 조각①(channel_post_comments.py)이 만든 3테이블 중
`channel_post_comment_replies`를 여기서 처음 write한다.

봉인 축(그라운딩·PO 確定) — 답변 sha·본문은 Gate의 기존 sealed_content_sha256/
sealed_content_body 컬럼을 재사용(site_post/channel_post publish 게이트와 같은
컬럼, 다른 scope_key로 구분 — 새 컬럼 0). 대상 댓글의 external id·text_sha256은
Gate.neutral_facts(JSONB, site_posts.py::draft_id 관례와 동형)에 싣는다."""
from __future__ import annotations

import hashlib
import uuid
from datetime import datetime, timezone
from typing import Any, Literal

from sqlalchemy import select
from sqlalchemy.ext.asyncio import AsyncSession

from app.models.channel_post_comment import ChannelPostComment, ChannelPostCommentReply

_EXTERNAL_PUBLISH_GATE_TYPE = "external_publish"

TargetCommentState = Literal["current", "changed", "deleted"]


class CommentNotFoundError(Exception):
    """comment_id가 이 org 소속 channel_post_comments 행이 아님(404)."""


class CommentReplyNotFoundError(Exception):
    """reply_id가 이 org 소속 channel_post_comment_replies 행이 아님(404)."""


class CommentReplyWrongStatusError(Exception):
    def __init__(self, *, status: str):
        self.status = status
        super().__init__(f"이 상태({status})에서는 상신할 수 없습니다")


class CommentReplyTargetDeletedError(Exception):
    """AC4 — 대상 댓글이 삭제됨(409, 명령 생성 0). 유나 §22-9 「지워진 댓글엔 액션
    안 그림」의 서버 짝 — submit·approve 둘 다 이 예외로 막는다."""


class CommentReplyChannelUnsupportedError(Exception):
    """이 publication의 채널 어댑터가 supports_reply=False."""


class CommentReplyApproverRoleMissingError(Exception):
    def __init__(self, *, org_id: uuid.UUID):
        self.org_id = org_id
        super().__init__(f"기본 승인 role이 없습니다: {org_id}")


def compute_target_comment_state(
    *, comment: ChannelPostComment, sealed_target_text_sha256: str | None,
) -> TargetCommentState:
    """AC4 — 읽기 시 계산(저장 안 함, PO 明示). deleted가 changed보다 우선(동시에
    바뀌었어도 "지워졌다"가 더 결정적인 사실). `sealed_target_text_sha256`이 아직
    없으면(구버전 게이트 등) "changed"로 보수적으로 판정 — 봉인값과 비교 불가를
    "변화 없음"으로 낙관하지 않는다."""
    if comment.deleted_at is not None:
        return "deleted"
    if sealed_target_text_sha256 is None or comment.text_sha256 != sealed_target_text_sha256:
        return "changed"
    return "current"


async def _get_owned_comment(db: AsyncSession, *, org_id: uuid.UUID, comment_id: uuid.UUID) -> ChannelPostComment:
    comment = (await db.execute(
        select(ChannelPostComment).where(ChannelPostComment.id == comment_id, ChannelPostComment.org_id == org_id)
    )).scalar_one_or_none()
    if comment is None:
        raise CommentNotFoundError(comment_id)
    return comment


async def _get_owned_reply(db: AsyncSession, *, org_id: uuid.UUID, reply_id: uuid.UUID) -> ChannelPostCommentReply:
    reply = (await db.execute(
        select(ChannelPostCommentReply).where(
            ChannelPostCommentReply.id == reply_id, ChannelPostCommentReply.org_id == org_id,
        )
    )).scalar_one_or_none()
    if reply is None:
        raise CommentReplyNotFoundError(reply_id)
    return reply


async def create_comment_follow_up(
    db: AsyncSession, *, org_id: uuid.UUID, comment_id: uuid.UUID, title: str, note: str | None,
    requested_by_member_id: uuid.UUID,
) -> dict[str, Any]:
    """AC2 — 댓글을 story로 전환. insights_board.py::create_publication_follow_up과
    동형(재발명 0) — 다만 title은 서버가 기본값을 안 짓는다(호출부 필수 — FE §22-④
    가 「[댓글] {게시물 제목}」 prefill을 책임진다, 페드루 PO 明示 2026-09-05)."""
    comment = await _get_owned_comment(db, org_id=org_id, comment_id=comment_id)

    from app.models.channel_publication import ChannelPublication
    from app.models.gate import Gate
    from app.models.pm import Story

    pub = (await db.execute(
        select(ChannelPublication).where(ChannelPublication.id == comment.publication_id)
    )).scalar_one_or_none()
    if pub is None:
        raise CommentNotFoundError(comment_id)
    gate = await db.get(Gate, pub.gate_id)
    if gate is None:
        raise CommentNotFoundError(comment_id)
    story = (await db.execute(
        select(Story).where(Story.id == gate.work_item_id, Story.org_id == org_id)
    )).scalar_one_or_none()
    if story is None:
        raise CommentNotFoundError(comment_id)

    body = (
        f"[댓글 후속 작업 — 원문: {story.title}]\n"
        f"comment_id: {comment_id}\n"
        f"작성자: {comment.author_display_name or '(표시명 없음)'}\n"
        f"본문: {comment.text}"
        + (f"\n\n{note}" if note else "")
    )

    from app.repositories.story import StoryRepository

    new_story = await StoryRepository(db, org_id).create(
        project_id=story.project_id, title=title, description=body, assignee_id=requested_by_member_id,
    )

    from app.models.evidence import Evidence

    db.add(Evidence(
        id=uuid.uuid4(), org_id=org_id, work_item_id=new_story.id, work_item_type="story",
        type="report", ref=str(new_story.id), source="channel_post_comments",
        note=f"댓글 후속 작업 생성(comment {comment_id})",
        created_by=requested_by_member_id,
        payload={"kind": "comment_follow_up_created", "comment_id": str(comment_id), "story_id": str(new_story.id)},
    ))
    await db.commit()
    await db.refresh(new_story)
    return {"story_id": new_story.id}


async def create_comment_reply_draft(
    db: AsyncSession, *, org_id: uuid.UUID, comment_id: uuid.UUID, text: str,
    created_by_member_id: uuid.UUID, created_by_kind: str,
) -> ChannelPostCommentReply:
    """AC3 초안 — is_agent_caller 허용(승인·발행은 human-only, submit부터). gate_id는
    아직 없다(0339가 nullable로 정정한 이유)."""
    await _get_owned_comment(db, org_id=org_id, comment_id=comment_id)

    reply = ChannelPostCommentReply(
        id=uuid.uuid4(), org_id=org_id, comment_id=comment_id, gate_id=None, command_id=None,
        text=text, status="draft", created_by_member_id=created_by_member_id, created_by_kind=created_by_kind,
    )
    db.add(reply)
    await db.commit()
    await db.refresh(reply)
    return reply


async def submit_comment_reply(
    db: AsyncSession, *, org_id: uuid.UUID, reply_id: uuid.UUID, requester_member_id: uuid.UUID,
) -> ChannelPostCommentReply:
    """AC3 상신(human-only, 라우터 가드) — external_publish 게이트(scope_key=
    "comment:{comment_id}")를 만들고 봉인한다. draft 상태에서만 1회(재상신·재편집은
    이 조각 스코프 밖 — 실패/반려 뒤 새 초안을 다시 만드는 편이 이 MVP엔 더 단순).
    대상 댓글이 이미 삭제됐으면 게이트조차 안 만들고 즉시 거부(AC4)."""
    reply = await _get_owned_reply(db, org_id=org_id, reply_id=reply_id)
    if reply.status != "draft":
        raise CommentReplyWrongStatusError(status=reply.status)

    comment = await _get_owned_comment(db, org_id=org_id, comment_id=reply.comment_id)
    if comment.deleted_at is not None:
        raise CommentReplyTargetDeletedError()

    from app.models.channel_publication import ChannelPublication
    from app.models.gate import Gate

    pub = (await db.execute(
        select(ChannelPublication).where(ChannelPublication.id == comment.publication_id)
    )).scalar_one_or_none()
    if pub is None:
        raise CommentNotFoundError(comment.id)

    from app.services.channel_adapters import CHANNEL_ADAPTERS

    adapter = CHANNEL_ADAPTERS.get(pub.channel)
    if adapter is None or not adapter.supports_reply:
        raise CommentReplyChannelUnsupportedError()

    publish_gate = await db.get(Gate, pub.gate_id)
    if publish_gate is None:
        raise CommentNotFoundError(comment.id)

    from app.models.gate import set_gate_status
    from app.services.gate_service import create_gate, find_gate_slot_with_pr_fallback
    from app.services.workflow_line_config import _default_role_id

    scope_key = f"comment:{comment.id}"
    text_sha256 = hashlib.sha256(reply.text.encode("utf-8")).hexdigest()
    neutral_facts = {
        "kind": "comment_reply", "reply_id": str(reply.id), "connection_id": str(pub.connection_id),
        "comment_id": str(comment.id), "target_external_comment_id": comment.external_comment_id,
        "target_text_sha256": comment.text_sha256, "requested_by_member_id": str(requester_member_id),
    }

    # find_gate_slot_with_pr_fallback는 (work_item_id, gate_type, scope_key) 슬롯을
    # 조회만 한다(생성은 create_gate) — 여기선 존재 확인용으로 안 부른다(create_gate
    # 자체가 이미 이 슬롯이 있으면 그 행을 재사용하는 멱등 함수, submit_channel_post_
    # draft와 동형).
    role_id = await _default_role_id(db, org_id)
    if role_id is None:
        raise CommentReplyApproverRoleMissingError(org_id=org_id)

    gate = await create_gate(
        db, org_id, publish_gate.work_item_id, "story", _EXTERNAL_PUBLISH_GATE_TYPE,
        requester_member_id, role_id, neutral_facts=neutral_facts, scope_key=scope_key,
    )
    gate.neutral_facts = neutral_facts
    if gate.status != "pending":
        set_gate_status(gate, "pending", now=datetime.now(timezone.utc))
        gate.requires_human = True
        gate.resolver_id = None
        gate.resolution_note = None
        gate.resolved_at = None
    gate.sealed_content_sha256 = text_sha256
    gate.sealed_content_body = reply.text

    reply.gate_id = gate.id
    reply.status = "pending"
    await db.commit()
    await db.refresh(reply)
    return reply


async def check_target_comment_not_deleted_or_raise(db: AsyncSession, *, gate: "Gate") -> None:  # noqa: F821
    """gates.py 승인 라우터가 approve 직전 부른다(merge-gate SHA 체크와 동형 위치 —
    페드루 PO 確定, AC4 "deleted면 승인 시 명령을 만들지 않고 409"의 실제 거부 지점.
    자동 커맨드 생성 훅(`_maybe_create_scheduled_publication_command`)은 실패를
    조용히 로그만 남길 뿐 HTTP 에러를 못 낸다 — 승인 요청 자체를 막는 건 여기뿐)."""
    if (gate.neutral_facts or {}).get("kind") != "comment_reply":
        return
    comment_id_raw = (gate.neutral_facts or {}).get("comment_id")
    if comment_id_raw is None:
        return
    comment = (await db.execute(
        select(ChannelPostComment).where(ChannelPostComment.id == uuid.UUID(comment_id_raw))
    )).scalar_one_or_none()
    if comment is not None and comment.deleted_at is not None:
        raise CommentReplyTargetDeletedError()


async def get_comment_reply_view(
    db: AsyncSession, *, org_id: uuid.UUID, reply_id: uuid.UUID,
) -> dict[str, Any]:
    """단건 조회 — AC4 target_comment_state를 읽기 시 계산해 싣는다(게이트가 아직
    없으면(draft) None — 아직 봉인 자체가 없어 판정 대상이 아니다)."""
    reply = await _get_owned_reply(db, org_id=org_id, reply_id=reply_id)
    comment = await _get_owned_comment(db, org_id=org_id, comment_id=reply.comment_id)

    target_comment_state: TargetCommentState | None = None
    if reply.gate_id is not None:
        from app.models.gate import Gate

        gate = await db.get(Gate, reply.gate_id)
        if gate is not None:
            sealed_target_sha = (gate.neutral_facts or {}).get("target_text_sha256")
            target_comment_state = compute_target_comment_state(
                comment=comment, sealed_target_text_sha256=sealed_target_sha,
            )
    return {"reply": reply, "target_comment_state": target_comment_state}
