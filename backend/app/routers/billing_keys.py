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
from sqlalchemy import select
from sqlalchemy.ext.asyncio import AsyncSession

from app.dependencies.auth import AuthContext, get_current_user, get_verified_org_id_no_project_gate
from app.dependencies.database import get_db
from app.models.org_billing_key import OrgBillingKey
from app.services.org_billing_key import ActiveSubscriptionBlocksRevoke, ensure_customer_key, issue_billing_key, revoke_billing_key

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


class CustomerKeyResponse(BaseModel):
    customer_key: str


@router.post("/customer-key", response_model=CustomerKeyResponse)
async def get_or_create_customer_key(
    session: AsyncSession = Depends(get_db),
    auth: AuthContext = Depends(get_current_user),
    org_id: uuid.UUID = Depends(get_verified_org_id_no_project_gate),
) -> CustomerKeyResponse:
    """#2512 — FE가 Toss 위젯(`payment({customerKey})`)을 열기 前에 먼저 호출한다.
    멱등: 이미 발급된 org면 그 값을 그대로 반환, 처음이면 status='awaiting_auth'
    placeholder 행을 만들어 customer_key만 발급한다. 위젯 인증이 끝나면 FE는 이 값을
    그대로 들고 authKey와 함께 checkout(`POST /api/v2/org-subscriptions/checkout`)을
    호출 — 서버는 issue_billing_key()가 이 org의 기존 customer_key를 재사용해 placeholder
    를 실 빌링키로 덮어쓴다(추가 배선 불요)."""
    from app.services.project_auth import is_org_owner_or_admin

    if not await is_org_owner_or_admin(session, uuid.UUID(auth.user_id), org_id):
        raise HTTPException(status_code=403, detail="org admin/owner role required")

    customer_key = await ensure_customer_key(session, org_id=org_id)
    return CustomerKeyResponse(customer_key=customer_key)


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


@router.get("", response_model=BillingKeyResponse | None)
async def get_billing_key(
    session: AsyncSession = Depends(get_db),
    auth: AuthContext = Depends(get_current_user),
    org_id: uuid.UUID = Depends(get_verified_org_id_no_project_gate),
) -> BillingKeyResponse | None:
    """story #2989(AC1 선행) — 저장된 결제수단을 화면에 보여줄 표면이 없던 갭(FE가 등록만
    하고 «지금 뭐가 등록돼 있는지»를 조회할 GET이 아예 없었다, 그라운딩 실측). status=
    'deleted'는 「지금은 없다」와 동형이라 None으로 응답(카드 흔적을 지어내지 않음)."""
    from app.services.project_auth import is_org_owner_or_admin

    if not await is_org_owner_or_admin(session, uuid.UUID(auth.user_id), org_id):
        raise HTTPException(status_code=403, detail="org admin/owner role required")

    key = (
        await session.execute(select(OrgBillingKey).where(OrgBillingKey.org_id == org_id))
    ).scalar_one_or_none()
    if key is None or key.status == "deleted":
        return None
    return BillingKeyResponse.model_validate(key)


@router.delete("", response_model=dict)
async def delete_billing_key(
    session: AsyncSession = Depends(get_db),
    auth: AuthContext = Depends(get_current_user),
    org_id: uuid.UUID = Depends(get_verified_org_id_no_project_gate),
) -> dict:
    """story #2989 AC1·AC2 — 셀프서브 결제수단 삭제. Toss 실 폐기 포함(revoke_billing_key
    참고). 활성 유료 구독이 있으면(P3 — 판별자는 «현재 유효 여부»뿐, 예약된 해지/다운
    그레이드 여부는 안 봄, 선생님 정책 확定 2026-08-24) 서버가 명시 거부한다(force 인자를
    이 라우터는 절대 안 노출 — 우회는 admin 전용 경로(admin_billing.py)뿐)."""
    from app.services.project_auth import is_org_owner_or_admin

    if not await is_org_owner_or_admin(session, uuid.UUID(auth.user_id), org_id):
        raise HTTPException(status_code=403, detail="org admin/owner role required")

    resolved_actor_id = uuid.UUID(auth.user_id)
    try:
        result = await revoke_billing_key(
            session, org_id=org_id, actor_id=resolved_actor_id, actor_type="human",
        )
    except ActiveSubscriptionBlocksRevoke as exc:
        raise HTTPException(
            status_code=409,
            detail={
                "code": "active_subscription_blocks_revoke",
                "message": "활성 유료 구독이 있어 결제수단을 지울 수 없습니다. 구독 해지 후 다시 시도해주세요.",
                "tier": exc.tier,
            },
        ) from exc
    return result
