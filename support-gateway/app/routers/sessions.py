"""story #3259 AC3 — 위젯용 세션 API. 모든 쿼리는 위임 토큰의 org_id로 스코프된다(요청
바디/경로 파라미터의 org_id는 신뢰하지 않는다 — 애초에 받지도 않는다). org 소속 불일치는
404로 판정한다(존재 자체를 노출하지 않는 것이 403보다 안전측 — backend CI의
`has_project_access 403 lint` 관례와 동일 철학, story #2342 참고, 이 서비스는 별도 코드베이스라
그 lint 대상은 아니지만 규율은 따른다)."""
from __future__ import annotations

import uuid

from fastapi import APIRouter, Depends, HTTPException, Request
from sqlalchemy import select
from sqlalchemy.ext.asyncio import AsyncSession

from app.config import settings
from app.db import get_db
from app.injection_defense import sanitize_customer_text
from app.interaction import handle_turn
from app.models import SupportConversation, SupportEscalation, SupportMessage, SupportSession
from app.rate_limit import limiter
from app.schemas import (
    MessageCreateRequest,
    MessageExchangeResponse,
    MessageListResponse,
    MessageResponse,
    SessionResponse,
)
from app.token_verify import DelegatedIdentity, require_delegated_identity

router = APIRouter(prefix="/api/v1", tags=["sessions"])


def _to_message_response(message: SupportMessage) -> MessageResponse:
    return MessageResponse(
        id=message.id,
        conversation_id=message.conversation_id,
        role=message.role,
        content=message.content,
        created_at=message.created_at,
    )


async def _conversation_escalation_status(db: AsyncSession, conversation_id: uuid.UUID) -> str | None:
    """story #3263 AC4 — 대화 레벨 에스컬레이션 상태. "가장 최근 1건"이 아니라 "지금 열려있는
    게 하나라도 있는가"로 판정한다 — created_at 정렬(초 단위 해상도, SQLite CURRENT_TIMESTAMP)
    로는 근접 시각에 생긴 두 행의 선후를 신뢰할 수 없고, 무엇보다 고객이 실제로 궁금한 건
    "지금 사람이 아직 보고 있는가"이지 "가장 최근 사건이 뭐였는가"가 아니다 — 열린 게
    하나라도 있으면 과거에 resolved된 게 더 최근에 안 걸려도 open이 맞다."""
    statuses = (
        await db.execute(
            select(SupportEscalation.status).where(SupportEscalation.conversation_id == conversation_id)
        )
    ).scalars().all()
    if not statuses:
        return None
    return "open" if "open" in statuses else "resolved"


async def _get_or_create_conversation(
    db: AsyncSession, session: SupportSession, org_id: uuid.UUID
) -> SupportConversation:
    """org당 1스레드 계승(Blueprint v0.3 §1.1) — 재사용/만료 정책 자체는 story #3(오케스트레이션)
    스코프. 여기서는 "org_id로 스코프된 최신 conversation을 찾거나 만든다"까지만."""
    existing = (
        await db.execute(
            select(SupportConversation)
            .where(SupportConversation.org_id == org_id)
            .order_by(SupportConversation.created_at.desc())
            .limit(1)
        )
    ).scalar_one_or_none()
    if existing is not None:
        return existing
    conv = SupportConversation(org_id=org_id, session_id=session.id)
    db.add(conv)
    await db.flush()
    return conv


@router.post("/sessions", response_model=SessionResponse)
@limiter.limit(lambda: settings.session_rate_limit)
async def create_or_resume_session(
    request: Request,
    identity: DelegatedIdentity = Depends(require_delegated_identity),
    db: AsyncSession = Depends(get_db),
) -> SessionResponse:
    request.state.delegated_org_id = str(identity.org_id)
    existing = (
        await db.execute(
            select(SupportSession).where(
                SupportSession.org_id == identity.org_id,
                SupportSession.external_user_id == identity.user_id,
                SupportSession.expired_at.is_(None),
            )
        )
    ).scalar_one_or_none()
    if existing is not None:
        await db.commit()
        return SessionResponse(id=existing.id, org_id=existing.org_id, created_at=existing.created_at)

    session = SupportSession(org_id=identity.org_id, external_user_id=identity.user_id)
    db.add(session)
    await db.commit()
    await db.refresh(session)
    return SessionResponse(id=session.id, org_id=session.org_id, created_at=session.created_at)


@router.post("/sessions/{session_id}/messages", response_model=MessageExchangeResponse)
@limiter.limit(lambda: settings.session_rate_limit)
async def post_message(
    request: Request,
    session_id: uuid.UUID,
    body: MessageCreateRequest,
    identity: DelegatedIdentity = Depends(require_delegated_identity),
    db: AsyncSession = Depends(get_db),
) -> MessageExchangeResponse:
    request.state.delegated_org_id = str(identity.org_id)
    # org_id를 WHERE에 태워 스코프 — 타 org의 session_id를 넣어도 0행(404), 존재 노출 없음.
    session = (
        await db.execute(
            select(SupportSession).where(
                SupportSession.id == session_id,
                SupportSession.org_id == identity.org_id,
            )
        )
    ).scalar_one_or_none()
    if session is None:
        raise HTTPException(status_code=404, detail="session not found")

    conv = await _get_or_create_conversation(db, session, identity.org_id)

    customer_message = SupportMessage(
        conversation_id=conv.id,
        org_id=identity.org_id,
        role="customer",
        content=sanitize_customer_text(body.content),
    )
    db.add(customer_message)
    await db.flush()

    # story #3261 — 이 턴의 Interaction/Execution 루프. 실패 시(예: Vertex 일시 장애) 500이
    # 아니라 사람에게 정직하게 넘기는 편이 낫지만, v1은 그 fallback을 별도로 안 만든다 — 예외가
    # 나면 그대로 전파해 500(고객이 새로고침해 재시도)한다. 조용히 삼켜 "응답 없음"을 만드는
    # 쪽이 더 나쁘다(에러가 나면 시끄럽게 나야 한다).
    turn = await handle_turn(
        db, conversation=conv, org_id=identity.org_id, user_id=identity.user_id,
        customer_text=customer_message.content,
    )

    await db.commit()
    await db.refresh(customer_message)

    agent_message = (
        await db.execute(
            select(SupportMessage)
            .where(SupportMessage.conversation_id == conv.id, SupportMessage.role == "agent")
            .order_by(SupportMessage.created_at.desc())
            .limit(1)
        )
    ).scalar_one()

    escalation_status = await _conversation_escalation_status(db, conv.id)

    return MessageExchangeResponse(
        customer_message=_to_message_response(customer_message),
        agent_message=_to_message_response(agent_message),
        escalated=turn.escalated,
        escalation_status=escalation_status,
    )


@router.get("/sessions/{session_id}/messages", response_model=MessageListResponse)
@limiter.limit(lambda: settings.session_rate_limit)
async def list_messages(
    request: Request,
    session_id: uuid.UUID,
    identity: DelegatedIdentity = Depends(require_delegated_identity),
    db: AsyncSession = Depends(get_db),
) -> MessageListResponse:
    """story #3261 보완(2026-08-31, 페드루 PO 실 왕복 실측 지적) — 위젯 재오픈 시 대화 이력
    복원용. org 스코프는 위와 동형(session 자체를 org_id로 먼저 스코프 — 존재하지 않는
    session_id/타 org session_id 둘 다 404, 구분 안 됨)."""
    request.state.delegated_org_id = str(identity.org_id)
    session = (
        await db.execute(
            select(SupportSession).where(
                SupportSession.id == session_id,
                SupportSession.org_id == identity.org_id,
            )
        )
    ).scalar_one_or_none()
    if session is None:
        raise HTTPException(status_code=404, detail="session not found")

    conv = (
        await db.execute(
            select(SupportConversation)
            .where(SupportConversation.org_id == identity.org_id)
            .order_by(SupportConversation.created_at.desc())
            .limit(1)
        )
    ).scalar_one_or_none()
    if conv is None:
        return MessageListResponse(messages=[], escalation_status=None)

    messages = (
        await db.execute(
            select(SupportMessage)
            .where(SupportMessage.conversation_id == conv.id)
            .order_by(SupportMessage.created_at.asc())
        )
    ).scalars().all()
    escalation_status = await _conversation_escalation_status(db, conv.id)
    return MessageListResponse(
        messages=[_to_message_response(m) for m in messages], escalation_status=escalation_status
    )
