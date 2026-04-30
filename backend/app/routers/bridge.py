from __future__ import annotations

import json
import os
import uuid
from datetime import datetime, timezone
from typing import Any
from urllib.parse import parse_qs

from fastapi import APIRouter, Depends, Request
from fastapi.responses import JSONResponse
from sqlalchemy.ext.asyncio import AsyncSession

from sqlalchemy import select, update

from app.dependencies.database import get_db
from app.repositories.bridge_inbound import BridgeInboundRepository, build_bridge_metadata, check_rate_limit
from app.utils.slack_verify import verify_slack_signature
from app.utils.teams_verify import verify_teams_request

router = APIRouter(prefix="/api/v2/bridge", tags=["bridge"])


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
    metadata = build_bridge_metadata("slack", norm_event)

    memo_id = await repo.create_memo(
        org_id=org_id,
        project_id=project_id,
        created_by=author_id,
        title=_memo_title(norm_event["messageText"], label),
        content=_memo_content("slack", norm_event, label),
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
    metadata = build_bridge_metadata("teams", norm_event)

    memo_id = await repo.create_memo(
        org_id=org_id,
        project_id=project_id,
        created_by=author_id,
        title=_memo_title(message_text, label),
        content=_memo_content("teams", norm_event, label),
        memo_type="memo",
        metadata=metadata,
        assigned_to=None,
    )
    await session.commit()
    return JSONResponse({"ok": True, "result": {"action": "created", "memoId": memo_id}})
