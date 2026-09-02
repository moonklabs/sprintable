"""story #3264(지원v1·6방어·계측) AC3/AC4 — 어드민 계측 조회. 고객 위임 토큰 축과 완전히
분리된 인증(app/token_verify.py::require_admin) — org 스코프 개념이 없는 내부 운영
엔드포인트다. /metrics의 고객 대화 원문(SupportMessage.content) 절대 미반환 원칙은 그
엔드포인트 전용(집계 API 경계) — org 격리 원칙이 "고객 데이터"에 적용되는 것이지, 우리
자신의 운영 지표 열람에는 안 적용된다는 점을 명확히 한다.

story #3282(지원운영 어드민 관제, 2026-09-01 PO 판정 반영) — /conversations·
/conversations/{id}/messages는 위 원칙이 적용 안 되는 별개 엔드포인트군이다: sprintable-admin
운영 콘솔(IAP 게이트)이 고객 문의 원문을 항시 열람(에스컬 여부 무관, 선생님 확定 방향①)하는
것 자체가 업무인 별개 신뢰 표면이라는 게 PO 판정(설계 doc §2-b, entity:doc:
e8aa483d-bff6-4d78-ac7f-dacc86d615f5). 그 대가로 두 조건이 이 파일 안에 강제된다:
(1) 호출 시마다 operator_identity를 로그로 남긴다(durable 감사 로그 자체는 internal-api
쪽 책임 — 설계 doc §5, gateway는 "누가 봤는지"까지 저장할 fleet 자격을 새로 안 받는다),
(2) org 격리는 internal-api의 require_operator 층에서 통제한다는 전제 — 이 라우터 자체는
require_admin(정적 토큰, org 스코프 없음) 그대로라 org_id는 순수 필터일 뿐 인가 경계가
아니다."""
from __future__ import annotations

import logging
import uuid
from datetime import datetime, timedelta, timezone

from fastapi import APIRouter, Depends, Header, HTTPException, Query
from sqlalchemy import select
from sqlalchemy.ext.asyncio import AsyncSession

from app.config import settings
from app.db import get_db
from app.metrics import compute_resolution_metrics
from app.models import SupportConversation, SupportEscalation, SupportMessage
from app.schemas import (
    AdminConversationListResponse,
    AdminConversationMessagesResponse,
    AdminConversationSummary,
    AdminMetricsResponse,
    MessageResponse,
)
from app.token_verify import require_admin

logger = logging.getLogger(__name__)

router = APIRouter(prefix="/api/v1/admin", tags=["admin"], dependencies=[Depends(require_admin)])


@router.get("/metrics", response_model=AdminMetricsResponse)
async def get_metrics(
    db: AsyncSession = Depends(get_db),
    org_id: uuid.UUID | None = Query(default=None),
    since_days: int = Query(default=7, ge=1, le=90),
) -> AdminMetricsResponse:
    since = datetime.now(timezone.utc) - timedelta(days=since_days)
    metrics = await compute_resolution_metrics(db, since=since, org_id=org_id)
    return AdminMetricsResponse(
        window_since=since,
        org_id=org_id,
        total_turns=metrics.total_turns,
        escalated_turns=metrics.escalated_turns,
        resolved_turns=metrics.resolved_turns,
        resolution_rate=metrics.resolution_rate,
        escalation_rate=metrics.escalation_rate,
        cost_cap_org_daily_usd=settings.cost_cap_org_daily_usd,
        cost_cap_org_session_usd=settings.cost_cap_org_session_usd,
    )


@router.get("/conversations", response_model=AdminConversationListResponse)
async def list_conversations(
    db: AsyncSession = Depends(get_db),
    org_id: uuid.UUID | None = Query(default=None),
    limit: int = Query(default=100, ge=1, le=500),
    x_operator_identity: str = Header(default="unknown"),
) -> AdminConversationListResponse:
    """story #3282 — 방향① 확定(선생님 13:45): 에스컬 여부 무관, org 전체 지원 대화를 항시
    열람 가능해야 한다. org_id 생략 시 전 org 대상(전체 관제 뷰).

    x_operator_identity는 internal-api가 실은 "그 호출을 시킨 운영자"의 신원을 실은 것이다
    — 이 함수는 인가 판단에 안 쓴다(gateway가 fleet 자격을 새로 받는 게 아니다, require_admin
    통과 여부만 본다) — 로그 문자열로만 소비한다(모듈 docstring 참고, durable 기록은
    internal-api 책임)."""
    logger.info("admin conversation list access operator=%s org_id=%s", x_operator_identity, org_id)

    stmt = select(SupportConversation).order_by(SupportConversation.created_at.desc()).limit(limit)
    if org_id is not None:
        stmt = stmt.where(SupportConversation.org_id == org_id)
    conversations = (await db.execute(stmt)).scalars().all()

    conv_ids = [c.id for c in conversations]
    escalation_map: dict[uuid.UUID, list[uuid.UUID]] = {cid: [] for cid in conv_ids}
    if conv_ids:
        rows = (
            await db.execute(
                select(SupportEscalation.conversation_id, SupportEscalation.id).where(
                    SupportEscalation.conversation_id.in_(conv_ids)
                )
            )
        ).all()
        for conversation_id, escalation_id in rows:
            escalation_map[conversation_id].append(escalation_id)

    return AdminConversationListResponse(
        conversations=[
            AdminConversationSummary(
                id=c.id,
                org_id=c.org_id,
                external_user_id=c.external_user_id,
                created_at=c.created_at,
                ended_at=c.ended_at,
                escalation_ids=escalation_map[c.id],
            )
            for c in conversations
        ]
    )


@router.get("/conversations/{conversation_id}/messages", response_model=AdminConversationMessagesResponse)
async def get_conversation_messages(
    conversation_id: uuid.UUID,
    db: AsyncSession = Depends(get_db),
    x_operator_identity: str = Header(default="unknown"),
) -> AdminConversationMessagesResponse:
    """story #3282 — 원문 전체 반환(에스컬 필터 없음). 모듈 docstring의 "원문 절대 반환
    안 함" 원칙은 /metrics 전용이라 이 엔드포인트엔 적용되지 않는다(별개 신뢰 표면, PO 판정)."""
    conv = (
        await db.execute(select(SupportConversation).where(SupportConversation.id == conversation_id))
    ).scalar_one_or_none()
    if conv is None:
        raise HTTPException(status_code=404, detail="conversation not found")

    logger.info(
        "admin conversation transcript access operator=%s conversation_id=%s org_id=%s",
        x_operator_identity, conversation_id, conv.org_id,
    )

    messages = (
        await db.execute(
            select(SupportMessage)
            .where(SupportMessage.conversation_id == conversation_id)
            .order_by(SupportMessage.created_at.asc())
        )
    ).scalars().all()

    return AdminConversationMessagesResponse(
        conversation_id=conversation_id,
        org_id=conv.org_id,
        messages=[
            MessageResponse(
                id=m.id, conversation_id=m.conversation_id, role=m.role, content=m.content, created_at=m.created_at
            )
            for m in messages
        ],
    )
