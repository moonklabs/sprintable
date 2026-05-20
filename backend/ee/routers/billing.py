"""EE Billing API — Polar 연동 라우터.

이 라우터는 EE_ENABLED 환경에서만 main.py에 등록됨.
OSS 빌드(is_ee_enabled=False)에서는 import되지 않아 403 방어 불필요.
"""
import logging
import uuid
from datetime import datetime, timezone

import httpx
from fastapi import APIRouter, BackgroundTasks, Depends, HTTPException, Request
from pydantic import BaseModel
from sqlalchemy import select
from sqlalchemy.ext.asyncio import AsyncSession

from app.core.config import settings
from app.dependencies.auth import AuthContext, get_current_user, get_verified_org_id
from app.dependencies.database import get_db
from app.models.org_subscription import OrgSubscription
from app.models.project import OrgMember

logger = logging.getLogger(__name__)

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


# Polar API 기본 URL (sandbox/prod 자동 전환)
def _polar_api_url() -> str:
    return "https://sandbox.api.polar.sh" if settings.polar_sandbox else "https://api.polar.sh"


# 플랜별 Polar product_price_id 매핑 (sandbox IDs — prod 배포 시 환경변수로 교체)
_POLAR_PRICE_IDS: dict[str, str] = {
    "team_monthly": "price_team_monthly_sandbox",
    "team_yearly": "price_team_yearly_sandbox",
    "pro_monthly": "price_pro_monthly_sandbox",
    "pro_yearly": "price_pro_yearly_sandbox",
}

# 연간 플랜 가격 (월 환산)
_PLAN_PRICES = {
    "team": {"monthly": 29, "yearly": 23},
    "pro": {"monthly": 79, "yearly": 63},
}


class CheckoutRequest(BaseModel):
    plan_id: str       # team | pro
    billing_cycle: str  # monthly | yearly
    success_url: str | None = None
    cancel_url: str | None = None


@router.post("/checkout")
async def create_checkout_session(
    body: CheckoutRequest,
    org_id: uuid.UUID = Depends(get_verified_org_id),
    auth: AuthContext = Depends(get_current_user),
    session: AsyncSession = Depends(get_db),
    _ee: None = Depends(_require_ee),
) -> dict:
    """Polar checkout 세션 생성 — owner/admin 전용."""
    # owner/admin 권한 확인
    role_result = await session.execute(
        select(OrgMember.role).where(
            OrgMember.org_id == org_id,
            OrgMember.user_id == uuid.UUID(auth.user_id),
            OrgMember.deleted_at.is_(None),
        )
    )
    caller_role = role_result.scalar_one_or_none()
    if caller_role not in ("owner", "admin"):
        raise HTTPException(status_code=403, detail="owner or admin role required to start checkout")

    if body.plan_id not in ("team", "pro"):
        raise HTTPException(status_code=400, detail="Invalid plan_id. Use 'team' or 'pro'")
    if body.billing_cycle not in ("monthly", "yearly"):
        raise HTTPException(status_code=400, detail="Invalid billing_cycle. Use 'monthly' or 'yearly'")

    price_key = f"{body.plan_id}_{body.billing_cycle}"
    price_id = _POLAR_PRICE_IDS.get(price_key)
    if not price_id:
        raise HTTPException(status_code=400, detail=f"No price configured for {price_key}")

    app_url = settings.app_url
    success_url = body.success_url or f"{app_url}/settings?tab=billing&checkout=success"
    cancel_url = body.cancel_url or f"{app_url}/settings?tab=billing&checkout=cancelled"

    if not settings.polar_access_token:
        # sandbox 환경에서 토큰 없을 때 모의 응답
        logger.warning("POLAR_ACCESS_TOKEN not set — returning mock checkout URL")
        return {
            "checkout_url": f"{_polar_api_url()}/checkout/mock?price={price_id}&success_url={success_url}",
            "plan_id": body.plan_id,
            "billing_cycle": body.billing_cycle,
            "sandbox": settings.polar_sandbox,
        }

    # Polar Checkout API 호출
    try:
        async with httpx.AsyncClient(timeout=15) as client:
            resp = await client.post(
                f"{_polar_api_url()}/v1/checkouts/",
                headers={"Authorization": f"Bearer {settings.polar_access_token}", "Content-Type": "application/json"},
                json={
                    "product_price_id": price_id,
                    "success_url": success_url,
                    "cancel_url": cancel_url,
                    "metadata": {"org_id": str(org_id)},
                },
            )
            if resp.status_code not in (200, 201):
                logger.error("Polar checkout error: %s %s", resp.status_code, resp.text)
                raise HTTPException(status_code=502, detail="Polar checkout API error")
            data = resp.json()
    except httpx.RequestError as exc:
        logger.exception("Polar API request failed: %s", exc)
        raise HTTPException(status_code=502, detail="Cannot reach Polar API")

    return {
        "checkout_url": data.get("url"),
        "checkout_id": data.get("id"),
        "plan_id": body.plan_id,
        "billing_cycle": body.billing_cycle,
        "sandbox": settings.polar_sandbox,
    }


@router.post("/webhook")
async def polar_webhook(
    request: Request,
    background_tasks: BackgroundTasks,
    session: AsyncSession = Depends(get_db),
    _ee: None = Depends(_require_ee),
) -> dict:
    """Polar 웹훅 수신 — checkout.completed 시 Subscription 상태 갱신."""
    try:
        payload = await request.json()
    except Exception:
        raise HTTPException(status_code=400, detail="Invalid JSON payload")

    event_type = payload.get("type")
    logger.info("Polar webhook received: %s", event_type)

    if event_type == "checkout.completed":
        data = payload.get("data", {})
        metadata = data.get("metadata", {})
        org_id_str = metadata.get("org_id")
        product = data.get("product", {})
        tier = "pro" if "pro" in (product.get("name", "")).lower() else "team"
        billing_cycle = "yearly" if "yearly" in str(data.get("product_price", {}).get("type", "")).lower() else "monthly"

        if org_id_str:
            background_tasks.add_task(
                _update_subscription, session, uuid.UUID(org_id_str), tier, billing_cycle,
                data.get("customer_id"), data.get("subscription_id"),
            )

    return {"ok": True}


async def _update_subscription(
    session: AsyncSession,
    org_id: uuid.UUID,
    tier: str,
    billing_cycle: str,
    polar_customer_id: str | None,
    polar_subscription_id: str | None,
) -> None:
    """Subscription 레코드 upsert."""
    from sqlalchemy.dialects.postgresql import insert as pg_insert
    now = datetime.now(timezone.utc)
    await session.execute(
        pg_insert(OrgSubscription)
        .values(
            org_id=org_id,
            polar_customer_id=polar_customer_id or "",
            polar_subscription_id=polar_subscription_id,
            tier=tier,
            billing_cycle=billing_cycle,
            status="active",
            updated_at=now,
        )
        .on_conflict_do_update(
            index_elements=["org_id"],
            set_={"tier": tier, "billing_cycle": billing_cycle, "status": "active",
                  "polar_customer_id": polar_customer_id or "", "updated_at": now},
        )
    )
    await session.commit()
    logger.info("Subscription updated for org %s → %s/%s", org_id, tier, billing_cycle)
