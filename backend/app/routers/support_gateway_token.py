"""story #3259(지원v1·1경계) — Support Gateway 위임 토큰 발급. backend 쪽에서 이 스토리가
건드리는 **유일한** 지점 — 나머지는 전부 support-gateway/ 독립 디렉터리.

이 엔드포인트가 주는 건 {org_id, user_id, exp, iat} 4개 클레임뿐이다. fleet 자격(API key·MCP
시크릿·billing 상태 등) 어느 것도 이 토큰에 실리지 않는다 — Support Gateway가 그런 자격을
받아 들고 있게 되는 순간 "fleet 자격 0" 불변식이 깨지므로, 클레임 셋을 여기서 의도적으로
좁게 고정한다(확장하고 싶어지면 그 자체가 §2 경계 위반 신호).
"""
from __future__ import annotations

import logging
import uuid
from dataclasses import dataclass
from datetime import datetime, timedelta, timezone

from fastapi import APIRouter, Depends, Header, HTTPException
from jose import JWTError as JoseJWTError
from jose import jwt as jose_jwt
from pydantic import BaseModel
from sqlalchemy import select
from sqlalchemy.ext.asyncio import AsyncSession

from app.core.config import settings
from app.dependencies.auth import AuthContext, get_current_user
from app.dependencies.database import get_db
from app.models.organization import Organization
from app.models.project import Project

logger = logging.getLogger(__name__)

router = APIRouter(prefix="/api/v2/support", tags=["support-gateway"])

# story #3263(지원v1·5에스컬레이션) — Gateway가 사람 전달 이벤트를 이 aud로 서명해 보낸다
# (support-gateway/app/escalation_delivery.py의 ESCALATION_DELIVERY_AUD와 문자열 동일 —
# 두 프로세스가 서로를 import 못 하므로 상수를 각자 갖되 값은 계약으로 고정한다. 페드루 PO
# 조건① — 위임 토큰(이 파일의 session-token 발급, aud 없음)과 구조적으로 분리).
ESCALATION_DELIVERY_AUD = "backend:escalation-events"


class EscalationDeliveryError(Exception):
    pass


@dataclass(frozen=True)
class EscalationDeliveryClaims:
    escalation_id: uuid.UUID
    org_id: uuid.UUID
    user_id: uuid.UUID
    reason: str
    detail: str
    conversation_summary: str


def verify_escalation_delivery_token(token: str) -> EscalationDeliveryClaims:
    """Gateway→backend 배달 토큰 검증 — session-token 발급과 **같은 대칭키**(역방향)를
    audience= 필수 지정으로 검증한다. 위임 토큰(aud 없음)이 여기로 잘못 흘러들어오면
    jose가 audience 불일치로 거부한다(대칭짝: support-gateway/app/token_verify.py가 이
    반대 방향을 막는 것과 동형)."""
    if not settings.support_gateway_token_secret:
        raise EscalationDeliveryError("SUPPORT_GATEWAY_TOKEN_SECRET not configured")
    try:
        claims = jose_jwt.decode(
            token, settings.support_gateway_token_secret, algorithms=["HS256"], audience=ESCALATION_DELIVERY_AUD,
        )
    except JoseJWTError as exc:
        raise EscalationDeliveryError(str(exc)) from exc
    try:
        return EscalationDeliveryClaims(
            escalation_id=uuid.UUID(claims["escalation_id"]),
            org_id=uuid.UUID(claims["org_id"]),
            user_id=uuid.UUID(claims["user_id"]),
            reason=str(claims["reason"]),
            detail=str(claims["detail"]),
            conversation_summary=str(claims["conversation_summary"]),
        )
    except (KeyError, ValueError) as exc:
        raise EscalationDeliveryError(f"malformed claims: {exc}") from exc


async def require_escalation_delivery_claims(authorization: str = Header(default="")) -> EscalationDeliveryClaims:
    if not authorization.startswith("Bearer "):
        raise HTTPException(status_code=401, detail="missing bearer token")
    token = authorization[len("Bearer "):]
    try:
        return verify_escalation_delivery_token(token)
    except EscalationDeliveryError as exc:
        raise HTTPException(status_code=401, detail=f"invalid escalation delivery token: {exc}") from exc


class SupportSessionTokenResponse(BaseModel):
    token: str
    expires_in: int


@router.post("/session-token", response_model=SupportSessionTokenResponse)
async def issue_support_session_token(
    auth: AuthContext = Depends(get_current_user),
) -> SupportSessionTokenResponse:
    if not settings.support_gateway_token_secret:
        # fail-closed — 위임 토큰 시크릿 미설정 상태로 발급하면 Support Gateway 쪽 검증이
        # 항상 실패할 뿐 아니라, 설정 누락을 조용히 감추게 된다.
        raise HTTPException(status_code=503, detail="support gateway not configured")
    if not auth.org_id:
        raise HTTPException(status_code=400, detail="org context required")

    now = datetime.now(timezone.utc)
    ttl = settings.support_gateway_token_ttl_seconds
    claims = {
        "org_id": auth.org_id,
        "user_id": auth.user_id,
        "exp": now + timedelta(seconds=ttl),
        "iat": now,
    }
    token = jose_jwt.encode(claims, settings.support_gateway_token_secret, algorithm="HS256")
    return SupportSessionTokenResponse(token=token, expires_in=ttl)


class EscalationEventResponse(BaseModel):
    gate_id: uuid.UUID


@router.post("/escalation-events", response_model=EscalationEventResponse, status_code=201)
async def receive_escalation_event(
    claims: EscalationDeliveryClaims = Depends(require_escalation_delivery_claims),
    session: AsyncSession = Depends(get_db),
) -> EscalationEventResponse:
    """story #3263(지원v1·5에스컬레이션) AC1/AC2 — Gateway가 사람 전달 이벤트를 배달하는
    유일한 착지점. 티켓 초안(=이 게이트 자체)을 moonklabs org 안에 만들고 지정 결재자
    1인에게만 액션 카드를 보낸다 — **자동 등재 금지**: 이 카드가 곧 그 게이트고, 사람이
    승인/거부해야 다음 단계로 넘어간다(자동으로 뭔가를 추가로 등재하지 않는다).

    requester=customer org_member는 기각됐다(org 경계 위반 — Gate/ConversationParticipant는
    단일 org 스코프, 페드루 PO 확定 2026-08-31) — 대신 moonklabs org 안의 "Sprintable 지원"
    에이전트 멤버(config: support_escalation_requester_member_id)를 쓴다. 고객 신원은
    org명만 neutral_facts에 서술(개인정보 0 — PII 카드 노출 금지, PO 확定), 상세 추적은
    escalation_id로."""
    requester_id_raw = settings.support_escalation_requester_member_id
    approver_id_raw = settings.support_escalation_approver_member_id
    if not requester_id_raw or not approver_id_raw:
        # fail-closed(session-token 발급의 동일 관례) — 설정 누락을 조용히 감추지 않는다.
        raise HTTPException(status_code=503, detail="support escalation delivery not configured (requester/approver)")
    try:
        requester_id = uuid.UUID(requester_id_raw)
        approver_id = uuid.UUID(approver_id_raw)
    except ValueError as exc:
        raise HTTPException(status_code=503, detail=f"malformed support escalation member id config: {exc}") from exc

    org = (await session.execute(
        select(Organization).where(Organization.slug == settings.support_escalation_target_org_slug)
    )).scalar_one_or_none()
    if org is None:
        raise HTTPException(status_code=503, detail="support escalation target org not found")
    project = (await session.execute(
        select(Project).where(
            Project.org_id == org.id, Project.slug == settings.support_escalation_target_project_slug,
        )
    )).scalar_one_or_none()
    if project is None:
        raise HTTPException(status_code=503, detail="support escalation target project not found")

    # 고객 org 이름만(개인정보 0) — 다른 org를 "읽는" 것뿐(대상 org에 쓰기/멤버 편입 없음),
    # 내부 운영 티켓에 어느 고객인지 식별하는 정상적 지원 업무 범위.
    customer_org_name = (
        await session.execute(select(Organization.name).where(Organization.id == claims.org_id))
    ).scalar_one_or_none() or str(claims.org_id)

    from app.services.approval_delivery import dispatch_approval_request_cards
    from app.services.gate_service import create_gate
    from app.services.workflow_line_config import _default_role_id

    gate_id = uuid.uuid4()
    neutral_facts = {
        "support_escalation_id": str(claims.escalation_id),
        "customer_org_name": customer_org_name,
        "reason": claims.reason,
        "detail": claims.detail,
        "conversation_summary": claims.conversation_summary,
    }
    gate = await create_gate(
        session=session,
        org_id=org.id,
        work_item_id=gate_id,
        work_item_type="support_escalation",
        gate_type="support_escalation_review",
        member_id=requester_id,
        role_id=await _default_role_id(session, org.id) or gate_id,
        neutral_facts=neutral_facts,
        project_id=project.id,
        gate_id=gate_id,
        designated_approver_id=approver_id,
    )
    await session.flush()
    try:
        await dispatch_approval_request_cards(
            session, org_id=org.id, work_item_type="support_escalation", work_item_id=gate.id,
            project_id=project.id, title=f"고객 문의 에스컬레이션 — {customer_org_name}",
            gate_id=gate.id, requester_id=requester_id, approver_ids=[approver_id],
            designated_approver_id=approver_id,
        )
    except Exception:  # noqa: BLE001 — 카드 배달 실패는 게이트 생성 자체를 되돌리지 않는다
        # (다른 create_gate 호출부의 best-effort 관례와 동형 — Gate inbox 폴백 항상 존재).
        logger.warning("support escalation 카드 배달 실패 gate_id=%s (게이트는 생성됨)", gate.id, exc_info=True)

    await session.commit()
    await session.refresh(gate)
    return EscalationEventResponse(gate_id=gate.id)
