"""EE Billing API — Polar 연동 라우터.

이 라우터는 EE_ENABLED 환경에서만 main.py에 등록됨.
OSS 빌드(is_ee_enabled=False)에서는 import되지 않아 403 방어 불필요.
"""
import uuid

from fastapi import APIRouter, Depends, HTTPException
from sqlalchemy import select
from sqlalchemy.ext.asyncio import AsyncSession

from app.core.config import settings
from app.dependencies.auth import AuthContext, get_current_user, get_verified_org_id
from app.dependencies.database import get_db
from app.models.org_subscription import OrgSubscription
from app.models.project import OrgMember

router = APIRouter(tags=["billing-ee"])

_PLAN_CATALOG = [
    {"id": "free", "name": "Free", "price": 0, "billing_cycle": None,
     "features": ["1 project", "5 members", "Basic AI features"]},
    {"id": "team", "name": "Team", "price": 29, "billing_cycle": "monthly",
     "features": ["Unlimited projects", "25 members", "Full AI features", "Priority support"]},
    {"id": "pro", "name": "Pro", "price": 79, "billing_cycle": "monthly",
     "features": ["Unlimited projects", "Unlimited members", "Advanced AI", "Custom integrations", "SLA"]},
]


def _require_ee() -> None:
    """EE 비활성화 환경에서 호출 시 403 반환 (방어적 guard)."""
    if not settings.is_ee_enabled:
        raise HTTPException(status_code=403, detail="Enterprise Edition not enabled")


@router.get("/status")
async def get_billing_status(
    org_id: uuid.UUID = Depends(get_verified_org_id),
    auth: AuthContext = Depends(get_current_user),
    session: AsyncSession = Depends(get_db),
    _ee: None = Depends(_require_ee),
) -> dict:
    """현재 Org의 Subscription 상태 조회 — tier, billing_cycle, status."""
    sub_result = await session.execute(
        select(OrgSubscription).where(OrgSubscription.org_id == org_id)
    )
    sub = sub_result.scalar_one_or_none()

    # org_members에서 caller의 role 조회 (owner/admin vs member 구분)
    role_result = await session.execute(
        select(OrgMember.role).where(
            OrgMember.org_id == org_id,
            OrgMember.user_id == uuid.UUID(auth.user_id),
            OrgMember.deleted_at.is_(None),
        )
    )
    caller_role = role_result.scalar_one_or_none() or "member"
    can_manage = caller_role in ("owner", "admin")

    if sub is None:
        return {
            "org_id": str(org_id),
            "tier": "free",
            "billing_cycle": None,
            "status": "active",
            "current_period_end": None,
            "can_manage": can_manage,
        }

    return {
        "org_id": str(org_id),
        "tier": sub.tier,
        "billing_cycle": sub.billing_cycle,
        "status": sub.status,
        "current_period_end": sub.current_period_end.isoformat() if sub.current_period_end else None,
        "can_manage": can_manage,
    }


@router.get("/plans")
async def list_billing_plans(
    _auth: AuthContext = Depends(get_current_user),
    _ee: None = Depends(_require_ee),
) -> list[dict]:
    """Free/Team/Pro 플랜 카탈로그."""
    return _PLAN_CATALOG


@router.post("/checkout")
async def create_checkout_session(
    org_id: uuid.UUID = Depends(get_verified_org_id),
    _auth: AuthContext = Depends(get_current_user),
    _ee: None = Depends(_require_ee),
) -> dict:
    """Polar 결제 세션 생성 (Polar SDK 연동 예정)."""
    return {"checkout_url": None, "message": "Polar SDK integration pending"}
