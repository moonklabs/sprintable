import uuid

from fastapi import APIRouter, Depends, HTTPException, Query
from pydantic import BaseModel
from sqlalchemy import select
from sqlalchemy.ext.asyncio import AsyncSession

from app.dependencies.auth import AuthContext, get_current_user, get_verified_org_id
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


async def _get_caller_member_id(
    auth: AuthContext = Depends(get_current_user),
    session: AsyncSession = Depends(get_db),
) -> uuid.UUID:
    """caller 의 canonical member_id — webhook-config 는 멤버 소유 리소스라 소유 스코프 강제(IDOR 차단).
    레거시 휴먼 tm.id→members.id 정규화(저장된 member_id 와 동형 매칭)."""
    from app.services.member_resolver import canonicalize_member_id
    return await canonicalize_member_id(uuid.UUID(auth.user_id), session)


@router.get("/config", response_model=list[WebhookConfigResponse])
async def list_webhook_configs(
    project_id: uuid.UUID | None = Query(default=None),
    repo: WebhookConfigRepository = Depends(_get_repo),
    caller_member_id: uuid.UUID = Depends(_get_caller_member_id),
) -> list[WebhookConfigResponse]:
    # IDOR(산티아고): caller member-scope — org_id 만이면 same-org 타 멤버 config(URL) 가 leak.
    items = await repo.list(member_id=caller_member_id, project_id=project_id)
    return [WebhookConfigResponse.model_validate(i) for i in items]


@router.put("/config", response_model=WebhookConfigResponse)
async def upsert_webhook_config(
    body: UpsertWebhookConfig,
    repo: WebhookConfigRepository = Depends(_get_repo),
    caller_member_id: uuid.UUID = Depends(_get_caller_member_id),
) -> WebhookConfigResponse:
    # IDOR(산티아고): member_id 는 **auth context 서 산출**(body.member_id 불신·무시) — caller 는 자기
    # 소유 config 만 생성/수정한다. body 에 타 멤버 id 를 넣어도 caller 로 강제되어 무해(타 멤버 설정 불가).
    config = await repo.upsert(
        member_id=caller_member_id,
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
    caller_member_id: uuid.UUID = Depends(_get_caller_member_id),
) -> dict:
    # IDOR: 소유 검증 삭제 — 타 멤버 config_id 면 0행 → 404(타 org/타 멤버 동형).
    ok = await repo.delete(id, caller_member_id)
    if not ok:
        raise HTTPException(status_code=404, detail="WebhookConfig not found")
    return {"ok": True}


@router.post("/config/{config_id}/test-send", status_code=200)
async def test_send_webhook_config(
    config_id: uuid.UUID,
    repo: WebhookConfigRepository = Depends(_get_repo),
    caller_member_id: uuid.UUID = Depends(_get_caller_member_id),
) -> dict:
    """0a6487c6-BE AC2/3: 알림 목적지 자가진단 — 합성 'TEST' 알림 1발 후 도달 결과 반환.

    **소유 검증 조회(get_owned·id+org+member·IDOR)**: 타 멤버 config_id 로 그 webhook 에 test-send
    불가(404). SSRF 재검증은 deliver_test_webhook 책임.
    **계약 lock(FE 1:1 소비)**: ``{ok, reached, reason?, ts}`` — ok=요청 처리됨, reached=목적지 2xx,
    reason=미도달 사유(도달 시 생략), ts=발사 시각.
    """
    from datetime import datetime, timezone

    from app.services.webhook_dispatch import deliver_test_webhook

    config = await repo.get_owned(config_id, caller_member_id)
    if config is None:
        raise HTTPException(status_code=404, detail="WebhookConfig not found")

    ts = datetime.now(timezone.utc).isoformat()
    reached, reason = await deliver_test_webhook(config.url, config.secret)
    result: dict = {"ok": True, "reached": reached, "ts": ts}
    if reason:
        result["reason"] = reason
    return result


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
