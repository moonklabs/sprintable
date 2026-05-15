import asyncio
import os
import re
import uuid
import logging

import httpx
from fastapi import APIRouter, BackgroundTasks, Depends, HTTPException, Query
from sqlalchemy import select
from sqlalchemy.ext.asyncio import AsyncSession

logger = logging.getLogger(__name__)

from app.dependencies.auth import AuthContext, get_current_user, get_project_scoped_org_id, get_verified_org_id
from app.dependencies.database import get_db
from app.models.memo import Memo, MemoAssignee, MemoReply
from app.models.team import TeamMember
from app.models.webhook_config import WebhookConfig
from app.repositories.memo import MemoReplyRepository, MemoRepository
from app.routers.events import publish_event
from app.services.eventbus import dispatch_memo_event
from app.services.notification_dispatch import dispatch_notification
from app.schemas.memo import CreateMemo, CreateReply, MemoListResponse, MemoResponse, ReplyResponse, UpdateMemo

router = APIRouter(prefix="/api/v2/memos", tags=["memos"])

_ENTITY_PATTERN = re.compile(
    r"\(entity:(story|doc|epic|task):([0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12})\)",
    re.IGNORECASE,
)


def _parse_entity_embeds(content: str) -> list:
    """content 내 (entity:type:uuid) 패턴 파싱 → MemoEntityLinkCreate 리스트 (중복 제거)."""
    from app.schemas.memo import MemoEntityLinkCreate
    seen: set[tuple[str, str]] = set()
    result = []
    for i, m in enumerate(_ENTITY_PATTERN.finditer(content)):
        entity_type, entity_id_str = m.group(1).lower(), m.group(2)
        key = (entity_type, entity_id_str)
        if key in seen:
            continue
        seen.add(key)
        result.append(MemoEntityLinkCreate(
            entity_type=entity_type,  # type: ignore[arg-type]
            entity_id=uuid.UUID(entity_id_str),
            position=i,
        ))
    return result


async def _collect_reply_webhook_urls(
    db: AsyncSession,
    memo_id: uuid.UUID,
    assigned_to: uuid.UUID | None,
    created_by: uuid.UUID | None,
    sender_id: uuid.UUID,
    extra_ids: list[uuid.UUID] | None = None,
) -> list[str]:
    assignee_rows = await db.execute(
        select(MemoAssignee.member_id).where(MemoAssignee.memo_id == memo_id)
    )
    all_assignee_ids = {row[0] for row in assignee_rows}
    reply_rows = await db.execute(
        select(MemoReply.created_by).where(MemoReply.memo_id == memo_id).distinct()
    )
    prior_participant_ids = {row[0] for row in reply_rows}
    recipient_ids = ({assigned_to, created_by} | all_assignee_ids | prior_participant_ids | set(extra_ids or [])) - {sender_id, None}
    if not recipient_ids:
        return []
    rows = await db.execute(
        select(WebhookConfig.url).where(
            WebhookConfig.member_id.in_(recipient_ids),
            WebhookConfig.is_active.is_(True),
        )
    )
    return [row[0] for row in rows if row[0]]


def _fire_webhook(url: str, content: str, title: str, memo_url: str, memo_id: str = "") -> None:
    try:
        full_content = content
        if memo_id:
            full_content = f"{content}\n\nmemo_id: {memo_id}"
        if "discord.com/api/webhooks" in url or "discordapp.com/api/webhooks" in url:
            payload: dict = {"content": full_content}
            if memo_url:
                payload["embeds"] = [{"title": title, "url": memo_url}]
        else:
            payload = {"text": full_content}
        httpx.post(url, json=payload, timeout=10)
    except Exception:  # noqa: BLE001
        logger.warning("reply webhook fire failed url=%s", url, exc_info=True)


async def _retry_async(label: str, coro_fn, *args, retries: int = 3, **kwargs) -> None:
    """코루틴 함수를 최대 retries회 재시도. 실패 시 warning 로그."""
    for attempt in range(retries):
        try:
            await coro_fn(*args, **kwargs)
            return
        except Exception:
            if attempt < retries - 1:
                await asyncio.sleep(2 ** attempt)
            else:
                logger.warning("%s failed after %d attempts", label, retries, exc_info=True)


async def _reply_side_effects_bg(
    memo_id: uuid.UUID,
    reply_id: uuid.UUID,
    org_id: uuid.UUID,
    project_id: uuid.UUID | None,
    sender_id: uuid.UUID | None,
) -> None:
    """add_reply의 notification/eventbus/workflow side effects를 새 세션으로 백그라운드 처리."""
    from app.core.database import async_session_factory
    from app.routers.chats import _persist_and_push_chat_events
    from app.models.memo import MemoEntityLink, MemoReply as MemoReplyModel

    async with async_session_factory() as db:
        try:
            memo_result = await db.execute(select(Memo).where(Memo.id == memo_id).limit(1))
            memo = memo_result.scalar_one_or_none()
            if memo is None:
                return
            reply_result = await db.execute(select(MemoReplyModel).where(MemoReplyModel.id == reply_id).limit(1))
            reply = reply_result.scalar_one_or_none()
            if reply is None:
                return

            # chat events persist + SSE push
            try:
                from app.models.team import TeamMember as TeamMemberModel
                sender_result = await db.execute(
                    select(TeamMemberModel).where(TeamMemberModel.id == sender_id).limit(1)
                )
                sender_member = sender_result.scalar_one_or_none()
                if sender_member:
                    chat_participants: set[uuid.UUID] = set()
                    if memo.assigned_to:
                        chat_participants.add(memo.assigned_to)
                    if memo.created_by:
                        chat_participants.add(memo.created_by)
                    chat_participants.discard(sender_id)
                    async with db.begin_nested():
                        await _persist_and_push_chat_events(db, memo, reply, org_id, sender_member, chat_participants)
            except Exception:
                logger.warning("reply bg: chat events failed memo_id=%s", memo_id, exc_info=True)

            # notification (최대 3회 재시도)
            notification_targets = [r for r in [memo.created_by] if r and r != sender_id]
            if notification_targets:
                await _retry_async(
                    f"reply bg: notification memo_id={memo_id}",
                    dispatch_notification,
                    db,
                    org_id=org_id,
                    event_type="memo_reply",
                    target_member_ids=notification_targets,
                    title=memo.title or "메모 답신",
                    body=(reply.content or "")[:200],
                    reference_type="memo",
                    reference_id=memo_id,
                )

            # eventbus (최대 3회 재시도)
            if project_id:
                recipient_ids = [r for r in [memo.assigned_to, memo.created_by] if r and r != sender_id]
                if recipient_ids:
                    await _retry_async(
                        f"reply bg: eventbus memo_id={memo_id}",
                        dispatch_memo_event,
                        db,
                        org_id=org_id,
                        project_id=project_id,
                        event_type="memo_replied",
                        source_entity_id=reply.id,
                        sender_id=sender_id,
                        recipient_ids=recipient_ids,
                        payload={
                            "content_preview": (reply.content or "")[:100],
                            "sender_id": str(sender_id) if sender_id else None,
                            "parent_memo_id": str(memo_id),
                            "thread_id": str(memo_id),
                        },
                    )

            # workflow pipeline (최대 3회 재시도)
            if project_id:
                from app.services.workflow_pipeline import process_event
                from app.services.rule_evaluator import EventContext
                author_role = await _resolve_author_role(db, reply.created_by)
                has_pr = bool(re.search(r"github\.com/.+/pull/\d+", reply.content or ""))
                story_link_result = await db.execute(
                    select(MemoEntityLink.entity_id)
                    .where(MemoEntityLink.memo_id == memo_id, MemoEntityLink.entity_type == "story")
                    .limit(1)
                )
                linked_story_id = story_link_result.scalar_one_or_none()
                actor_name: str | None = None
                if reply.created_by:
                    tm_result = await db.execute(
                        select(TeamMember).where(TeamMember.id == reply.created_by).limit(1)
                    )
                    tm = tm_result.scalar_one_or_none()
                    actor_name = tm.name if tm else None
                await _retry_async(
                    f"reply bg: workflow pipeline memo_id={memo_id}",
                    process_event,
                    db, org_id, project_id,
                    EventContext(
                        event_type="memo.reply_created",
                        trigger_type_slug=_infer_trigger_type(memo.memo_type, reply.review_type),
                        memo_type=memo.memo_type,
                        memo_id=str(reply.id),
                        actor_id=str(reply.created_by) if reply.created_by else None,
                        metadata={
                            "original_memo_id": str(memo_id),
                            "original_memo_type": memo.memo_type,
                            "original_title": memo.title,
                            "reply_author_id": str(reply.created_by) if reply.created_by else None,
                            "reply_author_role": author_role,
                            "actor_name": actor_name,
                            "actor_role": author_role,
                            "review_type": reply.review_type,
                            "has_pr_link": has_pr,
                            "content_preview": (reply.content or "")[:200],
                            "context_message": memo.title or (reply.content or "")[:100],
                            "story_id": str(linked_story_id) if linked_story_id else None,
                        },
                    ),
                )

            await db.commit()
        except Exception:
            await db.rollback()
            logger.warning("reply side effects bg failed memo_id=%s", memo_id, exc_info=True)


async def _memo_side_effects_bg(
    memo_id: uuid.UUID,
    org_id: uuid.UUID,
    project_id: uuid.UUID | None,
    assigned_to: uuid.UUID | None,
    created_by: uuid.UUID | None,
    title: str | None,
    memo_type: str | None,
    content: str | None,
) -> None:
    """create_memo의 notification/eventbus/workflow side effects를 새 세션으로 백그라운드 처리."""
    from app.core.database import async_session_factory

    async with async_session_factory() as db:
        try:
            if assigned_to:
                await _retry_async(
                    f"memo bg: notification memo_id={memo_id}",
                    dispatch_notification,
                    db,
                    org_id=org_id,
                    event_type="memo_received",
                    target_member_ids=[assigned_to],
                    title=title or "새 메모",
                    body=(content or "")[:200],
                    reference_type="memo",
                    reference_id=memo_id,
                )

            if assigned_to and project_id:
                await _retry_async(
                    f"memo bg: eventbus memo_id={memo_id}",
                    dispatch_memo_event,
                    db,
                    org_id=org_id,
                    project_id=project_id,
                    event_type="memo_created",
                    source_entity_id=memo_id,
                    sender_id=created_by,
                    recipient_ids=[assigned_to],
                    payload={
                        "title": title,
                        "content_preview": (content or "")[:100],
                        "sender_id": str(created_by) if created_by else None,
                        "thread_id": str(memo_id),
                    },
                )

            if project_id:
                from app.services.workflow_pipeline import process_event
                from app.services.rule_evaluator import EventContext
                actor_name: str | None = None
                actor_role: str | None = None
                if created_by:
                    tm_result = await db.execute(
                        select(TeamMember).where(TeamMember.id == created_by).limit(1)
                    )
                    tm = tm_result.scalar_one_or_none()
                    if tm:
                        actor_name = tm.name
                        actor_role = tm.role
                await _retry_async(
                    f"memo bg: workflow pipeline memo_id={memo_id}",
                    process_event,
                    db, org_id, project_id,
                    EventContext(
                        event_type="memo_created",
                        trigger_type_slug="kickoff" if memo_type == "task" else None,
                        memo_type=memo_type,
                        memo_id=str(memo_id),
                        actor_id=str(created_by) if created_by else None,
                        metadata={
                            "memo_id": str(memo_id),
                            "memo_type": memo_type,
                            "title": title,
                            "assigned_to_id": str(assigned_to) if assigned_to else None,
                            "actor_id": str(created_by) if created_by else None,
                            "actor_name": actor_name,
                            "actor_role": actor_role,
                            "context_message": title or (content or "")[:100],
                        },
                    ),
                )

            await db.commit()
        except Exception:
            await db.rollback()
            logger.warning("memo side effects bg failed memo_id=%s", memo_id, exc_info=True)


def _infer_trigger_type(memo_type: str | None, review_type: str | None) -> str:
    if review_type in ("approve", "request_changes"):
        return "review_request"
    if review_type == "qa":
        return "qa_request"
    return "reply"


async def _resolve_author_role(db: AsyncSession, created_by: uuid.UUID | None) -> str:
    if created_by is None:
        return "member"
    result = await db.execute(
        select(TeamMember.role).where(TeamMember.id == created_by).limit(1)
    )
    row = result.scalar_one_or_none()
    return str(row) if row else "member"


def _get_repo(
    session: AsyncSession = Depends(get_db),
    org_id: uuid.UUID = Depends(get_project_scoped_org_id),
) -> MemoRepository:
    return MemoRepository(session, org_id)


@router.get("", response_model=list[MemoListResponse])
async def list_memos(
    project_id: uuid.UUID | None = Query(default=None),
    assigned_to: uuid.UUID | None = Query(default=None),
    created_by: uuid.UUID | None = Query(default=None),
    status_filter: str | None = Query(default=None, alias="status"),
    q: str | None = Query(default=None),
    trigger_type: str | None = Query(default=None),
    repo: MemoRepository = Depends(_get_repo),
) -> list[MemoListResponse]:
    from app.models.conversation import Conversation

    filters: dict = {}
    if project_id:
        filters["project_id"] = project_id
    if assigned_to:
        filters["assigned_to"] = assigned_to
    if created_by:
        filters["created_by"] = created_by
    if status_filter:
        filters["status"] = status_filter
    if q:
        filters["q"] = q
    if trigger_type:
        filters["trigger_type"] = trigger_type
    memos = await repo.list(**filters)
    memo_ids = [m.id for m in memos]
    memo_id_set = {m.id for m in memos}
    counts = await repo.get_entity_link_counts_batch(memo_ids)
    reply_counts = await repo.get_reply_counts_batch(memo_ids)
    results = []
    for m in memos:
        memo_dict = {k: v for k, v in m.__dict__.items() if not k.startswith("_")}
        memo_dict["embed_count"] = counts.get(m.id, 0)
        rc, latest = reply_counts.get(m.id, (0, None))
        memo_dict["reply_count"] = rc
        memo_dict["latest_reply_at"] = latest
        results.append(MemoListResponse.model_validate(memo_dict))

    # AC4: conversation-backed memos (신규 생성, memo row 없는 것만)
    conv_q = select(Conversation).where(
        Conversation.org_id == repo.org_id,
        Conversation.id.notin_(memo_id_set) if memo_id_set else True,
        Conversation.deleted_at.is_(None) if hasattr(Conversation, "deleted_at") else True,
    )
    if project_id:
        conv_q = conv_q.where(Conversation.project_id == project_id)
    if status_filter:
        conv_q = conv_q.where(Conversation.status == status_filter)
    convs = (await repo.session.execute(conv_q)).scalars().all()
    for conv in convs:
        results.append(MemoListResponse.model_validate({
            "id": conv.id,
            "project_id": conv.project_id,
            "org_id": conv.org_id,
            "memo_type": "memo",
            "title": conv.title,
            "content": "",
            "created_by": conv.created_by,
            "assigned_to": None,
            "status": conv.status or "open",
            "supersedes_id": None,
            "resolved_by": conv.resolved_by,
            "resolved_at": conv.resolved_at,
            "archived_at": None,
            "memo_metadata": {},
            "created_at": conv.created_at,
            "updated_at": conv.updated_at,
            "embed_count": 0,
            "reply_count": 0,
            "latest_reply_at": None,
        }))

    return results


@router.post("", status_code=201)
async def create_memo(
    body: CreateMemo,
    background_tasks: BackgroundTasks,
    session: AsyncSession = Depends(get_db),
    _auth: AuthContext = Depends(get_current_user),
) -> dict:
    # AC1: conversation adapter로 라우팅 (memo row 미생성)
    from app.models.conversation import Conversation, ConversationMessage, ConversationParticipant

    participant_ids: set[uuid.UUID] = set()
    if body.created_by:
        participant_ids.add(body.created_by)
    if body.assigned_to:
        participant_ids.add(body.assigned_to)
    if body.assigned_to_ids:
        participant_ids.update(body.assigned_to_ids)

    conv = Conversation(
        project_id=body.project_id,
        org_id=body.org_id,
        type="group",
        title=body.title,
        created_by=body.created_by,
        status="open",
    )
    session.add(conv)
    for pid in participant_ids:
        session.add(ConversationParticipant(conversation_id=conv.id, member_id=pid))
    await session.flush()

    root_msg = ConversationMessage(
        conversation_id=conv.id,
        sender_id=body.created_by,
        content=body.content or "",
        mentioned_ids=[],
        thread_id=None,
    )
    session.add(root_msg)
    await session.flush()

    logger.info(
        "create_memo routed to conversation conversation_id=%s message_id=%s project_id=%s",
        conv.id, root_msg.id, body.project_id,
    )
    publish_event(str(body.org_id), "memo_created", {"id": str(conv.id)})

    # webhook + side effects
    memo_recipient_ids: set[uuid.UUID] = set()
    if body.assigned_to:
        memo_recipient_ids.add(body.assigned_to)
    if body.assigned_to_ids:
        memo_recipient_ids.update(body.assigned_to_ids)
    memo_recipient_ids.discard(body.created_by)
    if memo_recipient_ids:
        wh_rows = await session.execute(
            select(WebhookConfig.url).where(
                WebhookConfig.member_id.in_(memo_recipient_ids),
                WebhookConfig.is_active.is_(True),
            )
        )
        memo_webhook_urls = [row[0] for row in wh_rows if row[0]]
        if memo_webhook_urls:
            app_url = os.environ.get("NEXT_PUBLIC_APP_URL", "")
            memo_url = f"{app_url}/memos?id={conv.id}" if app_url else ""
            wh_content = f"**새 메모**\n{(body.content or '')[:500]}\n\nmemo_id: {conv.id}"
            wh_title = body.title or "새 메모"
            for wh_url in memo_webhook_urls:
                background_tasks.add_task(_fire_webhook, wh_url, wh_content, wh_title, memo_url, str(conv.id))

    _is_workflow_origin = (body.memo_metadata or {}).get("origin") == "workflow"
    if not _is_workflow_origin:
        background_tasks.add_task(
            _memo_side_effects_bg,
            memo_id=conv.id,
            org_id=body.org_id,
            project_id=body.project_id,
            assigned_to=body.assigned_to or (body.assigned_to_ids[0] if body.assigned_to_ids else None),
            created_by=body.created_by,
            title=body.title,
            memo_type=body.memo_type,
            content=body.content,
        )

    # AC5: deprecated response (memo_id + conversation_id + message_id + deprecated)
    return {
        "id": str(conv.id),
        "memo_id": str(conv.id),
        "conversation_id": str(conv.id),
        "message_id": str(root_msg.id),
        "deprecated": True,
        "project_id": str(body.project_id) if body.project_id else None,
        "org_id": str(body.org_id),
        "memo_type": body.memo_type or "memo",
        "title": body.title,
        "content": body.content,
        "status": "open",
        "created_at": conv.created_at.isoformat() if conv.created_at else None,
        "updated_at": conv.updated_at.isoformat() if conv.updated_at else None,
        "memo_metadata": body.memo_metadata or {},
        "embed_count": 0,
        "reply_count": 0,
    }


@router.get("/{id}", response_model=MemoResponse)
async def get_memo(
    id: uuid.UUID,
    db: AsyncSession = Depends(get_db),
    repo: MemoRepository = Depends(_get_repo),
) -> MemoResponse:
    from app.models.conversation import Conversation, ConversationMessage

    # AC3: conversation 우선 조회 (S-B1 마이그레이션 + 신규 생성)
    conv = await db.get(Conversation, id)
    if conv is not None:
        root_result = await db.execute(
            select(ConversationMessage)
            .where(ConversationMessage.conversation_id == id, ConversationMessage.thread_id.is_(None))
            .limit(1)
        )
        root_msg = root_result.scalar_one_or_none()
        reply_results = await db.execute(
            select(ConversationMessage)
            .where(ConversationMessage.conversation_id == id, ConversationMessage.thread_id.isnot(None))
            .order_by(ConversationMessage.created_at.asc())
        )
        reply_msgs = reply_results.scalars().all()
        reply_items = [
            ReplyResponse.model_validate({
                "id": r.id,
                "memo_id": id,
                "created_by": r.sender_id,
                "content": r.content,
                "review_type": "comment",
                "attachments": [],
                "created_at": r.created_at,
            }) for r in reply_msgs
        ]
        return MemoResponse.model_validate({
            "id": conv.id,
            "project_id": conv.project_id,
            "org_id": conv.org_id,
            "memo_type": "memo",
            "title": conv.title,
            "content": root_msg.content if root_msg else "",
            "created_by": conv.created_by,
            "assigned_to": None,
            "status": conv.status or "open",
            "supersedes_id": None,
            "resolved_by": conv.resolved_by,
            "resolved_at": conv.resolved_at,
            "archived_at": None,
            "memo_metadata": {},
            "created_at": conv.created_at,
            "updated_at": conv.updated_at,
            "deleted_at": None,
            "replies": reply_items,
            "reply_count": len(reply_items),
            "embeds": [],
            "embed_count": 0,
            "latest_reply_at": reply_msgs[-1].created_at if reply_msgs else None,
        })

    # AC7: fallback 로그
    logger.info("get_memo memo_fallback_used=True memo_id=%s", id)

    memo = await repo.get(id)
    if memo is None:
        raise HTTPException(status_code=404, detail="Memo not found")
    reply_repo = MemoReplyRepository(db)
    replies = await reply_repo.list_by_memo(id)
    reply_items = [ReplyResponse.model_validate(r) for r in replies]
    embeds = await repo.get_entity_links_resolved(id)
    # __dict__ 사용: 로드된 column 값만 포함, lazy-load 안 된 relationship 자동 제외
    memo_dict: dict = {k: v for k, v in memo.__dict__.items() if not k.startswith("_")}
    memo_dict["replies"] = reply_items
    memo_dict["reply_count"] = len(reply_items)
    memo_dict["embeds"] = embeds
    memo_dict["embed_count"] = len(embeds)
    return MemoResponse.model_validate(memo_dict)


@router.patch("/{id}", response_model=MemoListResponse)
async def update_memo(
    id: uuid.UUID,
    body: UpdateMemo,
    repo: MemoRepository = Depends(_get_repo),
) -> MemoListResponse:
    data = body.model_dump(exclude_unset=True)
    memo = await repo.update(id, **data)
    if memo is None:
        raise HTTPException(status_code=404, detail="Memo not found")
    publish_event(str(repo.org_id), "memo_updated", {"id": str(id)})
    return MemoListResponse.model_validate(memo)


@router.delete("/{id}", status_code=200)
async def delete_memo(
    id: uuid.UUID,
    repo: MemoRepository = Depends(_get_repo),
) -> dict:
    ok = await repo.soft_delete(id)
    if not ok:
        raise HTTPException(status_code=404, detail="Memo not found")
    return {"ok": True}


@router.post("/{id}/replies", status_code=201)
async def add_reply(
    id: uuid.UUID,
    body: CreateReply,
    background_tasks: BackgroundTasks,
    db: AsyncSession = Depends(get_db),
    repo: MemoRepository = Depends(_get_repo),
) -> dict:
    from app.models.conversation import Conversation, ConversationMessage

    # AC2: conversation thread reply로 라우팅 (memo_reply row 미생성)
    root_result = await db.execute(
        select(ConversationMessage)
        .where(ConversationMessage.conversation_id == id, ConversationMessage.thread_id.is_(None))
        .limit(1)
    )
    root_msg = root_result.scalar_one_or_none()

    if root_msg is not None:
        reply_msg = ConversationMessage(
            conversation_id=id,
            sender_id=body.created_by,
            content=body.content or "",
            mentioned_ids=[],
            thread_id=root_msg.id,
        )
        db.add(reply_msg)
        await db.flush()
        logger.info(
            "add_reply routed to conversation thread conversation_id=%s message_id=%s",
            id, reply_msg.id,
        )
        # webhook 발송 (기존 참여자 수집)
        conv = await db.get(Conversation, id)
        if conv:
            webhook_urls = await _collect_reply_webhook_urls(
                db, id, None, conv.created_by, body.created_by, body.assigned_to_ids
            )
            if webhook_urls:
                app_url = os.environ.get("NEXT_PUBLIC_APP_URL", "")
                memo_url = f"{app_url}/memos?id={id}" if app_url else ""
                wh_content = f"📩 **새 답신**\n{(body.content or '')[:500]}\n\nreply_id: {reply_msg.id}"
                for url in webhook_urls:
                    background_tasks.add_task(_fire_webhook, url, wh_content, conv.title or "메모 답신", memo_url, str(id))
        # AC5: deprecated response
        return {
            "id": str(reply_msg.id),
            "memo_id": str(id),
            "conversation_id": str(id),
            "message_id": str(reply_msg.id),
            "deprecated": True,
            "content": body.content,
            "created_by": str(body.created_by),
            "review_type": body.review_type,
            "attachments": body.attachments or [],
            "created_at": reply_msg.created_at.isoformat() if reply_msg.created_at else None,
        }

    # AC7: fallback 로그 (legacy memo path)
    logger.info("add_reply memo_fallback_used=True memo_id=%s", id)

    memo = await repo.get(id)
    if memo is None:
        raise HTTPException(status_code=404, detail="Memo not found")
    reply_repo = MemoReplyRepository(db)
    reply = await reply_repo.create(
        memo_id=id, content=body.content, created_by=body.created_by, review_type=body.review_type,
        attachments=body.attachments,
    )
    publish_event(str(repo.org_id), "reply_created", {"id": str(reply.id), "memo_id": str(id)})

    webhook_urls = await _collect_reply_webhook_urls(
        db, id, memo.assigned_to, memo.created_by, body.created_by, body.assigned_to_ids
    )
    if webhook_urls:
        app_url = os.environ.get("NEXT_PUBLIC_APP_URL", "")
        memo_url = f"{app_url}/memos?id={id}" if app_url else ""
        content = f"📩 **새 답신**\n{reply.content[:500]}\n\nreply_id: {reply.id}"
        title = memo.title or "메모 답신"
        for url in webhook_urls:
            background_tasks.add_task(_fire_webhook, url, content, title, memo_url, str(id))

    background_tasks.add_task(
        _reply_side_effects_bg,
        memo_id=id,
        reply_id=reply.id,
        org_id=repo.org_id,
        project_id=memo.project_id,
        sender_id=body.created_by,
    )

    reply_dict = {k: v for k, v in reply.__dict__.items() if not k.startswith("_")}
    return reply_dict


@router.post("/{id}/resolve", response_model=MemoListResponse)
async def resolve_memo(
    id: uuid.UUID,
    resolved_by: uuid.UUID = Query(...),
    repo: MemoRepository = Depends(_get_repo),
) -> MemoListResponse:
    memo = await repo.resolve(id, resolved_by)
    if memo is None:
        raise HTTPException(status_code=404, detail="Memo not found")
    return MemoListResponse.model_validate(memo)


@router.post("/{id}/archive", response_model=MemoListResponse)
async def archive_memo(
    id: uuid.UUID,
    repo: MemoRepository = Depends(_get_repo),
) -> MemoListResponse:
    memo = await repo.archive(id)
    if memo is None:
        raise HTTPException(status_code=404, detail="Memo not found")
    return MemoListResponse.model_validate(memo)


@router.post("/{id}/read", status_code=200)
async def mark_read(
    id: uuid.UUID,
    team_member_id: uuid.UUID = Query(...),
    repo: MemoRepository = Depends(_get_repo),
) -> dict:
    memo = await repo.get(id)
    if memo is None:
        raise HTTPException(status_code=404, detail="Memo not found")
    await repo.mark_read(id, team_member_id)
    return {"ok": True}


@router.get("/{id}/linked-docs")
async def get_linked_docs(
    id: uuid.UUID,
    repo: MemoRepository = Depends(_get_repo),
) -> list[dict]:
    memo = await repo.get(id)
    if memo is None:
        raise HTTPException(status_code=404, detail="Memo not found")
    links = await repo.get_doc_links(id)
    return [{"id": str(l.id), "memo_id": str(l.memo_id), "doc_id": str(l.doc_id)} for l in links]


@router.post("/convert", status_code=201)
async def convert_to_doc(
    memo_id: uuid.UUID = Query(...),
    repo: MemoRepository = Depends(_get_repo),
) -> dict:
    memo = await repo.get(memo_id)
    if memo is None:
        raise HTTPException(status_code=404, detail="Memo not found")
    # Phase B stub — actual doc creation in Phase D
    return {"ok": True, "memo_id": str(memo_id), "doc_id": None}
