"""EE Billing API — Polar 연동 라우터.

이 라우터는 EE_ENABLED 환경에서만 main.py에 등록됨.
OSS 빌드(is_ee_enabled=False)에서는 import되지 않아 403 방어 불필요.
"""
import hashlib
import hmac
import logging
import uuid
from datetime import datetime, timezone

import httpx
from fastapi import APIRouter, BackgroundTasks, Depends, HTTPException, Request
from pydantic import BaseModel
from sqlalchemy import select, text
from sqlalchemy.ext.asyncio import AsyncSession

from app.core.config import settings
from app.dependencies.auth import AuthContext, get_current_user, get_verified_org_id
from app.dependencies.database import get_db
from app.models.org_subscription import OrgSubscription
from app.models.pricing_version import PricingVersion
from app.models.project import OrgMember

logger = logging.getLogger(__name__)

router = APIRouter(tags=["billing-ee"])

# 표시가(USD 월간) — E-ADMIN B1(story 553fc58d)로 $49/$149 정정(구 $29/$79는 live Polar
# 상품과 불일치했던 값). 실 청구는 pricing_versions(DB, doc e-admin-b1-polar-live-price-ids
# SSOT)가 SSOT — 여기 숫자는 표시용 상수로 유지(B1 범위=grandfather 배선, catalog 전체
# DB화는 별도 후속).
_PLAN_CATALOG = [
    {"id": "free", "name": "Free", "price": 0, "billing_cycle": None,
     "features": ["1 project", "5 members", "Basic AI features"]},
    {"id": "team", "name": "Team", "price": 49, "billing_cycle": "monthly",
     "features": ["Unlimited projects", "25 members", "Full AI features", "Priority support"]},
    {"id": "pro", "name": "Pro", "price": 149, "billing_cycle": "monthly",
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


# 플랜별 Polar product_price_id 매핑 — Moonklabs live org(선생님 GO, doc
# e-admin-b1-polar-live-price-ids SSOT). 체크아웃은 여전히 USD만 사용(currency 선택 API
# 미구현, 이번 스코프 아님) — krw는 pricing_versions DB에 이미 있고 여기 미리 반영해둔다
# (통화 선택 API 나오면 바로 사용 가능, 지금은 checkout이 "usd"만 읽음).
_POLAR_PRICE_IDS: dict[str, dict[str, str]] = {
    "team_monthly": {"usd": "7d501b9f-f8b0-45ac-9b3f-817a3370ce9f", "krw": "3d1bae90-be94-496b-832e-f4178c658eea"},
    "team_yearly": {"usd": "9a251b0e-e16c-45a6-a977-3351bada5b9e", "krw": "684deacc-7c31-4fe7-96ae-5c7408feded8"},
    "pro_monthly": {"usd": "deefdbe9-ed44-4f60-a485-201215234e0b", "krw": "a48fca24-3374-4a78-b1dc-1168457acec4"},
    "pro_yearly": {"usd": "415b0b77-f6d3-4cbb-9fe8-250f3281378f", "krw": "1fc9d6fa-b1bd-492b-b081-ecfe78775d12"},
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
    price_id = (_POLAR_PRICE_IDS.get(price_key) or {}).get("usd")
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


def _verify_polar_signature(raw_body: bytes, signature_header: str | None) -> bool:
    """Polar HMAC-SHA256 signature 검증. secret 미설정 시 검증 스킵 (dev sandbox)."""
    secret = settings.polar_webhook_secret
    if not secret:
        logger.warning("POLAR_WEBHOOK_SECRET not set — skipping signature verification (dev only)")
        return True
    if not signature_header:
        return False
    expected = hmac.new(secret.encode(), raw_body, hashlib.sha256).hexdigest()
    return hmac.compare_digest(expected, signature_header.removeprefix("sha256="))


@router.post("/webhook")
async def polar_webhook(
    request: Request,
    background_tasks: BackgroundTasks,
    session: AsyncSession = Depends(get_db),
    _ee: None = Depends(_require_ee),
) -> dict:
    """Polar 웹훅 수신 — signature 검증 + 이벤트별 Subscription 갱신 + 멱등 처리."""
    raw_body = await request.body()

    # AC2: Signature 검증
    signature = request.headers.get("X-Polar-Webhook-Signature") or request.headers.get("webhook-signature")
    if not _verify_polar_signature(raw_body, signature):
        raise HTTPException(status_code=401, detail="Invalid webhook signature")

    try:
        import json as _json
        payload = _json.loads(raw_body)
    except Exception:
        raise HTTPException(status_code=400, detail="Invalid JSON payload")

    event_id = payload.get("id") or payload.get("event_id")
    event_type = payload.get("type")
    logger.info("Polar webhook received: %s (id=%s)", event_type, event_id)

    # AC5: 멱등 처리 — 이미 처리된 event_id 스킵
    if event_id:
        dup = await session.execute(
            text("SELECT 1 FROM polar_webhook_events WHERE event_id = :eid"),
            {"eid": str(event_id)},
        )
        if dup.first() is not None:
            logger.info("Duplicate webhook event %s — skipped", event_id)
            return {"ok": True, "duplicate": True}
        await session.execute(
            text("INSERT INTO polar_webhook_events (event_id, event_type) VALUES (:eid, :etype)"),
            {"eid": str(event_id), "etype": event_type or "unknown"},
        )
        await session.commit()

    data = payload.get("data", {})

    # AC3: checkout.completed → Subscription 활성화
    if event_type == "checkout.completed":
        metadata = data.get("metadata", {})
        org_id_str = metadata.get("org_id")
        product = data.get("product", {})
        tier = "pro" if "pro" in (product.get("name", "")).lower() else "team"
        billing_cycle = "yearly" if "yearly" in str(data.get("product_price", {}).get("type", "")).lower() else "monthly"
        if org_id_str:
            background_tasks.add_task(
                _update_subscription, session, uuid.UUID(org_id_str), tier, billing_cycle,
                data.get("customer_id"), data.get("subscription_id"), "active",
            )

    # AC4: subscription.updated → status/tier 갱신
    elif event_type == "subscription.updated":
        metadata = data.get("metadata", {})
        org_id_str = metadata.get("org_id")
        if not org_id_str:
            # polar_subscription_id로 역추적
            polar_sub_id = data.get("id")
            sub_row = await session.execute(
                select(OrgSubscription.org_id).where(OrgSubscription.polar_subscription_id == polar_sub_id)
            )
            org_row = sub_row.first()
            org_id_str = str(org_row[0]) if org_row else None
        if org_id_str:
            new_status = data.get("status", "active")
            product = data.get("product", {})
            tier = "pro" if "pro" in (product.get("name", "")).lower() else "team"
            billing_cycle = "yearly" if data.get("recurring_interval") == "year" else "monthly"
            background_tasks.add_task(
                _update_subscription, session, uuid.UUID(org_id_str), tier, billing_cycle,
                data.get("customer_id"), data.get("id"), new_status,
            )

    # AC4: subscription.canceled → status=cancelled
    elif event_type in ("subscription.canceled", "subscription.cancelled"):
        polar_sub_id = data.get("id")
        sub_row = await session.execute(
            select(OrgSubscription).where(OrgSubscription.polar_subscription_id == polar_sub_id)
        )
        sub = sub_row.scalar_one_or_none()
        if sub:
            sub.status = "cancelled"
            await session.commit()
            logger.info("Subscription cancelled for polar_sub_id=%s", polar_sub_id)

    return {"ok": True}


async def _current_pricing_version_id(
    session: AsyncSession, tier: str, billing_cycle: str, currency: str = "usd"
) -> uuid.UUID | None:
    """grandfather 배선(E-ADMIN B1) — 가입/플랜변경 시점의 현재 유효 pricing_version을
    조회(effective_from <= now 중 최신 1건). checkout이 USD만 다뤄 currency 기본값 usd."""
    row = await session.execute(
        select(PricingVersion.id)
        .where(
            PricingVersion.tier == tier,
            PricingVersion.billing_cycle == billing_cycle,
            PricingVersion.currency == currency,
            PricingVersion.effective_from <= datetime.now(timezone.utc),
        )
        .order_by(PricingVersion.effective_from.desc())
        .limit(1)
    )
    return row.scalar_one_or_none()


async def _update_subscription(
    session: AsyncSession,
    org_id: uuid.UUID,
    tier: str,
    billing_cycle: str,
    polar_customer_id: str | None,
    polar_subscription_id: str | None,
    status: str = "active",
) -> None:
    """Subscription 레코드 upsert. pricing_version_id는 매번(신규 가입뿐 아니라 플랜변경
    시에도) 현재 유효 버전으로 갱신 — 플랜변경은 새 플랜의 현재가를 grandfather 기준점으로
    삼는 게 맞다(기존 플랜의 옛 버전을 유지할 이유가 없음).

    이 함수는 webhook 핸들러가 `background_tasks.add_task`로 fire-and-forget 호출한다 —
    Polar엔 이미 {ok:true} ACK가 나간 뒤라 여기서 실패해도 호출자에게 전파할 방법이 없고
    Polar 재시도도 없다(까심 QA 발견: 0148 버그가 이 경로 때문에 아무도 몰랐음). 그래서
    반드시 여기서 직접 로그를 남긴다 — 조용한 실패 봉쇄가 핵심(풀 재시도 시스템은 후속)."""
    from sqlalchemy.dialects.postgresql import insert as pg_insert
    try:
        now = datetime.now(timezone.utc)
        pricing_version_id = await _current_pricing_version_id(session, tier, billing_cycle)
        await session.execute(
            pg_insert(OrgSubscription)
            .values(
                org_id=org_id,
                polar_customer_id=polar_customer_id or "",
                polar_subscription_id=polar_subscription_id,
                tier=tier,
                billing_cycle=billing_cycle,
                status="active",
                pricing_version_id=pricing_version_id,
                updated_at=now,
            )
            .on_conflict_do_update(
                index_elements=["org_id"],
                set_={"tier": tier, "billing_cycle": billing_cycle, "status": status,
                      "polar_customer_id": polar_customer_id or "", "pricing_version_id": pricing_version_id,
                      "updated_at": now},
            )
        )
        await session.commit()
        logger.info("Subscription updated for org %s → %s/%s", org_id, tier, billing_cycle)
    except Exception:
        logger.error(
            "Subscription upsert FAILED for org %s (tier=%s, billing_cycle=%s, "
            "polar_subscription_id=%s) — background task, Polar already ACKed, no retry",
            org_id, tier, billing_cycle, polar_subscription_id, exc_info=True,
        )
        raise
