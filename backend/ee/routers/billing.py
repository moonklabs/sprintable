"""EE Billing API — Polar 연동 라우터.

이 라우터는 EE_ENABLED 환경에서만 main.py에 등록됨.
OSS 빌드(is_ee_enabled=False)에서는 import되지 않아 403 방어 불필요.

#2478(B): PG 호출부(체크아웃 API·웹훅 서명검증)는 app/services/payment/PolarAdapter로
무회귀 이관됐다. 이 파일은 라우팅·권한·플랜 카탈로그·구독 upsert(도메인 로직)만 갖는다 —
PG를 직접 모르게(design doc §1 원칙)."""
import logging
import uuid
from datetime import datetime, timezone

from fastapi import APIRouter, BackgroundTasks, Depends, HTTPException, Request
from pydantic import BaseModel
from sqlalchemy import select, text
from sqlalchemy.ext.asyncio import AsyncSession

from app.core.config import settings
from app.dependencies.auth import AuthContext, get_current_user, get_verified_org_id
from app.dependencies.database import get_db
from app.models.billing_order import BillingOrder
from app.models.org_subscription import OrgSubscription
from app.models.pricing_version import PricingVersion
from app.models.project import OrgMember
from app.services.payment.factory import get_payment_adapter
from app.services.platform_settings import get_platform_settings, require_billing_checkout_enabled

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
        au_current, au_limit = await _get_au_usage(session, org_id, "free")
        return {
            "org_id": str(org_id),
            "tier": "free",
            "billing_cycle": None,
            "status": "active",
            "current_period_end": None,
            "can_manage": can_manage,
            "au_current": au_current,
            "au_limit": au_limit,
            "au_paused": False,
        }

    # story #2892(P0, 실사고 2026-08-21) — org_subscription_checkout.py의 상태기계는
    # "청구 성공 時에만 status='active' 전이"를 명시 계약으로 문서화해 뒀는데(그 파일
    # 모듈 docstring §4), 이 엔드포인트는 그 계약을 안 보고 `tier`를 무조건 내보냈다.
    # checkout claim UPSERT는 Toss 청구를 부르기 *전에* 이미 커밋된다(TOCTOU 방지를 위한
    # 의도된 설계, org_subscription_checkout.py 참고) — 그래서 청구가 크래시/거절되면
    # status='pending'인 채 새 tier 값이 이미 이 행에 앉아 있는 상태가 실존한다. 실사고:
    # `TypeError: Decimal is not JSON serializable`(billing_charge_amount.py, 별도 fix)로
    # Toss 호출 자체가 500으로 죽었는데, 이 엔드포인트가 status를 안 보고 tier='starter'를
    # 그대로 내보내 "돈은 안 냈는데 플랜은 적용된 것처럼" 화면에 잡혔다(재로그인 후에도
    # 재현 — 이 GET이 그 소스). status가 'active'가 아니면(pending·downgraded 등) 실제로
    # 확定된 유료 권리가 없다 — tier를 'free'로 낸다(billing_cycle/current_period_end도
    # 같이 무의미해지므로 None). status 필드 자체는 원값 그대로 실어(FE가 pending 상태를
    # 구분해 "결제 진행/재시도 필요" 안내를 그릴 여지는 남긴다).
    effective_tier = sub.tier if sub.status == "active" else "free"
    au_current, au_limit = await _get_au_usage(session, org_id, effective_tier)
    return {
        "org_id": str(org_id),
        "tier": effective_tier,
        "billing_cycle": sub.billing_cycle if sub.status == "active" else None,
        "status": sub.status,
        "current_period_end": sub.current_period_end.isoformat() if (
            sub.status == "active" and sub.current_period_end
        ) else None,
        "can_manage": can_manage,
        # story #2909② — 하향 예약(#2881)/취소 예약(#2882)이 같은 pending_* 슬롯을 쓴다
        # (pending_tier='free'=취소, 그 외=하향). FE가 카드에 "예약됨" 상태·철회 CTA를
        # 그리려면 필요 — 이 엔드포인트가 지금까지 안 실었을 뿐, 값 자체는 이미 있었다.
        "pending_tier": sub.pending_tier,
        "pending_change_apply_at": sub.pending_change_apply_at.isoformat() if sub.pending_change_apply_at else None,
        # story #3190(결제②-C 후속·FE) — au_warn_80/90_notified_at은 크론의 메일-dedup
        # 마커일 뿐(값 자체를 노출 표면 판정에 재사용하면 크론 주기 지연만큼 배너가
        # 늦게 뜬다) — FE는 storage-capacity-banner와 동형으로 au_current/au_limit에서
        # 직접 pct를 계산한다. au_paused만은 예외로 캐시값 그대로 노출(그레이스 윈도우
        # 계산까지 FE가 재현하면 이중 SSOT — check_au_not_paused()가 읽는 것과 동일 값).
        "au_current": au_current,
        "au_limit": au_limit,
        "au_paused": sub.au_paused_at is not None,
    }


@router.get("/orders")
async def list_billing_orders(
    org_id: uuid.UUID = Depends(get_verified_org_id),
    auth: AuthContext = Depends(get_current_user),
    session: AsyncSession = Depends(get_db),
    _ee: None = Depends(_require_ee),
) -> dict:
    """story #3209(PR-1) — 웹 빌링 내역(주문별). /status와 동일 can_manage 축(owner/admin만
    — 결제 금액·영수증은 billing 관리 권한과 같은 민감도로 취급, 이 라우터의 기존
    관례를 그대로 따른다). 최근 순 최대 50건 — pending/failed도 포함(진짜 "내역"이라
    confirmed만 거르면 실패한 시도가 안 보여 사용자가 재시도 여부를 판단 못 한다).
    receipt_url은 confirmed에서만 값이 있다(billing_charge.py._confirm_with_ledger)."""
    role_result = await session.execute(
        select(OrgMember.role).where(
            OrgMember.org_id == org_id,
            OrgMember.user_id == uuid.UUID(auth.user_id),
            OrgMember.deleted_at.is_(None),
        )
    )
    caller_role = role_result.scalar_one_or_none() or "member"
    if caller_role not in ("owner", "admin"):
        raise HTTPException(status_code=403, detail="billing history requires owner/admin role")

    orders = (
        await session.execute(
            select(BillingOrder)
            .where(BillingOrder.org_id == org_id)
            .order_by(BillingOrder.created_at.desc())
            .limit(50)
        )
    ).scalars().all()
    return {
        "data": [
            {
                "order_id": o.order_id,
                "created_at": o.created_at.isoformat(),
                "amount_minor": o.amount_minor,
                "currency": o.currency,
                "status": o.status,
                "purpose": o.purpose,
                "receipt_url": o.receipt_url,
            }
            for o in orders
        ]
    }


async def _get_au_usage(
    session: AsyncSession, org_id: uuid.UUID, tier: str
) -> tuple[int, int | None]:
    """이번 달 AU 사용량 + tier별 한도. cron.py `au_usage_warn`과 동일 조회 규율
    (offering_versions DISTINCT ON tier·usage_meters current period) — 크론이 쓰는
    수치와 FE가 보는 수치가 갈라지면(split-brain) 배너 임계값이 실제 집행 임계값과
    어긋난다."""
    now = datetime.now(timezone.utc)
    period_start = now.replace(day=1, hour=0, minute=0, second=0, microsecond=0)
    au_limit = (await session.execute(
        text(
            "SELECT au_limit FROM offering_versions "
            "WHERE tier = :tier AND effective_to IS NULL ORDER BY currency ASC LIMIT 1"
        ),
        {"tier": tier},
    )).scalar()
    au_current = int((await session.execute(
        text(
            "SELECT current_value FROM usage_meters WHERE org_id = :oid "
            "AND meter_type = 'automation_units' AND period_start = :ps"
        ),
        {"oid": str(org_id), "ps": period_start},
    )).scalar() or 0)
    return au_current, au_limit


@router.get("/plans")
async def list_billing_plans(
    _auth: AuthContext = Depends(get_current_user),
    _ee: None = Depends(_require_ee),
) -> list[dict]:
    """Free/Team/Pro 플랜 카탈로그."""
    return _PLAN_CATALOG


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
    """Polar checkout 세션 생성 — owner/admin 전용.

    story #2728(선생님 결정②) — 구세계(Polar) checkout도 신세계와 동일하게 서버측 전면
    차단(org_subscription_checkout.py의 checkout과 동일 근거·동일 스위치). 카디르 QA
    (PR#3460) — EE 환경서 라이브 등록되는데 이 축 테스트가 0건이었다(실측 적출). 같은
    헬퍼(require_billing_checkout_enabled)를 공유해 판정이 갈라지지 않게 한다."""
    platform_settings = await get_platform_settings(session)
    require_billing_checkout_enabled(platform_settings)

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

    # #2478(B): 체크아웃은 여전히 USD만 다룬다(currency 선택 API 미구현, A1 그대로) —
    # provider=f(currency) 규칙으로 어댑터를 고르되 지금은 "usd" 고정.
    adapter = get_payment_adapter("usd")
    try:
        result = await adapter.create_checkout(
            price_id=price_id,
            success_url=success_url,
            cancel_url=cancel_url,
            metadata={"org_id": str(org_id)},
        )
    except RuntimeError as exc:
        raise HTTPException(status_code=502, detail=str(exc)) from exc

    return {
        "checkout_url": result.get("checkout_url"),
        "checkout_id": result.get("checkout_id"),
        "plan_id": body.plan_id,
        "billing_cycle": body.billing_cycle,
        "sandbox": result.get("sandbox"),
    }


@router.post("/webhook")
async def polar_webhook(
    request: Request,
    background_tasks: BackgroundTasks,
    session: AsyncSession = Depends(get_db),
    _ee: None = Depends(_require_ee),
) -> dict:
    """Polar 웹훅 수신 — signature 검증 + 이벤트별 Subscription 갱신 + 멱등 처리."""
    raw_body = await request.body()

    # AC2: Signature 검증 — #2478(B): PolarAdapter.verify_webhook 이관(동일 로직).
    signature = request.headers.get("X-Polar-Webhook-Signature") or request.headers.get("webhook-signature")
    adapter = get_payment_adapter("usd")
    if not adapter.verify_webhook(raw_body, signature):
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
        if pricing_version_id is None:
            # story #2411: 빈 조회(pricing_versions에 (tier, billing_cycle, "usd") 매칭 행이
            # 없음)는 예외가 아니라서 위 try/except의 "조용한 실패 봉쇄"에 안 걸린다 —
            # org_subscriptions.pricing_version_id가 nullable이라 그냥 NULL로 조용히 통과했다
            # (prod 실측, 2026-08-01: pricing_versions가 #2397/0222로 테이블만 생기고 아직
            # 시드가 없어 지금은 매번 이 분기를 탄다 — #2403이 실제 판매 정책을 정하기 前까지는
            # 의도된 상태다). grandfather 기준점 없이 구독이 만들어진다는 뜻이라 결제 자체는
            # 안 막히지만(체크아웃·화면은 코드 상수 _POLAR_PRICE_IDS/_PLAN_CATALOG를 봐서
            # DB와 무관하게 도는 — 그래서 여태 아무도 못 알아챘다) 반드시 로그로는 남긴다.
            #
            # ⚠️여기 도달하는 tier는 항상 "team"|"pro"뿐이다(이 함수의 두 호출부 —
            # checkout.completed·subscription.updated — 모두 tier를 그 둘로만 산출한다,
            # PO 확認 2026-08-01). "free"로 이 함수가 불리는 경로는 없다(무료 티어는 Polar
            # 구독/결제 이벤트 자체가 없어 upsert 대상이 아님) — 그러니 이 경고는 "free라서
            # 원래 없는 행"이라는 잡음이 될 수 없다.
            #
            # ⛔이 경고가 «그쳐야 정상»인 시점: #2403이 실제 판매 정책(티어·통화·PG)을 확정하고
            # 그에 맞는 pricing_versions 시드가 들어간 뒤. 그 후에도 이 경고가 뜨면 시드가
            # 누락됐거나(새 tier/billing_cycle 조합 추가 시 시드 갱신을 잊음) 진짜 결함 신호다 —
            # 계속 울리는데 아무도 안 본다면 이 로그가 무뎌진 것이니 다시 살펴봐야 한다.
            logger.warning(
                "pricing_version_id 미배정 — pricing_versions에 (tier=%s, billing_cycle=%s, "
                "currency=usd) 매칭 행 없음. org=%s는 grandfather 기준점 없이 구독됨.",
                tier, billing_cycle, org_id,
            )
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
