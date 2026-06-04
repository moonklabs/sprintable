import uuid

from fastapi import APIRouter, Depends, HTTPException, Query
from pydantic import BaseModel
from sqlalchemy import select
from sqlalchemy.ext.asyncio import AsyncSession

from app.dependencies.auth import get_verified_org_id
from app.dependencies.database import get_db
from app.models.conversation_webhook_delivery import ConversationWebhookDelivery
from app.repositories.webhook_config import WebhookConfigRepository
from app.schemas.webhook_config import UpsertWebhookConfig, WebhookConfigResponse

router = APIRouter(prefix="/api/v2/webhooks", tags=["webhooks"])


class DeliveryStatusResponse(BaseModel):
    id: str
    message_id: str
    webhook_config_id: str | None
    status: str  # event_created | webhook_posted | gateway_accepted | agent_replied | failed
    attempt_count: int
    last_error: str | None
    created_at: str
    updated_at: str | None

    model_config = {"from_attributes": True}


def _get_repo(
    session: AsyncSession = Depends(get_db),
    org_id: uuid.UUID = Depends(get_verified_org_id),
) -> WebhookConfigRepository:
    return WebhookConfigRepository(session, org_id)


@router.get("/config", response_model=list[WebhookConfigResponse])
async def list_webhook_configs(
    project_id: uuid.UUID | None = Query(default=None),
    repo: WebhookConfigRepository = Depends(_get_repo),
) -> list[WebhookConfigResponse]:
    items = await repo.list(project_id=project_id)
    return [WebhookConfigResponse.model_validate(i) for i in items]


@router.put("/config", response_model=WebhookConfigResponse)
async def upsert_webhook_config(
    body: UpsertWebhookConfig,
    repo: WebhookConfigRepository = Depends(_get_repo),
) -> WebhookConfigResponse:
    # AC3-2d(2): member_id canonical 정규화(레거시 휴먼 tm.id→members.id). (A) write. agent id는 no-op.
    from app.services.member_resolver import canonicalize_member_id
    member_id = await canonicalize_member_id(body.member_id, repo.session)
    config = await repo.upsert(
        member_id=member_id,
        url=body.url,
        project_id=body.project_id,
        events=body.events,
        is_active=body.is_active,
        secret=body.secret,
    )
    return WebhookConfigResponse.model_validate(config)


@router.delete("/config", status_code=200)
async def delete_webhook_config(
    id: uuid.UUID = Query(...),
    repo: WebhookConfigRepository = Depends(_get_repo),
) -> dict:
    ok = await repo.delete(id)
    if not ok:
        raise HTTPException(status_code=404, detail="WebhookConfig not found")
    return {"ok": True}


@router.get("/deliveries", response_model=list[DeliveryStatusResponse])
async def list_webhook_deliveries(
    message_id: uuid.UUID | None = Query(default=None),
    conversation_id: uuid.UUID | None = Query(default=None),
    limit: int = Query(default=20, ge=1, le=100),
    db: AsyncSession = Depends(get_db),
    _org_id: uuid.UUID = Depends(get_verified_org_id),
) -> list[DeliveryStatusResponse]:
    """GET /api/v2/webhooks/deliveries — message_id 또는 conversation_id 기준 delivery 상태 조회.

    AC3 (S-COMM-12): delivery 4단계 상태 디버깅용.
    status: event_created → webhook_posted → gateway_accepted → agent_replied | failed
    """
    if not message_id and not conversation_id:
        raise HTTPException(status_code=400, detail="message_id 또는 conversation_id 중 하나 필수")

    # ConversationMessage와 Conversation은 동일 파일(app/models/conversation.py)에 정의됨
    from app.models.conversation import Conversation, ConversationMessage

    if message_id:
        # org 스코핑: message → conversation → org_id 검증
        msg = (await db.execute(
            select(ConversationMessage)
            .join(Conversation, ConversationMessage.conversation_id == Conversation.id)
            .where(ConversationMessage.id == message_id, Conversation.org_id == _org_id)
        )).scalar_one_or_none()
        if msg is None:
            raise HTTPException(status_code=404, detail="Message not found")
        rows = (await db.execute(
            select(ConversationWebhookDelivery)
            .where(ConversationWebhookDelivery.message_id == message_id)
            .order_by(ConversationWebhookDelivery.created_at.desc())
            .limit(limit)
        )).scalars().all()
    else:
        # org 스코핑: conversation.org_id 검증
        conv = (await db.execute(
            select(Conversation)
            .where(Conversation.id == conversation_id, Conversation.org_id == _org_id)
        )).scalar_one_or_none()
        if conv is None:
            raise HTTPException(status_code=404, detail="Conversation not found")
        msg_ids = (await db.execute(
            select(ConversationMessage.id)
            .where(ConversationMessage.conversation_id == conversation_id)
            .order_by(ConversationMessage.created_at.desc())
            .limit(limit)
        )).scalars().all()
        rows = (await db.execute(
            select(ConversationWebhookDelivery)
            .where(ConversationWebhookDelivery.message_id.in_(msg_ids))
            .order_by(ConversationWebhookDelivery.created_at.desc())
            .limit(limit)
        )).scalars().all() if msg_ids else []

    return [
        DeliveryStatusResponse(
            id=str(r.id),
            message_id=str(r.message_id),
            webhook_config_id=str(r.webhook_config_id) if r.webhook_config_id else None,
            status=r.status,
            attempt_count=r.attempt_count,
            last_error=r.last_error,
            created_at=r.created_at.isoformat(),
            updated_at=r.updated_at.isoformat() if r.updated_at else None,
        )
        for r in rows
    ]
