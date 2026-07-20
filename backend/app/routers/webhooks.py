import uuid

from fastapi import APIRouter, Depends, HTTPException, Query
from pydantic import BaseModel
from sqlalchemy import select
from sqlalchemy.ext.asyncio import AsyncSession

from app.dependencies.auth import AuthContext, get_current_user, get_verified_org_id
from app.dependencies.database import get_db
from app.models.conversation_webhook_delivery import ConversationWebhookDelivery
from app.models.project import OrgMember
from app.models.team import TeamMember
from app.repositories.webhook_config import WebhookConfigRepository
from app.schemas.webhook_config import UpsertWebhookConfig, WebhookConfigResponse

router = APIRouter(prefix="/api/v2/webhooks", tags=["webhooks", "Organization"])


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
    org_id: uuid.UUID = Depends(get_verified_org_id),
    session: AsyncSession = Depends(get_db),
) -> uuid.UUID:
    """caller 의 **canonical member_id**(멤버-ssot SSOT `resolve_member`) — webhook-config 소유 스코프.

    휴먼 = org_member.id · 에이전트 = team_member.id. 이게 디스패치(conversation_participants.member_id,
    0092 이후 동일 canonical 축)와 정합하는 축이다.

    ⚠️ `canonicalize_member_id(auth.user_id)` 금지(축 버그): 휴먼은 `auth.user_id = users.id`(JWT sub,
    OrgMember.user_id로 매칭)이고 alias 는 team_member.id→org_member.id 전용이라 users.id 는 no-op →
    **users.id 축**으로 저장/스코프됨. 디스패치는 org_member.id 로 조회 → 0행 → webhook silent 미배달.
    에이전트는 `auth.user_id = team_member.id` 라 두 방식 동일(무회귀). resolve_member 가 양쪽 정합 보장.
    """
    from app.services.member_resolver import resolve_member
    resolved = await resolve_member(auth, org_id, session)
    return resolved.id


async def _resolve_target_member_id(
    target_id: uuid.UUID,
    org_id: uuid.UUID,
    session: AsyncSession,
) -> uuid.UUID:
    """story 933248fa — admin이 지정한 target(FE가 항상 보내는 TeamMember.id, 자기서비스 org-members-
    only 폴백 경로만 예외적으로 OrgMember.id)를 webhook_configs.member_id 정규형(휴먼=org_member.id·
    에이전트=team_member.id, `_get_caller_member_id`와 동일 축)으로 **서버측 재해소**한다.

    ⚠️SEC 규율①(PO 2026-07-15 확定): org 소속은 body의 org_id가 아니라 **caller의 검증된 org_id**로
    쿼리해 판정한다(body-claimed 금지) — target_id가 caller org 밖 것이면 그냥 못 찾은 것처럼 404
    (기존 get_owned/list IDOR 패턴과 동형, 존재 여부 누설 없음).
    """
    tm = (await session.execute(
        select(TeamMember).where(TeamMember.id == target_id, TeamMember.org_id == org_id)
    )).scalars().first()
    if tm is not None:
        if tm.type == "agent":
            return tm.id
        om = (await session.execute(
            select(OrgMember).where(OrgMember.user_id == tm.user_id, OrgMember.org_id == org_id)
        )).scalar_one_or_none()
        if om is None:
            raise HTTPException(status_code=404, detail="Member not found")
        return om.id
    # TeamMember.id가 아니면(자기서비스 org-members-only 폴백 — /me가 org_member.id를 직접 반환하는
    # 경로), target_id 자체가 OrgMember.id일 수 있다 — 동일 org 스코프로 재시도.
    om = (await session.execute(
        select(OrgMember).where(OrgMember.id == target_id, OrgMember.org_id == org_id)
    )).scalar_one_or_none()
    if om is None:
        raise HTTPException(status_code=404, detail="Member not found")
    return om.id


@router.get("/config", response_model=list[WebhookConfigResponse])
async def list_webhook_configs(
    project_id: uuid.UUID | None = Query(default=None),
    member_id: uuid.UUID | None = Query(default=None),
    repo: WebhookConfigRepository = Depends(_get_repo),
    caller_member_id: uuid.UUID = Depends(_get_caller_member_id),
    auth: AuthContext = Depends(get_current_user),
    org_id: uuid.UUID = Depends(get_verified_org_id),
    session: AsyncSession = Depends(get_db),
) -> list[WebhookConfigResponse]:
    """story 933248fa 재오픈 fix — PUT은 admin override가 있었지만 GET은 caller-scope 그대로라
    admin이 방금 저장한 타 멤버 webhook이 목록에 안 보였다(write_ok≠read_success).

    IDOR(산티아고) 원 방어는 **바이트 단위로 그대로 유지**: `?member_id=` 미지정 시 caller
    member-scope(org_id 만으로 same-org 타 멤버 config 전체가 leak되는 것 차단), 비-admin은
    `?member_id=`를 보내도 무조건 caller-scope로 강제(자기 자신 조회로 취급) — PUT과 동일
    SEC 규율②(admin/owner role 필수, JWT app_metadata.role — 서버 검증된 클레임).
    """
    scope_member_id = caller_member_id
    if member_id is not None:
        target_member_id = await _resolve_target_member_id(member_id, org_id, session)
        if target_member_id != caller_member_id:
            role = auth.claims.get("app_metadata", {}).get("role", "member")
            if role not in ("admin", "owner"):
                raise HTTPException(
                    status_code=403,
                    detail="Admin role required to view another member's webhook config",
                )
        scope_member_id = target_member_id
    items = await repo.list(member_id=scope_member_id, project_id=project_id)
    return [WebhookConfigResponse.model_validate(i) for i in items]


@router.put("/config", response_model=WebhookConfigResponse)
async def upsert_webhook_config(
    body: UpsertWebhookConfig,
    repo: WebhookConfigRepository = Depends(_get_repo),
    caller_member_id: uuid.UUID = Depends(_get_caller_member_id),
    auth: AuthContext = Depends(get_current_user),
    org_id: uuid.UUID = Depends(get_verified_org_id),
    session: AsyncSession = Depends(get_db),
) -> WebhookConfigResponse:
    """story 933248fa fix — 산티아고의 원 IDOR 방어(caller-only)는 비-admin 경로에 **바이트 단위로
    그대로 유지**한다. 추가된 것은 admin-scoped override 1개뿐:

    1. body.member_id(FE가 항상 보내는 TeamMember.id)를 caller org 스코프로 서버측 재해소해
       webhook_configs 정규 축(휴먼=org_member.id·에이전트=team_member.id)으로 변환한다
       (`_resolve_target_member_id` — body-claimed org 신뢰 금지, SEC 규율①).
    2. 해소된 target 이 caller 자신이면(자기서비스, 지금까지처럼) 그대로 진행 — 무회귀.
    3. target 이 caller 와 다르면(타 멤버 대상) **admin/owner role 필수**(SEC 규율②, JWT
       app_metadata.role — 서버 검증된 클레임, body 아님) — 아니면 **명시 403**(예전처럼 caller
       로 침묵 강제 저장하지 않는다. 그 침묵 저장이 이번 버그의 실제 부작용이었다).
    """
    target_member_id = await _resolve_target_member_id(body.member_id, org_id, session)

    if target_member_id != caller_member_id:
        role = auth.claims.get("app_metadata", {}).get("role", "member")
        if role not in ("admin", "owner"):
            raise HTTPException(
                status_code=403,
                detail="Admin role required to configure another member's webhook",
            )

    config = await repo.upsert(
        member_id=target_member_id,
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
