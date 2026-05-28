"""S-COMM-07: 에이전트별 전용 inbox webhook endpoint.

AC1: POST /api/v2/agent-inbox/{agent_id}/webhook — 외부 JSON POST → events 테이블 적재
AC2: agent_id 유효성 검증 — team_members에 없으면 404
AC3: HMAC 서명 검증 — X-Sprintable-Signature (sha256=HEX)
"""
from __future__ import annotations

import hashlib
import hmac
import json
import uuid

from fastapi import APIRouter, Depends, Header, HTTPException, Request
from sqlalchemy import select
from sqlalchemy.ext.asyncio import AsyncSession

from app.core.config import settings
from app.dependencies.database import get_db
from app.models.event import Event
from app.models.team import TeamMember

router = APIRouter(prefix="/api/v2/agent-inbox", tags=["agent-inbox"])


def _verify_signature(raw_body: bytes, signature_header: str | None) -> bool:
    secret = settings.agent_inbox_webhook_secret
    if not secret:
        return True
    if not signature_header:
        return False
    expected = hmac.new(secret.encode(), raw_body, hashlib.sha256).hexdigest()
    return hmac.compare_digest(expected, signature_header.removeprefix("sha256="))


@router.post("/{agent_id}/webhook", status_code=201)
async def receive_inbox_webhook(
    agent_id: uuid.UUID,
    request: Request,
    db: AsyncSession = Depends(get_db),
    x_sprintable_signature: str | None = Header(default=None),
) -> dict:
    """POST /api/v2/agent-inbox/{agent_id}/webhook — 외부 서비스 → 에이전트 inbox."""
    raw_body = await request.body()

    if not _verify_signature(raw_body, x_sprintable_signature):
        raise HTTPException(status_code=401, detail="Invalid webhook signature")

    result = await db.execute(
        select(TeamMember.org_id, TeamMember.project_id).where(
            TeamMember.id == agent_id,
            TeamMember.type == "agent",
            TeamMember.is_active.is_(True),
        )
    )
    row = result.one_or_none()
    if row is None:
        raise HTTPException(status_code=404, detail="Agent not found")

    org_id, project_id = row

    try:
        payload: dict = json.loads(raw_body) if raw_body else {}
    except (ValueError, UnicodeDecodeError):
        payload = {"raw": raw_body.decode("utf-8", errors="replace")}

    event_type = str(payload.get("event_type", "inbox_webhook"))
    source_entity_type: str | None = payload.get("source_entity_type")
    raw_source_id = payload.get("source_entity_id")
    try:
        source_entity_id: uuid.UUID | None = uuid.UUID(str(raw_source_id)) if raw_source_id else None
    except ValueError:
        source_entity_id = None

    event = Event(
        project_id=project_id,
        org_id=org_id,
        event_type=event_type,
        source_entity_type=source_entity_type,
        source_entity_id=source_entity_id,
        sender_id=None,
        recipient_id=agent_id,
        recipient_type="agent",
        payload=payload,
        status="pending",
    )
    db.add(event)
    await db.commit()
    await db.refresh(event)

    # AC4: SSE 즉시 push (연결 중인 에이전트에게 바로 전달)
    from app.routers.events import _push_to_agent
    _push_to_agent(str(agent_id), payload)

    return {"ok": True, "event_id": str(event.id)}
