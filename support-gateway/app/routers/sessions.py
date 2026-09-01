"""story #3259 AC3 — 위젯용 세션 API. 모든 쿼리는 위임 토큰의 org_id/external_user_id로
스코프된다(요청 바디/경로 파라미터는 신뢰하지 않는다 — 애초에 받지도 않는다). org 소속
불일치는 404로 판정한다(존재 자체를 노출하지 않는 것이 403보다 안전측 — backend CI의
`has_project_access 403 lint` 관례와 동일 철학, story #2342 참고, 이 서비스는 별도 코드베이스라
그 lint 대상은 아니지만 규율은 따른다).

story #3276(지원v1·후속) — 상담 대화 사용자 단위 분리. org는 절대 격리 경계(불변)지만,
같은 org 안에서도 대화는 (org_id, external_user_id) 단위로 갈린다 — 자세한 설계 근거는
app/models.py::SupportConversation 참고."""
from __future__ import annotations

import uuid
from datetime import datetime, timezone

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
    ConversationListResponse,
    ConversationResponse,
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


def _to_conversation_response(conv: SupportConversation, escalation_status: str | None) -> ConversationResponse:
    return ConversationResponse(
        id=conv.id,
        created_at=conv.created_at,
        ended_at=conv.ended_at,
        escalation_status=escalation_status,
    )


async def _conversation_escalation_status(db: AsyncSession, conversation_id: uuid.UUID) -> str | None:
    """story #3263 AC4 — 대화 레벨 에스컬레이션 상태. "가장 최근 1건"이 아니라 "지금 열려있는
    게 하나라도 있는가"로 판정한다 — created_at 정렬(초 단위 해상도, SQLite CURRENT_TIMESTAMP)
    로는 근접 시각에 생긴 두 행의 선후를 신뢰할 수 없고, 무엇보다 고객이 실제로 궁금한 건
    "지금 사람이 아직 보고 있는가"이지 "가장 최근 사건이 뭐였는가"가 아니다 — 열린 게
    하나라도 있으면 과거에 resolved된 게 더 최근에 안 걸려도 open이 맞다.

    story #3276 — conversation_id 단위 그대로다. (org_id, external_user_id) 스코프 분리는
    호출부(conversation을 어떻게 찾았는지)의 책임이지 이 함수는 손대지 않는다 — 스코프가
    올바르게 좁혀지면 이 함수는 코드 변경 없이 자동으로 per-user가 된다."""
    statuses = (
        await db.execute(
            select(SupportEscalation.status).where(SupportEscalation.conversation_id == conversation_id)
        )
    ).scalars().all()
    if not statuses:
        return None
    return "open" if "open" in statuses else "resolved"


async def _get_session_or_404(db: AsyncSession, *, session_id: uuid.UUID, identity: DelegatedIdentity) -> SupportSession:
    """story #3276 보강 — org_id뿐 아니라 external_user_id까지 일치해야 한다(위임 토큰
    소유자가 자기 세션만 조작 가능). 이전엔 org_id만 봐서, 같은 org의 타 사용자 session_id를
    안다면(추측·유출) 자기 토큰으로 그 세션을 조작할 수 있는 통로가 이론상 있었다 — 대화
    자체는 identity.user_id로 스코프돼 데이터 유출로 이어지진 않았지만(구 코드가 conversation을
    org_id로만 찾았으므로), 이 스토리로 조회 축을 조여둔 김에 세션 소유권도 같이 조인다."""
    session = (
        await db.execute(
            select(SupportSession).where(
                SupportSession.id == session_id,
                SupportSession.org_id == identity.org_id,
                SupportSession.external_user_id == identity.user_id,
            )
        )
    ).scalar_one_or_none()
    if session is None:
        raise HTTPException(status_code=404, detail="session not found")
    return session


async def _get_active_conversation(
    db: AsyncSession, *, org_id: uuid.UUID, external_user_id: uuid.UUID
) -> SupportConversation | None:
    return (
        await db.execute(
            select(SupportConversation)
            .where(
                SupportConversation.org_id == org_id,
                SupportConversation.external_user_id == external_user_id,
                SupportConversation.ended_at.is_(None),
            )
            .order_by(SupportConversation.created_at.desc())
            .limit(1)
        )
    ).scalar_one_or_none()


async def _get_or_create_active_conversation(
    db: AsyncSession, *, session: SupportSession, org_id: uuid.UUID, external_user_id: uuid.UUID
) -> SupportConversation:
    """story #3276 AC1 — (org_id, external_user_id)당 활성 상담 최대 1개(통례, 인터컴류).
    org_id만으로 찾던 구 _get_or_create_conversation을 대체 — 이제 같은 org 안에서도 남의
    대화에 절대 안 닿는다. ended_at IS NULL 필터가 핵심(종료된 상담은 여기서 안 잡히고
    자동으로 새 상담이 열린다 — "종료 후 재문의"의 자연스러운 통례 동작)."""
    existing = await _get_active_conversation(db, org_id=org_id, external_user_id=external_user_id)
    if existing is not None:
        return existing
    conv = SupportConversation(org_id=org_id, session_id=session.id, external_user_id=external_user_id)
    db.add(conv)
    await db.flush()
    return conv


async def _get_owned_conversation_or_404(
    db: AsyncSession, *, org_id: uuid.UUID, external_user_id: uuid.UUID, conversation_id: uuid.UUID
) -> SupportConversation:
    conv = (
        await db.execute(
            select(SupportConversation).where(
                SupportConversation.id == conversation_id,
                SupportConversation.org_id == org_id,
                SupportConversation.external_user_id == external_user_id,
            )
        )
    ).scalar_one_or_none()
    if conv is None:
        raise HTTPException(status_code=404, detail="conversation not found")
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
    session = await _get_session_or_404(db, session_id=session_id, identity=identity)

    # story #3276 — 항상 "현재 활성 상담"(없거나 종료됐으면 자동 신규)에 붙인다. 종료된
    # 상담에 굳이 conversation_id로 계속 쓰려는 시도 자체가 없다 — 이 엔드포인트는 conversation_id를
    # 받지 않는다(항상 활성 상담이 대상, 명시적 재개는 지원 안 함 — 종료=읽기전용이 곧
    # "다시 쓰려면 새 상담" 통례).
    conv = await _get_or_create_active_conversation(
        db, session=session, org_id=identity.org_id, external_user_id=identity.user_id
    )

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
    conversation_id: uuid.UUID | None = None,
) -> MessageListResponse:
    """story #3261 보완(2026-08-31) — 위젯 재오픈 시 대화 이력 복원용.

    story #3276 — `conversation_id` 쿼리 파라미터 추가: 지정하면 그 특정 상담(자기 것만,
    종료된 것 포함 — 읽기 전용 이력 열람)을 본다. 생략하면 "현재 활성 상담"을 본다(없으면
    빈 목록 — GET에서 새 상담을 만들지 않는다, 부작용 없는 조회가 원칙)."""
    request.state.delegated_org_id = str(identity.org_id)
    await _get_session_or_404(db, session_id=session_id, identity=identity)

    if conversation_id is not None:
        conv = await _get_owned_conversation_or_404(
            db, org_id=identity.org_id, external_user_id=identity.user_id, conversation_id=conversation_id
        )
    else:
        conv = await _get_active_conversation(db, org_id=identity.org_id, external_user_id=identity.user_id)
    if conv is None:
        return MessageListResponse(conversation_id=None, ended_at=None, messages=[], escalation_status=None)

    messages = (
        await db.execute(
            select(SupportMessage)
            .where(SupportMessage.conversation_id == conv.id)
            .order_by(SupportMessage.created_at.asc())
        )
    ).scalars().all()
    escalation_status = await _conversation_escalation_status(db, conv.id)
    return MessageListResponse(
        conversation_id=conv.id,
        ended_at=conv.ended_at,
        messages=[_to_message_response(m) for m in messages],
        escalation_status=escalation_status,
    )


@router.get("/sessions/{session_id}/conversations", response_model=ConversationListResponse)
@limiter.limit(lambda: settings.session_rate_limit)
async def list_conversations(
    request: Request,
    session_id: uuid.UUID,
    identity: DelegatedIdentity = Depends(require_delegated_identity),
    db: AsyncSession = Depends(get_db),
) -> ConversationListResponse:
    """story #3276 AC3 — 위젯 대화 목록(자기 것만, 통례 수준 — 미리보기 텍스트 등은 v1
    스코프 밖). created_at 최신순."""
    request.state.delegated_org_id = str(identity.org_id)
    await _get_session_or_404(db, session_id=session_id, identity=identity)

    conversations = (
        await db.execute(
            select(SupportConversation)
            .where(
                SupportConversation.org_id == identity.org_id,
                SupportConversation.external_user_id == identity.user_id,
            )
            .order_by(SupportConversation.created_at.desc())
        )
    ).scalars().all()
    items = [
        _to_conversation_response(conv, await _conversation_escalation_status(db, conv.id))
        for conv in conversations
    ]
    return ConversationListResponse(conversations=items)


@router.post("/sessions/{session_id}/conversations/start", response_model=ConversationResponse)
@limiter.limit(lambda: settings.session_rate_limit)
async def start_new_conversation(
    request: Request,
    session_id: uuid.UUID,
    identity: DelegatedIdentity = Depends(require_delegated_identity),
    db: AsyncSession = Depends(get_db),
) -> ConversationResponse:
    """story #3276 AC2 — 위젯 "새 상담 시작". 현재 활성 상담이 있으면 먼저 종료하고(명시
    액션이 곧 "이전 건 그만"이라는 의사표시 — 굳이 별도 end 호출을 먼저 강제하지 않는다),
    빈 새 상담을 만들어 돌려준다."""
    request.state.delegated_org_id = str(identity.org_id)
    session = await _get_session_or_404(db, session_id=session_id, identity=identity)

    active = await _get_active_conversation(db, org_id=identity.org_id, external_user_id=identity.user_id)
    if active is not None:
        active.ended_at = datetime.now(timezone.utc)

    conv = SupportConversation(org_id=identity.org_id, session_id=session.id, external_user_id=identity.user_id)
    db.add(conv)
    await db.commit()
    await db.refresh(conv)
    return _to_conversation_response(conv, escalation_status=None)


@router.post("/sessions/{session_id}/conversations/{conversation_id}/end", response_model=ConversationResponse)
@limiter.limit(lambda: settings.session_rate_limit)
async def end_conversation(
    request: Request,
    session_id: uuid.UUID,
    conversation_id: uuid.UUID,
    identity: DelegatedIdentity = Depends(require_delegated_identity),
    db: AsyncSession = Depends(get_db),
) -> ConversationResponse:
    """story #3276 AC2 — 위젯 "상담 종료". 종료된 상담=읽기 전용 이력(다음 메시지는 자동으로
    새 상담을 연다, post_message 참고). SupportEscalation.status는 손대지 않는다 — 종료는
    "이 대화창을 닫는다"는 뜻이지 "사람 연결이 해소됐다"는 뜻이 아니다(완전히 별개 축).
    이미 종료된 상담을 다시 종료해도 멱등하게 200(재시도 안전) — ended_at을 덮어쓰지 않는다
    (최초 종료 시각을 보존)."""
    request.state.delegated_org_id = str(identity.org_id)
    await _get_session_or_404(db, session_id=session_id, identity=identity)
    conv = await _get_owned_conversation_or_404(
        db, org_id=identity.org_id, external_user_id=identity.user_id, conversation_id=conversation_id
    )
    if conv.ended_at is None:
        conv.ended_at = datetime.now(timezone.utc)
        await db.commit()
        await db.refresh(conv)
    escalation_status = await _conversation_escalation_status(db, conv.id)
    return _to_conversation_response(conv, escalation_status)
