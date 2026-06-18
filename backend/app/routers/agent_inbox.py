"""S-COMM-07: 에이전트별 전용 inbox webhook endpoint.

AC1: POST /api/v2/agent-inbox/{agent_id}/webhook — 외부 JSON POST → events 테이블 적재
AC2: agent_id 유효성 검증 — team_members에 없으면 404
AC3: HMAC 서명 검증 — X-Sprintable-Signature (sha256=HEX)
"""
from __future__ import annotations

import hashlib
import hmac
import json
import logging
import uuid

from fastapi import APIRouter, Depends, Header, HTTPException, Request
from sqlalchemy import select
from sqlalchemy.ext.asyncio import AsyncSession

from app.core.config import settings
from app.dependencies.database import get_db
from app.models.event import Event
from app.models.team import TeamMember

logger = logging.getLogger(__name__)
router = APIRouter(prefix="/api/v2/agent-inbox", tags=["agent-inbox"])


def _verify_signature(raw_body: bytes, signature_header: str | None) -> bool:
    secret = settings.agent_inbox_webhook_secret
    if not secret:
        return False  # secret 미설정 시 open ingestion 차단 — 반드시 설정 필요
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

    # 2c457a06 true-routing: 에이전트의 전 grant 조회(team_members projection VIEW — 멀티프로젝트면
    # org_id 동형·project_id 다양). payload 가 타겟 project_id 를 **명시**하고 그게 grant 에 속하면 그
    # project 로 Event 라우팅, 아니면 deterministic default(최저 project_id). org_id 는 전 행 동형.
    rows = (await db.execute(
        select(TeamMember.org_id, TeamMember.project_id).where(
            TeamMember.id == agent_id,
            TeamMember.type == "agent",
            TeamMember.is_active.is_(True),
        ).order_by(TeamMember.project_id)
    )).all()
    if not rows:
        raise HTTPException(status_code=404, detail="Agent not found")
    org_id = rows[0][0]
    granted_project_ids = [r[1] for r in rows]

    try:
        payload: dict = json.loads(raw_body) if raw_body else {}
    except (ValueError, UnicodeDecodeError):
        payload = {"raw": raw_body.decode("utf-8", errors="replace")}

    # 명시 project_id 우선 — 단 ⚠️ grant 에 속한 project 만 허용(외부 발신자가 임의 project 로 Event 를
    # 심는 IDOR 차단). 미명시/미grant/파싱불가 = deterministic default(전달은 무중단·default 도 agent
    # 가 속한 project 라 안전). 결정: 미grant 명시값은 reject 아닌 default fallback(best-effort 전달 우선).
    project_id = granted_project_ids[0]
    _raw_pid = payload.get("project_id")
    if _raw_pid:
        try:
            _req_pid = uuid.UUID(str(_raw_pid))
            if _req_pid in granted_project_ids:
                project_id = _req_pid
            else:
                logger.warning(
                    "agent_inbox: payload project_id=%s 가 agent=%s grant 밖 — default 라우팅",
                    _req_pid, agent_id,
                )
        except (ValueError, TypeError):
            logger.warning("agent_inbox: payload project_id 파싱 실패(%r) — default 라우팅", _raw_pid)

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
