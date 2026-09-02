"""story #183fe7a5(지원v1·후속) — 게이트 해소(approve/reject) 동기화 착지점. backend가
gate_service.py::transition_gate()에서 SUPPORT_GATEWAY_TOKEN_SECRET을 aud="support-gateway:
escalation-resolution"으로 서명해 배달한다(app/token_verify.py::
require_escalation_resolution_claims — escalation_delivery.py의 반대 방향, operator_replies.py
와 같은 방향·다른 aud).

⚠️설계 결정(backend/app/services/escalation_resolution_delivery.py 모듈 docstring 그대로) —
approve·reject 둘 다 여기선 status='resolved' 하나로 수렴한다(gateway 쪽 상태값이 애초에
'open'|'resolved' 이분법뿐 — SupportEscalation.status 정의, app/models.py). resolution
클레임 값(실제 'approved'|'rejected')은 받아서 로그에만 남긴다(현재 스키마가 세분화를 안
씀 — 정직하게 안 쓰는 것뿐, 못 받는 게 아니다).

fleet 자격 0 불변식 그대로 — org_id를 클레임에서 안 받는다(escalation_id 존재 자체가
유일한 근거, operator_replies.py와 동일 원칙)."""
from __future__ import annotations

import logging

from fastapi import APIRouter, Depends, HTTPException
from sqlalchemy.ext.asyncio import AsyncSession

from app.db import get_db
from app.models import SupportEscalation
from app.token_verify import EscalationResolutionClaims, require_escalation_resolution_claims

logger = logging.getLogger(__name__)

router = APIRouter(prefix="/api/v1/internal", tags=["operator"])


@router.post("/escalation-resolution", status_code=204)
async def receive_escalation_resolution(
    claims: EscalationResolutionClaims = Depends(require_escalation_resolution_claims),
    db: AsyncSession = Depends(get_db),
) -> None:
    escalation = await db.get(SupportEscalation, claims.escalation_id)
    if escalation is None:
        raise HTTPException(status_code=404, detail="escalation not found")

    escalation.status = "resolved"
    await db.commit()
    logger.info(
        "escalation resolution synced escalation_id=%s resolution=%s status=resolved",
        claims.escalation_id, claims.resolution,
    )
