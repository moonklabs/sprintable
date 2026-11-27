from __future__ import annotations

import json
import logging
import os
import uuid
from datetime import datetime, timedelta, timezone
from typing import Any
from urllib.parse import parse_qs

from fastapi import APIRouter, Depends, Request
from fastapi.responses import JSONResponse
from sqlalchemy.ext.asyncio import AsyncSession

from sqlalchemy import select, text, update

from app.dependencies.database import get_db
from app.repositories.bridge_inbound import BridgeInboundRepository, build_bridge_metadata, check_rate_limit
from app.utils.slack_verify import verify_slack_signature
from app.utils.teams_verify import verify_teams_request

router = APIRouter(prefix="/api/v2/bridge", tags=["bridge", "Organization"])
logger = logging.getLogger(__name__)

# story 5049 — an inbound line the mapping's project does not own: the audit row an organization's admin reads (`GET /api/v2/audit-logs`), at most one per (mapping, reason) an hour
BRIDGE_SKIPPED_ACTION = "bridge.inbound_skipped"
_BRIDGE_SKIP_AUDIT_WINDOW = timedelta(hours=1)


# ─── S-D2: conversation inbound helper ────────────────────────────────────────

async def _skip_inbound(
    session: AsyncSession,
    reason: str,
    *,
    conv,
    author_id: uuid.UUID,
    org_id: uuid.UUID,
    mapping_project_id: uuid.UUID,
    mapping_id: uuid.UUID | None,
    platform: str | None,
) -> dict:
    """story 5049 — the mapping's project does not own this room (or, in a project's channel, the author may not speak in it): the line is dropped — no participant row, no message — and the request still ends
    200 (an error would make the external side resend, and `_inbound_to_conversation`'s callers fall to the retired memo path on one). The skip is logged and leaves ONE audit row for the organization's admin
    (no message words, no external user name: ids and the reason only), at most one per (mapping, reason) in an hour so a busy channel does not flood the log. A failure to write the row never changes the answer."""
    from app.models.audit import AuditLog

    logger.warning(
        "bridge inbound skipped platform=%s mapping=%s conversation=%s conversation_project=%s mapping_project=%s author=%s reason=%s",
        platform, mapping_id, conv.id, conv.project_id, mapping_project_id, author_id, reason,
    )
    try:
        async with session.begin_nested():
            # one (mapping, reason) at a time: two inbound lines that skip together would both find no recent row and both write one. The lock is held to the end of the transaction — the commit below —
            # so a waiter reads the committed row.
            await session.execute(
                text("SELECT pg_advisory_xact_lock(hashtextextended(:k, 0))"), {"k": f"{org_id}:{mapping_id}:{reason}"},
            )
            recent = (await session.execute(
                select(AuditLog.id).where(
                    AuditLog.org_id == org_id,
                    AuditLog.action == BRIDGE_SKIPPED_ACTION,
                    AuditLog.created_at > datetime.now(timezone.utc) - _BRIDGE_SKIP_AUDIT_WINDOW,
                    AuditLog.audit_metadata["mapping_id"].astext == str(mapping_id),
                    AuditLog.audit_metadata["reason"].astext == reason,
                ).limit(1)
            )).scalar_one_or_none()
            if recent is None:
                session.add(AuditLog(
                    org_id=org_id, actor_id=author_id, action=BRIDGE_SKIPPED_ACTION,
                    audit_metadata={
                        "platform": platform, "mapping_id": str(mapping_id) if mapping_id else None,
                        "mapping_project_id": str(mapping_project_id), "conversation_id": str(conv.id),
                        "conversation_project_id": str(conv.project_id) if conv.project_id else None, "reason": reason,
                    },
                ))
                await session.flush()
        await session.commit()
    except Exception:  # noqa: BLE001 — the trace is best effort; the inbound answer stays 200
        logger.warning("bridge inbound skip audit row failed mapping=%s reason=%s", mapping_id, reason, exc_info=True)
        try:
            await session.rollback()
        except Exception:  # noqa: BLE001
            pass
    return {"action": "skipped", "detail": reason}


async def _inbound_to_conversation(
    session: AsyncSession,
    conversation_id: uuid.UUID,
    author_id: uuid.UUID,
    content: str,
    external_thread_ts: str | None,
    message_ts: str | None = None,
    *,
    org_id: uuid.UUID,
    mapping_project_id: uuid.UUID,
    mapping_id: uuid.UUID | None = None,
    platform: str | None = None,
) -> dict:
    """external inbound → ConversationMessage 생성.

    RC1: root 저장 시 external_message_ts=message_ts, reply 탐색 시 동일 키로 root 검색.

    story 5049 — the author is a member of the MAPPING's project (that is how the author is found), so the room must be that project's too: a room of another project, or one with no project, is skipped
    (`conversation_project_mismatch`), and so is a DM of the mapping's own project (`conversation_is_dm`). A project's CHANNEL is stricter: only an author who is already seated in it and holds the project NOW may write there (`channel_author_not_seated` ·
    `channel_author_lost_project`) — the bridge never seats anyone in a channel. An ordinary room of the same project keeps what it always did (the author joins it by speaking).
    """
    from app.models.conversation import Conversation, ConversationMessage, ConversationParticipant

    conv = await session.get(Conversation, conversation_id)
    if conv is None:
        return {"action": "error", "detail": "conversation_not_found"}
    if conv.org_id != org_id:
        # story #4502 (4500's leftover): the mapping's conversation id is written by hand (no API writes these rows); one that
        # points at another org's conversation is refused before its author joins it or posts. The caller then falls to the
        # retired memo path (`create_memo` raises NotImplementedError — E-MEMO-RETIRE, bridge_inbound.py), so the request ends
        # in a 500 and the message is lost — the same as for a missing conversation (Qadir 4916; not new with this check)
        return {"action": "error", "detail": "conversation_not_in_org"}

    # story 5049 — nothing below (the seat, the message) happens in a room the mapping's project does not own
    skip = dict(conv=conv, author_id=author_id, org_id=org_id, mapping_project_id=mapping_project_id, mapping_id=mapping_id, platform=platform)
    if conv.project_id is None or conv.project_id != mapping_project_id:
        return await _skip_inbound(session, "conversation_project_mismatch", **skip)
    if conv.type == "dm":  # a DM's participant rows ARE «the two of them» — an external line must never seat a third (even in the mapping's own project)
        return await _skip_inbound(session, "conversation_is_dm", **skip)

    # 참여자 등록 (없으면 추가)
    seat_query = select(ConversationParticipant.id).where(
        ConversationParticipant.conversation_id == conversation_id,
        ConversationParticipant.member_id == author_id,
    )
    if conv.is_project_channel:
        # a channel's access is taken away by deleting the seat (+ the access row) in one transaction: lock the seat row FOR SHARE until THIS transaction ends, so a revoke that comes between the check
        # below and the message's commit waits for the message («message first, revoke after») — and one already running is waited for here, so the seat is gone when it is read
        seat_query = seat_query.with_for_update(read=True, of=ConversationParticipant)
    existing_participant = (await session.execute(seat_query)).scalar_one_or_none()
    if conv.is_project_channel:
        if existing_participant is None:
            return await _skip_inbound(session, "channel_author_not_seated", **skip)
        from app.services.conversation_auth import members_holding_channel_project

        if author_id not in await members_holding_channel_project(
            session, is_project_channel=True, project_id=conv.project_id, org_id=org_id, member_ids={author_id},
        ):
            return await _skip_inbound(session, "channel_author_lost_project", **skip)
    if existing_participant is None:
        session.add(ConversationParticipant(conversation_id=conversation_id, member_id=author_id))
        await session.flush()

    thread_id: uuid.UUID | None = None
    if external_thread_ts:
        # RC1: external_message_ts == threadTs로 root 탐색
        root_candidate = (await session.execute(
            select(ConversationMessage).where(
                ConversationMessage.conversation_id == conversation_id,
                ConversationMessage.thread_id.is_(None),
                ConversationMessage.msg_metadata["external_message_ts"].as_string() == external_thread_ts,
            ).order_by(ConversationMessage.created_at, ConversationMessage.id).limit(1)
        )).scalar_one_or_none()
        if root_candidate:
            thread_id = root_candidate.id

    # RC1: root message에 external_message_ts 저장 (threadTs 없을 때만)
    if thread_id is None and message_ts:
        msg_metadata_val: dict | None = {"external_message_ts": message_ts}
    else:
        msg_metadata_val = None

    msg = ConversationMessage(
        conversation_id=conversation_id,
        sender_id=author_id,
        content=content,
        mentioned_ids=[],
        thread_id=thread_id,
        msg_metadata=msg_metadata_val,
    )
    session.add(msg)
    await session.flush()

    return {
        "action": "conversation_message_created",
        "conversation_id": str(conversation_id),
        "message_id": str(msg.id),
        "thread_id": str(thread_id) if thread_id else None,
    }


# ─── helpers ──────────────────────────────────────────────────────────────────

def _ok(data: object) -> JSONResponse:
    return JSONResponse({"data": data, "error": None, "meta": None})


def _err(code: str, message: str, status: int = 400) -> JSONResponse:
    return JSONResponse({"data": None, "error": {"code": code, "message": message}, "meta": None}, status_code=status)


def _memo_title(text: str, label: str | None) -> str:
    preview = (text.strip() or "Bridge message")[:80]
    return f"[{label}] {preview}" if label else preview


def _memo_content(platform: str, event: dict[str, Any], label: str | None) -> str:
    body = event.get("messageText", "").strip() or "(빈 메시지)"
    if not label:
        return body
    return f"[{label}]\n{platform}_user_id: {event.get('userId') or 'unknown'}\n\n{body}"


# ─── POST /api/v2/bridge/slack/events ─────────────────────────────────────────

@router.post("/slack/events", response_model=None)
async def slack_events(request: Request, session: AsyncSession = Depends(get_db)) -> JSONResponse:
    signing_secret = os.environ.get("SLACK_SIGNING_SECRET")
    if not signing_secret:
        return _err("CONFIGURATION_ERROR", "Slack signing secret not configured", 500)

    raw_body = (await request.body()).decode()
    if not verify_slack_signature(
        signing_secret,
        request.headers.get("x-slack-signature"),
        request.headers.get("x-slack-request-timestamp"),
        raw_body,
    ):
        return _err("UNAUTHORIZED", "Invalid Slack signature", 401)

    try:
        payload = json.loads(raw_body)
    except json.JSONDecodeError:
        return _err("BAD_REQUEST", "Invalid JSON body", 400)

    if payload.get("type") == "url_verification":
        return JSONResponse({"challenge": payload.get("challenge", "")})

    if payload.get("type") != "event_callback" or not payload.get("event"):
        return _ok({"action": "ignored"})

    event = payload["event"]
    channel_id = event.get("channel")

    repo = BridgeInboundRepository(session)
    mapping = await repo.find_channel_mapping("slack", channel_id)
    if not mapping:
        return _ok({"action": "ignored"})

    if not check_rate_limit(f"slack:{channel_id}"):
        return _ok({"action": "rate_limited", "memo_id": None, "notice_sent": False})

    user_id_val = event.get("user")
    if not user_id_val:
        return _ok({"action": "ignored"})

    norm_event = {
        "channelId": channel_id,
        "userId": user_id_val,
        "eventId": payload.get("event_id"),
        "messageText": event.get("text", ""),
        "messageTs": event.get("ts"),
        "threadTs": event.get("thread_ts"),
        "teamId": payload.get("team_id"),
        "raw": event,
    }

    org_id = uuid.UUID(str(mapping.org_id))
    project_id = uuid.UUID(str(mapping.project_id))

    user_mapping = await repo.find_user_mapping(org_id, project_id, "slack", user_id_val)
    author_id = (
        uuid.UUID(str(user_mapping.team_member_id)) if user_mapping
        else await repo.find_fallback_author(org_id, project_id)
    )
    if not author_id:
        return _ok({"action": "ignored"})

    label = None if user_mapping else "Slack 연동 미설정 사용자"
    content = _memo_content("slack", norm_event, label)

    # S-D2: conversation mapping 있으면 → ConversationMessage 생성 (fallback: memo)
    conv_id_str = (mapping.config or {}).get("conversation_id")
    if conv_id_str:
        try:
            result = await _inbound_to_conversation(
                session,
                uuid.UUID(conv_id_str),
                author_id,
                content,
                norm_event.get("threadTs"),
                message_ts=norm_event.get("messageTs"),
                org_id=org_id,
                mapping_project_id=project_id,
                mapping_id=uuid.UUID(str(mapping.id)),
                platform="slack",
            )
            if result.get("action") == "skipped":  # story 5049 — answered 200 at once: no memo fallback, no workflow hook, no resend storm
                return _ok(result)
            if result.get("action") == "error":
                raise ValueError(result["detail"])
            await session.commit()
            # Phase 6-1: bridge inbound message → process_event 훅
            try:
                from app.services.workflow_pipeline import process_event
                from app.services.rule_evaluator import EventContext
                await process_event(session, org_id, project_id, EventContext(
                    event_type="message.created",
                    trigger_type_slug="kickoff",
                    actor_id=str(author_id),
                    metadata={
                        "conversation_id": conv_id_str,
                        "message_id": result.get("message_id"),
                        "content_preview": (content or "")[:200],
                        "platform": "slack",
                        "project_id": str(project_id),
                        "org_id": str(org_id),
                    },
                ))
            except Exception:
                pass
            return _ok(result)
        except Exception:
            await session.rollback()  # RC2: dirty session 복구 후 memo fallback

    metadata = build_bridge_metadata("slack", norm_event)
    memo_id = await repo.create_memo(
        org_id=org_id,
        project_id=project_id,
        created_by=author_id,
        title=_memo_title(norm_event["messageText"], label),
        content=content,
        memo_type="memo",
        metadata=metadata,
        assigned_to=None,
    )
    await session.commit()
    return _ok({"action": "created", "memo_id": memo_id, "notice_sent": None})


# ─── POST /api/v2/bridge/slack/interactions ───────────────────────────────────

@router.post("/slack/interactions")
async def slack_interactions(request: Request, session: AsyncSession = Depends(get_db)) -> JSONResponse:
    signing_secret = os.environ.get("SLACK_SIGNING_SECRET")
    if not signing_secret:
        return JSONResponse({"text": "Slack signing secret missing"}, status_code=500)

    raw_body = (await request.body()).decode()
    if not verify_slack_signature(
        signing_secret,
        request.headers.get("x-slack-signature"),
        request.headers.get("x-slack-request-timestamp"),
        raw_body,
    ):
        return JSONResponse({"text": "Invalid Slack signature"}, status_code=401)

    form = parse_qs(raw_body)
    payload_raw = (form.get("payload") or [None])[0]
    if not payload_raw:
        return JSONResponse({"text": "Missing payload"}, status_code=400)

    try:
        payload: dict[str, Any] = json.loads(payload_raw)
    except json.JSONDecodeError:
        return JSONResponse({"text": "Invalid payload JSON"}, status_code=400)

    actions = payload.get("actions") or []
    action = actions[0] if actions else {}
    action_id = action.get("action_id", "")
    if action_id not in ("hitl_approve", "hitl_reject"):
        return JSONResponse({"response_type": "ephemeral", "text": "지원하지 않는 HITL action인."}, status_code=400)

    value_raw = action.get("value")
    try:
        request_id_str = json.loads(value_raw or "{}").get("requestId")
    except (json.JSONDecodeError, AttributeError):
        request_id_str = None

    if not request_id_str:
        return JSONResponse({"response_type": "ephemeral", "text": "HITL 요청 정보를 읽지 못한."}, status_code=400)

    slack_user_id = (payload.get("user") or {}).get("id")
    if not slack_user_id:
        return JSONResponse({"response_type": "ephemeral", "text": "Slack 사용자 정보를 확인하지 못한."})

    bridge_repo = BridgeInboundRepository(session)

    try:
        request_id = uuid.UUID(request_id_str)
    except ValueError:
        return JSONResponse({"response_type": "ephemeral", "text": "HITL 요청 ID가 유효하지 않는."}, status_code=400)

    # Fetch HITL request directly from DB (no hitl.py dependency)
    from sqlalchemy import text as sql_text
    hitl_result = await session.execute(
        sql_text("SELECT id, org_id, project_id, status FROM agent_hitl_requests WHERE id = :id"),
        {"id": str(request_id)},
    )
    hitl_row = hitl_result.mappings().one_or_none()
    if not hitl_row:
        return JSONResponse({"response_type": "ephemeral", "text": "HITL 요청을 찾지 못한."}, status_code=404)
    if hitl_row["status"] != "pending":
        return JSONResponse({"response_type": "ephemeral", "text": "이미 처리된 HITL 요청인."})

    org_id = uuid.UUID(str(hitl_row["org_id"]))
    project_id = uuid.UUID(str(hitl_row["project_id"]))

    user_mapping = await bridge_repo.find_user_mapping(org_id, project_id, "slack", slack_user_id)
    if not user_mapping:
        return JSONResponse({"response_type": "ephemeral", "text": "Slack 계정이 Sprintable 팀원에 연결되지 않은."})

    actor_id = uuid.UUID(str(user_mapping.team_member_id))
    new_status = "approved" if action_id == "hitl_approve" else "rejected"
    response_text = "Slack에서 승인한" if new_status == "approved" else f"{payload.get('user', {}).get('username', 'Slack admin')}가 Slack에서 거부한"
    now = datetime.now(timezone.utc)

    await session.execute(
        sql_text(
            "UPDATE agent_hitl_requests SET status = :status, response_text = :response_text, "
            "responded_by = :actor_id, responded_at = :now, updated_at = :now "
            "WHERE id = :id AND status = 'pending'"
        ),
        {"status": new_status, "response_text": response_text, "actor_id": str(actor_id), "now": now, "id": str(request_id)},
    )
    await session.commit()

    text_msg = "HITL 승인 처리한." if new_status == "approved" else "HITL 거부 처리한."
    return JSONResponse({"response_type": "ephemeral", "text": text_msg})


# ─── POST /api/v2/bridge/teams/events ─────────────────────────────────────────

@router.post("/teams/events")
async def teams_events(request: Request, session: AsyncSession = Depends(get_db)) -> JSONResponse:
    activity: dict[str, Any] | None = await request.json()
    if not activity:
        return JSONResponse({"error": "Invalid Teams activity payload"}, status_code=400)

    if activity.get("type") == "conversationUpdate":
        return JSONResponse({"ok": True})

    channel_data = activity.get("channelData") or {}
    channel = channel_data.get("channel") or {}
    source_channel_id = channel.get("id") or activity.get("conversation", {}).get("id")
    if not source_channel_id:
        return JSONResponse({"error": "Unable to resolve Teams source channel"}, status_code=400)

    repo = BridgeInboundRepository(session)
    mapping = await repo.find_channel_mapping("teams", source_channel_id)
    if not mapping:
        return JSONResponse({"ok": True, "skipped": "channel_not_mapped"})

    config = mapping.config or {}
    bot_app_id = config.get("botAppId")
    verified = await verify_teams_request(
        authorization_header=request.headers.get("authorization"),
        service_url=activity.get("serviceUrl"),
        bot_app_id=bot_app_id,
    )
    if not verified:
        return JSONResponse({"error": "Invalid Teams signature"}, status_code=401)

    if activity.get("type") != "message":
        return JSONResponse({"ok": True, "skipped": "ignored_activity"})

    from_user = activity.get("from") or {}
    user_aad_id = from_user.get("aadObjectId") or from_user.get("id")
    if not user_aad_id:
        return JSONResponse({"ok": True, "skipped": "no_user_id"})

    org_id = uuid.UUID(str(mapping.org_id))
    project_id = uuid.UUID(str(mapping.project_id))

    user_mapping = await repo.find_user_mapping(org_id, project_id, "teams", user_aad_id)
    author_id = (
        uuid.UUID(str(user_mapping.team_member_id)) if user_mapping
        else await repo.find_fallback_author(org_id, project_id)
    )
    if not author_id:
        return JSONResponse({"ok": True, "skipped": "no_author"})

    message_text = activity.get("text", "").strip()
    norm_event = {
        "channelId": source_channel_id,
        "userId": user_aad_id,
        "eventId": activity.get("id"),
        "messageText": message_text,
        "messageTs": activity.get("id"),
        "threadTs": None,
        "teamId": channel_data.get("team", {}).get("id"),
        "raw": activity,
    }

    label = None if user_mapping else "Microsoft Teams 연동 미설정 사용자"
    content = _memo_content("teams", norm_event, label)

    # S-D2: conversation mapping 있으면 → ConversationMessage 생성 (fallback: memo)
    conv_id_str = (mapping.config or {}).get("conversation_id")
    if conv_id_str:
        try:
            result = await _inbound_to_conversation(
                session,
                uuid.UUID(conv_id_str),
                author_id,
                content,
                norm_event.get("threadTs"),
                message_ts=norm_event.get("messageTs"),
                org_id=org_id,
                mapping_project_id=project_id,
                mapping_id=uuid.UUID(str(mapping.id)),
                platform="teams",
            )
            if result.get("action") == "skipped":  # story 5049 — see the Slack entrance
                return JSONResponse({"ok": True, "skipped": result["detail"], "result": result})
            if result.get("action") == "error":
                raise ValueError(result["detail"])
            await session.commit()
            # Phase 6-1: bridge inbound message → process_event 훅
            try:
                from app.services.workflow_pipeline import process_event
                from app.services.rule_evaluator import EventContext
                await process_event(session, org_id, project_id, EventContext(
                    event_type="message.created",
                    trigger_type_slug="kickoff",
                    actor_id=str(author_id),
                    metadata={
                        "conversation_id": conv_id_str,
                        "message_id": result.get("message_id"),
                        "content_preview": (content or "")[:200],
                        "platform": "teams",
                        "project_id": str(project_id),
                        "org_id": str(org_id),
                    },
                ))
            except Exception:
                pass
            return JSONResponse({"ok": True, "result": result})
        except Exception:
            await session.rollback()  # RC2: dirty session 복구 후 memo fallback

    metadata = build_bridge_metadata("teams", norm_event)
    memo_id = await repo.create_memo(
        org_id=org_id,
        project_id=project_id,
        created_by=author_id,
        title=_memo_title(message_text, label),
        content=content,
        memo_type="memo",
        metadata=metadata,
        assigned_to=None,
    )
    await session.commit()
    return JSONResponse({"ok": True, "result": {"action": "created", "memoId": memo_id}})
