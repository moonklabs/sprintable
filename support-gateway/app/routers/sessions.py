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
from app.models import SupportConversation, SupportMessage, SupportSession
from app.rate_limit import limiter
from app.schemas import MessageCreateRequest, MessageExchangeResponse, MessageResponse, SessionResponse
from app.token_verify import DelegatedIdentity, require_delegated_identity

router = APIRouter(prefix="/api/v1", tags=["sessions"])


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
        db, conversation=conv, org_id=identity.org_id, customer_text=customer_message.content
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

    return MessageExchangeResponse(
        customer_message=MessageResponse(
            id=customer_message.id,
            conversation_id=customer_message.conversation_id,
            role=customer_message.role,
            created_at=customer_message.created_at,
        ),
        agent_message=MessageResponse(
            id=agent_message.id,
            conversation_id=agent_message.conversation_id,
            role=agent_message.role,
            created_at=agent_message.created_at,
        ),
        escalated=turn.escalated,
    )
