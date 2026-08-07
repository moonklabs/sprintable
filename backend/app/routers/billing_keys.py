"""결제②-C1(story #2492) — org 빌링키 발급 엔드포인트. FE가 Toss 위젯으로 카드 인증을
마치면 돌려받는 일회성 authKey를 여기로 전달 → 실 billingKey 발급 + 암호화 저장.

org-wide 작업(특정 project와 무관 — billing_arch §2, org owner/admin만) — agents.py 6곳과
동일 이유로 ``get_verified_org_id``가 아니라 project-gate 없는
``get_verified_org_id_no_project_gate``를 쓴다(story #2486 교훈 — 탭이 우연히 non-member
project를 가리키면 org-wide 작업이 project-access 403으로 막히는 클래스, 이 엔드포인트도
동일 취약 구조라 처음부터 피한다)."""
from __future__ import annotations

import uuid

from fastapi import APIRouter, Depends, HTTPException
from pydantic import BaseModel
from sqlalchemy.ext.asyncio import AsyncSession

from app.dependencies.auth import AuthContext, get_current_user, get_verified_org_id_no_project_gate
from app.dependencies.database import get_db
from app.services.org_billing_key import issue_billing_key

router = APIRouter(prefix="/api/v2/org-billing-keys", tags=["billing", "Organization"])


class IssueBillingKeyRequest(BaseModel):
    auth_key: str


class BillingKeyResponse(BaseModel):
    org_id: uuid.UUID
    status: str
    card_issuer_code: str | None = None
    card_number_masked: str | None = None
    card_type: str | None = None

    model_config = {"from_attributes": True}


@router.post("", status_code=201, response_model=BillingKeyResponse)
async def create_billing_key(
    body: IssueBillingKeyRequest,
    session: AsyncSession = Depends(get_db),
    auth: AuthContext = Depends(get_current_user),
    org_id: uuid.UUID = Depends(get_verified_org_id_no_project_gate),
) -> BillingKeyResponse:
    """FE Toss 위젯 인증 완료 콜백 → authKey 전달 → 실 빌링키 발급.

    ⛔카드정보 자체가 아니라 Toss가 이미 인증을 마친 뒤 발급한 authKey만 받는다 — 원본
    카드번호는 이 엔드포인트도, 백엔드 어디도 거치지 않는다(Toss 위젯이 FE에서 직접 Toss로
    전송, PCI 스코프 최소화 — v2.1/toss-adapter-c-plan-v0-1 §1 create_billing_key 행 참고).
    """
    # agents.py와 동일 관례 — 함수 내부 import라야 테스트가 project_auth.is_org_owner_or_admin
    # 을 monkeypatch했을 때 이 호출부에도 반영된다(모듈 최상단 import는 바인딩이 고정돼 못 잡음).
    from app.services.project_auth import is_org_owner_or_admin

    if not await is_org_owner_or_admin(session, uuid.UUID(auth.user_id), org_id):
        raise HTTPException(status_code=403, detail="org admin/owner role required")

    try:
        key = await issue_billing_key(session, org_id=org_id, auth_key=body.auth_key)
    except RuntimeError as exc:
        raise HTTPException(status_code=502, detail=str(exc)) from exc

    return BillingKeyResponse.model_validate(key)
