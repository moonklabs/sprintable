"""story #3279(지원v1·후속) — 운영자 회신 착지점. backend가 승인자의 스레드 답장을
escalation_id에 붙여 여기로 배달한다(app/token_verify.py::require_operator_reply_claims —
escalation_delivery.py의 반대 방향, 같은 SUPPORT_GATEWAY_TOKEN_SECRET을 다른 aud로).

fleet 자격 0 불변식 그대로 — 이 엔드포인트는 backend의 team_member id도, 어느 승인자가
답했는지도 모른다(claims엔 escalation_id+content뿐). 고객 표면에 사람 이름을 안 실으려는
게 아니라(그것도 맞지만), 애초에 이 프로세스가 그 신원을 받아 들고 있으면 안 된다는
Blueprint §2 경계 그대로다."""
from __future__ import annotations

from fastapi import APIRouter, Depends, HTTPException
from sqlalchemy.ext.asyncio import AsyncSession

from app.db import get_db
from app.models import SupportEscalation, SupportExecutionLog, SupportMessage
from app.schemas import MessageResponse
from app.token_verify import OperatorReplyClaims, require_operator_reply_claims

router = APIRouter(prefix="/api/v1/internal", tags=["operator"])


@router.post("/operator-replies", response_model=MessageResponse, status_code=201)
async def receive_operator_reply(
    claims: OperatorReplyClaims = Depends(require_operator_reply_claims),
    db: AsyncSession = Depends(get_db),
) -> MessageResponse:
    # escalation_id로만 conversation을 찾는다(SupportEscalation.conversation_id) — org_id는
    # 클레임에 없다(escalation 행 자체가 이미 그 org에 스코프돼 있어 재확인이 불필요, 그리고
    # gateway는 애초에 org_id를 별도로 신뢰할 근거가 이 토큰엔 없다 — escalation_id 존재
    # 자체가 유일한 근거).
    escalation = await db.get(SupportEscalation, claims.escalation_id)
    if escalation is None:
        raise HTTPException(status_code=404, detail="escalation not found")

    # story #3276 — 종료된 상담이어도 회신은 그대로 적재한다(읽기 전용은 "고객의 새 발화"만
    # 막는 개념이지, 운영자가 이미 진행 중이던 왕복을 마무리하는 회신까지 막을 이유가 없다
    # — 고객이 다음에 그 이력을 열면 그대로 보인다).
    message = SupportMessage(
        conversation_id=escalation.conversation_id,
        org_id=escalation.org_id,
        role="operator",
        content=claims.content,
    )
    db.add(message)
    db.add(
        SupportExecutionLog(
            conversation_id=escalation.conversation_id,
            org_id=escalation.org_id,
            task_type="operator_reply",
            model="n/a",
            summary=f"operator reply delivered (escalation_id={escalation.id})",
        )
    )
    await db.commit()
    await db.refresh(message)
    return MessageResponse(
        id=message.id,
        conversation_id=message.conversation_id,
        role=message.role,
        content=message.content,
        created_at=message.created_at,
    )
