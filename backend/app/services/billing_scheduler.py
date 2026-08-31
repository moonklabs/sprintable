"""결제②-C3(story #2494) — 정기결제 재시도 상태기계 + 대사(reconciliation) 골격.

PO 계약(2026-08-07, this thread) — **(b)-narrowed**: "오늘 누구를 얼마 청구할지"(신규
결제 주기 도래 판정)는 이 스토리 밖이다. 그라운딩 결과 `org_subscriptions.
current_period_start/end`가 Toss 구독에는 애초에 채워지는 경로가 없다는 걸 확認했고
(Polar 웹훅 경로에서만 쓰임) — 그 갭은 별도 스토리([#2502](entity:story:089a6cc5-fd10-47a1-8322-cac89b1359d9))로 적어뒀다.
`trigger_due_charges()`가 그 훅 자리(NotImplementedError로 명시 — PolarAdapter/TossAdapter
의 미구현 메서드 관례와 동형).

이 스토리가 실제로 구현하는 것 — 데이터 소스가 **이미 있는** 두 축:
1. **dunning 재시도**: C2(#2493)가 만든 `billing_orders`의 `failed` 행을 스윕. 케이던스는
   지어내지 않고 정책 문서에서 짚었다(PO 가드①) — `pricing-policy-proposal-v1` §12.1을
   2026-08-07 직접 재확認: 최초실패(과금 유지)→+1일 1차 재결제→+3일 2차→+5일 3차→
   +7일 유예종료알림(재시도 아님)→+8일 Free 강제전환.
2. **대사(reconciliation)**: `pending`으로 너무 오래 멈춘 order(C2가 크래시/타임아웃
   대비로 만든 그 상태) — Toss 조회(`get_payment_by_order_id`)로 실 상태를 확認해 정합.
   C2가 "스코프 밖"으로 남긴 그 자리(§2 step8 "일일 대사").
"""
from __future__ import annotations

import logging
import os
import uuid
from datetime import datetime, timedelta, timezone

from sqlalchemy import func, or_, select, text, update
from sqlalchemy.dialects.postgresql import insert as pg_insert
from sqlalchemy.ext.asyncio import AsyncSession

from app.models.billing_order import BillingOrder
from app.models.offering_version import OfferingVersion
from app.models.org_billing_key import OrgBillingKey
from app.models.org_subscription import OrgSubscription
from app.models.project import OrgMember
from app.models.user import User
from app.services.billing_charge import (
    _confirm_with_ledger,
    _mark_failed_if_not_confirmed,
    charge_org,
)
from app.services.billing_charge_amount import ChargeAmountError, compute_charge_amount
from app.services.billing_period import compute_period_end
from app.services.email import send_email
from app.services.org_subscription_checkout import STALE_CLAIM_WINDOW
from app.services.payment.toss_adapter import TossAdapter, TossApiError
from app.services.platform_settings import get_platform_settings

logger = logging.getLogger(__name__)

# pricing-policy-proposal-v1 §12.1(2026-08-07 재확認)이 원 근거였으나, story #2907
# (선생님 확定 2026-08-21)이 cadence를 daily로 대체했다 — 3회(1/3/5일)가 아니라
# D+1..D+grace_days 매일 1회, downgrade는 D+grace_days+1. grace_days는 이제
# platform_settings.dunning_grace_days(어드민 관리값, AC6)에서 온다 — 이 상수들은
# grace_days를 안 넘겨주는 극소수 호출부를 위한 기본값(7)일 뿐, 실 판단은 아래
# next_dunning_action의 grace_days 파라미터로 한다.
_DEFAULT_DUNNING_GRACE_DAYS = 7

# Toss charge는 최대 60초(공식 문서) — 그보다 넉넉히 오래 pending이면 크래시/타임아웃으로
# 간주해 대사 대상.
PENDING_STALE_AFTER = timedelta(minutes=5)


def next_dunning_action(
    order: BillingOrder, *, now: datetime, grace_days: int = _DEFAULT_DUNNING_GRACE_DAYS,
) -> str:
    """failed order 하나에 대해 지금 뭘 해야 하는지 — 순수 함수(DB/네트워크 접촉 없음).
    "wait" | "retry" | "downgrade_to_free" 중 하나.

    story #2907 cadence(선생님 확定) — 재시도 창은 D+1..D+grace_days **매일** 1회
    (구 {1,3,5}일 3회 정책을 대체), downgrade는 D+grace_days+1.

    같은 날 중복 재시도 방지: `updated_at`이 오늘 이미 갱신됐으면(=오늘 이미 시도함) 또
    재시도하지 않는다 — cron이 하루에 여러 번 돌아도(예: */10분) 하루 1회만 재결제한다."""
    if order.status != "failed":
        return "wait"
    age_days = (now.date() - order.created_at.date()).days
    if age_days >= grace_days + 1:
        return "downgrade_to_free"
    already_attempted_today = order.updated_at.date() >= now.date()
    if 1 <= age_days <= grace_days and not already_attempted_today:
        return "retry"
    return "wait"


# 갱신 charge order_id 접두사 — 이 접두사로만 "이 실패 order가 갱신(정기결제) 실패인지"를
# 판별한다. checkout/tier_change의 실패 order도 같은 billing_orders.status='failed' 값을
# 쓰지만(purpose 컬럼도 둘 다 'charge'라 구분 안 됨 — 확認: entry_type을 명시하는 호출부는
# billing_pack.py뿐) org_subscriptions.status를 'past_due'로 전이시키는 건 갱신 실패
# 뿐이어야 한다(checkout 실패=아직 active 아니었던 org, tier_change 실패=원 tier 그대로
# 유지된 org — 둘 다 "이미 활성 유료였다가 갱신을 놓친" past_due 의미가 아니다).
_RENEWAL_ORDER_PREFIX = "renewal:"


def _renewal_order_id(org_id: uuid.UUID, offering_version_id: uuid.UUID, period_end: datetime) -> str:
    """org+offering+«원래 결제 도래일»로 결정적 키잉 — 같은 갱신 시도는 재시도 내내
    (D+1..D+grace_days) 항상 같은 order_id를 가리킨다(charge_org의 failed→pending CAS
    재청구 경로가 그대로 이 재시도를 태운다, 재구현 0)."""
    return f"{_RENEWAL_ORDER_PREFIX}{org_id}:{offering_version_id}:{period_end.date()}"


# story #2907 fast-follow(유나양 design 비차단 권고①, 2026-08-21) — FE `tierName_*`
# i18n 키(apps/web/messages/{ko,en}.json)와 동일 표시값. BE엔 별도 i18n 인프라가 없고
# 이 표시명은 en/ko 둘 다 이미 같은 문자열이라(둘 다 "Starter"/"Team"/"Business") 이
# 한 곳(메일)에서만 쓰는 매핑을 새로 발명하는 대신 그 사실을 그대로 반영한다.
_TIER_DISPLAY_NAMES = {"free": "Free", "starter": "Starter", "team": "Team", "business": "Business"}


def _dunning_email_content(*, tier: str, grace_expires_at) -> tuple[str, str]:
    """story #2907 AC3 — 매 실패마다 발송할 문안. 「언제(grace 만료일)」·「어떻게(free
    전이+신규 업로드만 차단·데이터 삭제 없음)」를 명시. tone=nice(선생님 지시) — 고객
    대면 문구라 개야갤 톤 사용 금지.

    fast-follow(유나양 design 비차단 권고, 2026-08-21) — ①raw enum(tier) 대신 표시명
    ②billing 페이지(`/settings?tab=billing`, FE `BillingTab` 딥링크 확認) CTA 링크
    추가. `NEXT_PUBLIC_APP_URL`은 `org_invite_email.py`가 이미 쓰는 동일 패턴 재사용."""
    grace_date_str = grace_expires_at.strftime("%Y-%m-%d")
    tier_display = _TIER_DISPLAY_NAMES.get(tier, tier)
    app_url = os.getenv("NEXT_PUBLIC_APP_URL", "https://app.sprintable.ai")
    billing_link = f"{app_url}/settings?tab=billing"
    subject = "[Sprintable] 결제가 처리되지 않았습니다 — 확인해 주세요"
    html_body = (
        f"<p>안녕하세요, Sprintable입니다.</p>"
        f"<p>정기결제 시도가 처리되지 않았습니다. 저희 쪽에서 매일 자동으로 재시도하고 "
        f"있으니, 등록하신 카드 정보를 확인해 주시면 감사하겠습니다.</p>"
        f"<p><b>{grace_date_str}</b>까지 결제가 완료되지 않으면 조직의 플랜이 자동으로 "
        f"Free로 전환됩니다. Free로 전환되어도 <b>기존 데이터는 삭제되지 않으며</b>, "
        f"신규 업로드만 제한됩니다. 이후 결제를 완료하시면 즉시 원래 플랜({tier_display})으로 "
        f"복귀합니다.</p>"
        f"<p><a href=\"{billing_link}\">결제 정보 확인하러 가기</a></p>"
        f"<p>문의사항이 있으시면 언제든 회신해 주세요.</p>"
    )
    return subject, html_body


async def _notify_dunning_failure(session: AsyncSession, org_id: uuid.UUID, *, tier: str, grace_expires_at) -> None:
    """실패 통보 메일 — org owner/admin 전원 수신(storage-usage-warn과 동일 조회 패턴,
    S8). best-effort(개별 흡수) — 메일 실패가 스윕 자체를 막으면 안 된다."""
    subject, html_body = _dunning_email_content(tier=tier, grace_expires_at=grace_expires_at)
    emails = [
        r[0] for r in (await session.execute(
            select(User.email)
            .join(OrgMember, User.id == OrgMember.user_id)
            .where(
                OrgMember.org_id == org_id,
                OrgMember.role.in_(["owner", "admin"]),
                OrgMember.deleted_at.is_(None),
            )
        )).all()
    ]
    for em in emails:
        try:
            send_email(em, subject, html_body)
        except Exception:
            logger.warning("dunning failure email 실패 org=%s", org_id, exc_info=True)


async def downgrade_to_free(session: AsyncSession, org_id: uuid.UUID, order_id: str) -> None:
    """§12.1 +8일 — Free 권리로 전환. 기존 데이터는 절대 지우지 않는다(정책 명시) — 이
    함수는 구독 tier만 되돌린다, 데이터 삭제/에이전트 강제해제는 정책상 없음(§12.1 원문:
    "이미 등록된 에이전트를 강제 해제하지 않는다").

    PO 리뷰 블로커(#2884, 2026-08-07) — "상태 자가회수 부재": org_subscriptions만 바꾸고
    이 order를 'failed'로 그대로 두면 ①매 스윕마다 같은 order가 다시 골라져 재처리되고
    ②더 심각하게, 이 org가 나중에 카드 고쳐 재구독(유료)해도 다음 스윕이 이 옛 order
    (age≫8)를 보고 org를 다시 free로 upsert해 **새 유료 구독을 clobber**한다. order를
    종결 상태 'downgraded'로 전이시켜(status!='confirmed' 가드) failed-스윕 대상에서
    영구히 뺀다 — 'failed' 그대로 두거나 'confirmed'를 재사용하지 않는 이유는 이게 실제
    Toss 승인이 아니라 강제 강등이라 원장 의미가 다르기 때문(0232 마이그로 CHECK 확장).

    카디르 결함사냥(#2509, 2026-08-07) — "다른-order 재구독 클로버": 이 함수가 org의
    현재 상태를 안 보고 무조건 free upsert했다. cron이 여러 org를 Toss 콜 포함해 순회하는
    동안(창이 실재) org가 다른 order_id로 재구독(pro)을 성공시키면, 뒤늦게 처리되는 이
    stale order가 방금 성립한 pro 구독을 free로 덮어썼다. 재확認: 이 stale order보다
    "나중에" confirmed된 order가 있거나, 이 stale order 생성 이후 새로 발급된 활성
    billing_key가 있으면(재인증 진행 중 — 아직 charge는 안 끝났을 수 있는 그 race
    윈도) 이미 다른 경로로 회복 중/완료된 것이니 free upsert를 건너뛴다.
    ⚠️"활성 billing_key 존재" 자체는 쓰지 않는다 — dunning 재시도(+1/+3/+5일)는 원래
    billing_key로 하므로 실패 시퀀스 내내 키가 active인 게 정상이라, 그것만으로 걸면
    진짜 8일 지난 미해결 delinquent도 영원히 강등 안 되는 회귀가 난다. 반드시 order.
    created_at *이후* 시점(newer)으로 앵커링된 신호만 "회복 증거"로 인정한다."""
    order = (
        await session.execute(select(BillingOrder).where(BillingOrder.order_id == order_id))
    ).scalar_one_or_none()
    if order is None:
        return  # 이미 존재 안 함(동시 처리 등) — 할 일 없음.

    has_newer_confirmed_order = (
        await session.execute(
            select(BillingOrder.id).where(
                BillingOrder.org_id == org_id,
                BillingOrder.status == "confirmed",
                BillingOrder.created_at > order.created_at,
            ).limit(1)
        )
    ).first() is not None
    has_newly_issued_billing_key = (
        await session.execute(
            select(OrgBillingKey.id).where(
                OrgBillingKey.org_id == org_id,
                OrgBillingKey.status == "active",
                OrgBillingKey.issued_at > order.created_at,
            ).limit(1)
        )
    ).first() is not None

    # PO 지적(#2896 리뷰, 2026-08-07) — #2511이 만든 checkout_claimed_at도 같은 「claim
    # 정합」 축이라 이 함수도 존중해야 한다. 위 두 신호(has_newer_confirmed_order·
    # has_newly_issued_billing_key)는 checkout이 이미 뭔가를 "완성"했을 때만 감지한다 —
    # claim은 성공했지만 아직 issue_billing_key/charge_org가 끝나기 前인(아무 새 증거도
    # 아직 없는) 딱 그 창에서는 둘 다 놓친다. 그 창에 이 스윕이 끼어들면 free upsert가
    # checkout이 진행 中인 org의 tier를 조용히 덮어써 — 나중에 그 checkout의 charge가
    # 실제로 confirmed돼도(#2511 step④ CAS는 통과— 이 함수가 checkout_claimed_at 자체는
    # 안 건드리므로) "유료청구는 됐는데 tier는 free"라는 영구 오염이 남는다. staleness
    # 윈도(#2511과 동일 SSOT)를 넘긴 claim은 죽은/멈춘 걸로 보고 무시한다(자기치유 그대로).
    now = datetime.now(timezone.utc)
    has_active_checkout_claim = (
        await session.execute(
            select(OrgSubscription.id).where(
                OrgSubscription.org_id == org_id,
                OrgSubscription.checkout_claimed_at.is_not(None),
                OrgSubscription.checkout_claimed_at >= now - STALE_CLAIM_WINDOW,
            ).limit(1)
        )
    ).first() is not None

    # ⚠️카디르 재QA(codex, #2896 리뷰, 2026-08-07) — 위 has_active_checkout_claim은 SELECT
    # 一 write-time 가드가 아니다. SELECT 시점엔 claim이 없었어도 그 뒤(offering 조회 등
    # await 2번) 새 claim이 서면 이 조건은 이미 지나간 값을 보고 있어 무시된다. 이 early-
    # return SELECT는 "명백히 막힌 경우 Toss/offering 조회 낭비를 피하는" 최적화일 뿐,
    # 실제 안전장치는 아래 UPSERT 자체의 WHERE(원래 checkout claim UPSERT와 동일 패턴)다
    # — SELECT-then-write가 아니라 write-time 원자적 가드로 이 창을 완전히 닫는다.
    if not (has_newer_confirmed_order or has_newly_issued_billing_key or has_active_checkout_claim):
        free_offering = (
            await session.execute(
                select(OfferingVersion).where(
                    OfferingVersion.tier == "free",
                    OfferingVersion.currency == "krw",
                    OfferingVersion.effective_to.is_(None),
                )
            )
        ).scalar_one_or_none()

        stmt = pg_insert(OrgSubscription).values(
            id=uuid.uuid4(), org_id=org_id, tier="free", status="active",
            provider="toss", currency="krw", billing_cycle=None,
            offering_version_id=free_offering.id if free_offering else None,
        ).on_conflict_do_update(
            index_elements=["org_id"],
            set_={
                "tier": "free", "status": "active",
                "offering_version_id": free_offering.id if free_offering else None,
            },
            where=or_(
                OrgSubscription.checkout_claimed_at.is_(None),
                OrgSubscription.checkout_claimed_at < now - STALE_CLAIM_WINDOW,
            ),
        )
        await session.execute(stmt)

    # 회복 증거가 있어 free upsert는 건너뛰었어도, 이 stale order 자체는 여전히 닫는다
    # (재처리 방지 목적은 그대로 달성 — 매 스윕마다 같은 order가 다시 안 골라지게).
    await session.execute(
        update(BillingOrder)
        .where(BillingOrder.order_id == order_id, BillingOrder.status != "confirmed")
        .values(status="downgraded", updated_at=func.now())
    )
    await session.commit()


async def sweep_dunning_retries(session: AsyncSession, *, now: datetime | None = None) -> dict:
    """failed billing_orders를 스윕 — cadence대로 재시도하거나 Free로 전환.

    story #2907 — `renewal:` 접두사(=trigger_due_charges가 만든 갱신 실패 order)는 재시도
    결과에 따라 org_subscriptions.status를 'active'⇄'past_due'로 동기화하고 매 실패마다
    owner 메일을 보낸다(AC1-3). 그 외(checkout/tier_change 실패 order)는 기존 동작 그대로
    — past_due 전이 대상이 아니다(둘 다 "이미 활성 유료였다가 갱신을 놓친" 상태가 아님)."""
    now = now or datetime.now(timezone.utc)
    grace_days = (await get_platform_settings(session)).dunning_grace_days
    failed_orders = (
        await session.execute(select(BillingOrder).where(BillingOrder.status == "failed"))
    ).scalars().all()

    retried = downgraded = 0
    for order in failed_orders:
        action = next_dunning_action(order, now=now, grace_days=grace_days)
        is_renewal = order.order_id.startswith(_RENEWAL_ORDER_PREFIX)
        if action == "retry":
            try:
                # charge_org 자체가 이미 claim/멱등/원장 불변식을 다 지킨다(#2493) — 여기서는
                # 그냥 같은 order_id/amount로 재호출만 한다. 실패해도 charge_org 내부에서
                # 이미 failed로 재기록됐으니 여기선 로깅만(다음 스윕이 또 판단).
                await charge_org(
                    session, org_id=order.org_id, order_id=order.order_id,
                    amount_minor=order.amount_minor, currency=order.currency,
                )
            except Exception:
                logger.exception("dunning retry failed for order_id=%s", order.order_id)
            retried += 1
            if is_renewal:
                await _sync_renewal_retry_outcome(session, order.org_id, order.order_id, grace_days=grace_days, now=now)
        elif action == "downgrade_to_free":
            await downgrade_to_free(session, order.org_id, order.order_id)
            downgraded += 1

    return {"failed_orders_seen": len(failed_orders), "retried": retried, "downgraded": downgraded}


async def _sync_renewal_retry_outcome(
    session: AsyncSession, org_id: uuid.UUID, order_id: str, *, grace_days: int, now: datetime,
) -> None:
    """갱신 재시도(retry) 시도 直後 — 그 시도가 confirmed로 끝났으면 원 주기 유지한 채
    active로 복귀·period 롤오버(AC2 "성공 시 원 주기 유지"), 아직 failed면 past_due
    유지+이번 실패도 통보(AC3 "매 실패마다")."""
    order = (
        await session.execute(select(BillingOrder).where(BillingOrder.order_id == order_id))
    ).scalar_one()
    sub = (
        await session.execute(select(OrgSubscription).where(OrgSubscription.org_id == org_id))
    ).scalar_one_or_none()
    if sub is None:
        return

    if order.status == "confirmed":
        # AC2 — 재결제 성공 시 원 주기 유지: sub.current_period_end는 실패 후에도 «원래
        # 도래했어야 할 날짜» 그대로다(trigger_due_charges가 실패 시 굴리지 않는다) — 그
        # 값을 새 period_start로 삼아 다음 주기를 계산한다(추가 유예일을 공짜로 주지 않음).
        old_due = sub.current_period_end
        new_end = compute_period_end(old_due, sub.billing_cycle)
        await session.execute(
            update(OrgSubscription).where(OrgSubscription.org_id == org_id).values(
                status="active", current_period_start=old_due, current_period_end=new_end,
            )
        )
        await session.commit()
    else:
        await session.execute(
            update(OrgSubscription).where(OrgSubscription.org_id == org_id, OrgSubscription.status != "past_due")
            .values(status="past_due")
        )
        await session.commit()
        grace_expires_at = order.created_at.date() + timedelta(days=grace_days)
        await _notify_dunning_failure(session, org_id, tier=sub.tier, grace_expires_at=grace_expires_at)


async def sweep_stale_pending_orders(session: AsyncSession, *, now: datetime | None = None) -> dict:
    """PENDING_STALE_AFTER보다 오래 pending인 order를 Toss 조회로 대사한다 — C2가 "일일
    대사" 스코프 밖으로 남긴 그 자리(orderId-먼저-기록 설계의 짝: 기록은 됐는데 Toss 응답을
    못 받은 채 죽은 프로세스를 여기서 회수한다)."""
    now = now or datetime.now(timezone.utc)
    cutoff = now - PENDING_STALE_AFTER
    stale_orders = (
        await session.execute(
            select(BillingOrder).where(BillingOrder.status == "pending", BillingOrder.created_at < cutoff)
        )
    ).scalars().all()

    confirmed = failed = skipped = not_found = 0
    for order in stale_orders:
        try:
            lookup = await TossAdapter().get_payment_by_order_id(
                order_id=order.order_id, quiet_codes=frozenset({"NOT_FOUND_PAYMENT"}),
            )
        except TossApiError as exc:
            if exc.code == "NOT_FOUND_PAYMENT":
                # story #2913(2896 첫 실행 실증) — Toss가 이 주문을 애초에 모른다는
                # *확정* 신호(위젯 진입 前 이탈 등)라, 아래 일반 except의 "조회 자체
                # 실패(네트워크 등) = 혹시 성공했을 수도 있다"는 전제와 다르다. pending은
                # 그대로 둔다(#2884 안전측 설계 그대로 — 삭제·failed 전환 없음) — 이
                # 주문은 cutoff를 넘은 이상 매일 재스윕되고 매번 같은 결과를 받는데, 그걸
                # logger.exception(풀 traceback)으로 매번 다시 찍으면 운영 로그가 "확정된
                # 무해 사실"로 영구 오염된다. 별도 카운트+INFO 한 줄로 조용히 넘긴다.
                logger.info(
                    "stale pending order_id=%s — Toss NOT_FOUND_PAYMENT(확정 미발생, 위젯 진입 前 이탈 등) — leaving pending",
                    order.order_id,
                )
                not_found += 1
                continue
            logger.exception("stale pending reconciliation lookup failed for order_id=%s — leaving pending", order.order_id)
            skipped += 1
            continue
        except Exception:
            # PO fix-forward(#2884 리뷰) — 조회 자체가 실패(네트워크 일시 장애 등)한 것과
            # "Toss가 이 주문을 모른다/실패로 안다"는 다른 신호다. 전자를 failed로 찍으면
            # 실은 성공했을 수도 있는 charge를 오분류한다 — pending 그대로 두고 다음
            # 스윕이 다시 조회하게 한다(무한 대기 아님 — lookup이 언젠가 성공하면 정리됨).
            logger.exception("stale pending reconciliation lookup failed for order_id=%s — leaving pending", order.order_id)
            skipped += 1
            continue

        if lookup.get("status") == "DONE" and lookup.get("paymentKey"):
            # story #3209(PR-1) — 이 대사 경로로 confirmed되는 order도 동일하게 receipt_url을 채운다.
            await _confirm_with_ledger(
                session, org_id=order.org_id, order_id=order.order_id,
                amount_minor=order.amount_minor, currency=order.currency,
                payment_key=lookup["paymentKey"],
                receipt_url=(lookup.get("receipt") or {}).get("url"),
            )
            confirmed += 1
        else:
            await _mark_failed_if_not_confirmed(
                session, order.order_id, f"stale pending — lookup status={lookup.get('status')}"
            )
            failed += 1

    return {
        "stale_pending_seen": len(stale_orders), "confirmed": confirmed,
        "failed": failed, "skipped_lookup_error": skipped, "not_found_confirmed_absent": not_found,
    }


async def sweep_expired_grants(session: AsyncSession, *, now: datetime | None = None) -> dict:
    """story #2777 PR2 — 어드민 credit_grant(app/services/admin_billing.py::grant_credit)로
    부여된 임시 유료 tier의 자가회수. PR1이 grant 시 billing_ledger_entries.entry_metadata에
    심어둔 재료(kind='tier_grant'·target_tier·prev_tier·grant_expires_at)를 읽어 만료된
    grant를 되돌린다 — grant_expires_at 자체는 org_subscriptions.current_period_end에도
    반영돼 있지만(테넌트 상세 "언제까지" 읽기 경로), **자동으로 되돌리는 코드는 이 함수가
    유일**(그 갭이 원래 헤드라인②였다).

    가드(PO 판정 2026-08-18, 과잉살상 방지) — org의 **가장 최근** credit_grant만 후보로
    삼고, 그 grant 이후 org_subscriptions.tier가 **한 번도 안 바뀌었을 때만**(=지금 tier가
    여전히 grant의 target_tier와 같을 때만) prev_tier로 되돌린다. 그 사이 실결제 업그레이드/
    다운그레이드 등으로 tier가 달라졌으면 no-op(그 변경이 이미 grant를 무의미하게 만들었으므로
    되돌릴 게 없다) — skipped_reason 기록.

    카디르군 QA 실PG 재현(2026-08-18, PR2 head c47db6dd5) — 동일 tier 재부여(이미 team인
    org에 team 사용권 재부여, 정상 CS 유스케이스)는 target_tier == prev_tier가 된다. 구
    버전은 "이미 되돌려짐"을 `current_tier == prev_tier` 값-비교 휴리스틱으로만 판정했는데,
    이 케이스에선 되돌리기 **전에도** current_tier(team) == prev_tier(team)가 이미 참이라
    휴리스틱이 원천 무력화 — fresh PG에서 스윕을 3연속 돌리면 매번 "아직 안 되돌림"으로
    오판해 매번 reverted+1, current_period_*를 계속 None으로 재설정한다(테넌트 상세가
    읽는 그 필드의 무결성이 매 주기 깨짐).

    fix(PO 판정 2026-08-18) — 값-비교 휴리스틱을 폐기하고 **내구 마커**로 바꾼다. revert
    시 원장에 companion 행(entry_type='adjustment'·metadata.kind='tier_grant_revert'·
    metadata.reverted_entry_id=원 grant id)을 append한다. 동일 tier 재부여 자체(정상
    유스케이스)는 계속 허용 — 이 fix가 막는 건 "재부여"가 아니라 "같은 grant를 여러 번
    되돌리는" 회귀뿐이다.

    카디르군 QA 3차(2026-08-18, PR2 head 03a42af35) — companion 마커를 **DISTINCT ON보다
    먼저** WHERE에 걸면(1차 시도), 순차 grant(A: free→team 만료·B: team→business 만료,
    ts는 B가 A보다 최신)가 있는 org에서 1차 스윕이 B를 정확히 회수한 뒤, 2차 스윕은 B가
    companion 때문에 후보 집합에서 아예 빠져버려 **DISTINCT ON이 남은 행 중 최신인 A를
    "org의 최신 grant"로 오판**한다 — A는 진작에 B에 의해 superseded된 낡은 grant인데
    tier 우연 일치(A.target_tier == 되돌아간 현재 tier)까지 겹치면 A가 그대로 되돌려져
    tier가 free로 붕괴한다(fresh PG 재현 확定).

    **불변식(이 함수가 지켜야 하는 것, 쿼리는 이 문장을 그대로 구현해야 한다)**:
    스윕 후보 = org별 **절대 최신** grant(ts DESC 1건, companion 유무와 무관하게 결정)
    정확히 1건이며, 그 1건이 ⓐ미회수(companion 없음) ⓑ만료 ⓒtier 정합일 때만 회수한다.
    최신이 아닌 grant는 회수 여부와 무관하게 영원히 후보가 아니다(신 grant가 구 grant를
    대체 — superseded된 grant는 되돌릴 대상에서 항구적으로 제외).

    구현 — CTE로 "org별 절대 최신 grant"를 companion 유무와 **무관하게** 먼저 확정한
    뒤, 그 특정 행 하나에 대해서만 companion 존재 여부를 바깥 WHERE로 검사한다(순서가
    거꾸로면 위 재현처럼 최신이 회수돼 사라진 순간 구 grant가 "새 최신"으로 승격돼버린다
    — DISTINCT ON과 NOT EXISTS는 같은 WHERE 절에서 함께 못 걸리고, 반드시 DISTINCT ON이
    "필터 없는 전체 grant 집합" 위에서 먼저 절대 최신을 뽑아야 한다)."""
    from app.services.admin_billing import _audit  # 순환 임포트 회피(admin_billing이 이 모듈을 안 씀)
    from app.services.billing_ledger import record_ledger_entry

    now = now or datetime.now(timezone.utc)

    # entry_metadata는 BillingLedgerEntry의 Python 속성명일 뿐, DB 컬럼명은 "metadata"다
    # (모델 주석 — AC 원문대로·Base.metadata 예약명 충돌 회피). raw SQL은 실 컬럼명을 쓴다.
    latest_grants = (
        await session.execute(
            text(
                """
                WITH absolute_latest_grants AS (
                    -- companion 유무와 무관하게, org별 «절대 최신» grant 정확히 1건을
                    -- 먼저 확定(위 불변식 ⓐ 이전 단계 — superseded 판정의 유일한 축).
                    SELECT DISTINCT ON (org_id) id, org_id, amount_minor, currency,
                           metadata AS entry_metadata
                    FROM billing_ledger_entries
                    WHERE entry_type = 'credit_grant' AND metadata->>'kind' = 'tier_grant'
                    ORDER BY org_id, ts DESC
                )
                SELECT lg.id, lg.org_id, lg.amount_minor, lg.currency, lg.entry_metadata
                FROM absolute_latest_grants lg
                WHERE NOT EXISTS (
                    -- «그 특정 절대-최신 행 하나»에만 companion 유무를 검사(불변식 ⓐ).
                    -- companion이 있으면 이 org는 이번 스윕에서 후보가 아예 없음(구
                    -- grant로 되돌아가지 않는다 — superseded는 영구 제외).
                    SELECT 1 FROM billing_ledger_entries r
                    WHERE r.entry_type = 'adjustment'
                      AND r.metadata->>'kind' = 'tier_grant_revert'
                      AND r.metadata->>'reverted_entry_id' = lg.id::text
                )
                """
            )
        )
    ).mappings().all()

    reverted = skipped_tier_changed = skipped_not_expired = skipped_already_reverted = 0
    for row in latest_grants:
        meta = row["entry_metadata"]
        expires_at = datetime.fromisoformat(meta["grant_expires_at"])
        if expires_at >= now:
            skipped_not_expired += 1
            continue

        org_id = row["org_id"]
        sub = (
            await session.execute(select(OrgSubscription).where(OrgSubscription.org_id == org_id))
        ).scalar_one_or_none()
        current_tier = sub.tier if sub is not None else None
        if current_tier != meta["target_tier"]:
            # 그 사이 실결제/다른 조작으로 tier가 바뀜 — 이 grant는 이미 무의미, 손대지 않는다.
            # (companion 마커 설계상 "이미 되돌려짐"은 위 NOT EXISTS가 후보에서 이미 제외하므로
            # 여기 도달하는 경우는 항상 진짜 외부 tier 변경뿐 — skipped_already_reverted는 더
            # 이상 이 분기에서 발생하지 않는다.)
            _audit(
                actor_email="system:sweep_expired_grants", org_id=org_id, action="grant_sweep_skipped",
                before={"expected_tier": meta["target_tier"], "actual_tier": current_tier},
                after={"skipped_reason": "tier_changed_since_grant"},
            )
            skipped_tier_changed += 1
            continue

        prev_tier = meta["prev_tier"]
        sub.tier = prev_tier
        sub.status = "active"
        sub.current_period_start = None
        sub.current_period_end = None
        await session.flush()
        # record_ledger_entry가 내부에서 commit — 위 구독 되돌리기(flush만)와 이 companion
        # 원장 기입이 같은 트랜잭션으로 함께 확정된다(admin_billing.grant_credit과 동일
        # flush-then-record_ledger_entry-commit 패턴). provider_ref는 원 grant id로 결정적
        # 유도 — 동시/재실행 스윕이 같은 grant를 두 번 되돌려도 companion 자체는 멱등.
        await record_ledger_entry(
            session, org_id=org_id, entry_type="adjustment",
            amount_minor=row["amount_minor"], currency=row["currency"], direction="debit",
            provider_ref=f"grant-revert:{row['id']}",
            metadata={
                "kind": "tier_grant_revert",
                "reverted_entry_id": str(row["id"]),
                "reverted_target_tier": meta["target_tier"],
                "reverted_to_tier": prev_tier,
            },
        )
        _audit(
            actor_email="system:sweep_expired_grants", org_id=org_id, action="grant_sweep_reverted",
            before={"tier": meta["target_tier"]}, after={"tier": prev_tier},
        )
        reverted += 1

    return {
        "grants_seen": len(latest_grants), "reverted": reverted,
        "skipped_tier_changed": skipped_tier_changed, "skipped_not_expired": skipped_not_expired,
        "skipped_already_reverted": skipped_already_reverted,
    }


async def trigger_due_charges(session: AsyncSession, *, now: datetime | None = None) -> dict:
    """오늘 신규 결제 주기가 도래한 org를 찾아 갱신 청구를 트리거한다 — story #2502가
    #2907 착수 前 완료돼(current_period_start/end가 Toss 경로에도 세팅됨, checkout §③/
    tier_change ③) 이 자리를 막던 전제가 사라졌다(2026-08-21 그라운딩 재확認). story
    #2907(dunning)의 진입점 — 여기서 청구가 실패해야 dunning이 시작된다.

    대상: status='active'·유료 tier·current_period_end 도래(<=now)인 org. 성공 시
    다음 주기로 롤오버(active 유지). 실패 시 status='past_due' 전이 + 1차 통보 메일
    (AC1·AC3 — "매 실패마다"는 이 첫 실패도 포함)."""
    now = now or datetime.now(timezone.utc)
    grace_days = (await get_platform_settings(session)).dunning_grace_days
    due_subs = (
        await session.execute(
            select(OrgSubscription).where(
                OrgSubscription.status == "active",
                OrgSubscription.tier != "free",
                OrgSubscription.current_period_end.is_not(None),
                OrgSubscription.current_period_end <= now,
            )
        )
    ).scalars().all()

    charged = failed = skipped_catalog_error = 0
    for sub in due_subs:
        if sub.offering_version_id is None:
            # 카탈로그 바인딩 자체가 없는 org — 고객 결제 실패가 아니라 내부 데이터 갭이라
            # past_due로 벌하지 않는다(로그만 남기고 다음 스윕이 다시 본다).
            logger.error("trigger_due_charges: org_id=%s active paid without offering_version_id — skip", sub.org_id)
            skipped_catalog_error += 1
            continue
        order_id = _renewal_order_id(sub.org_id, sub.offering_version_id, sub.current_period_end)
        try:
            amount_minor, currency = await compute_charge_amount(session, org_id=sub.org_id)
        except ChargeAmountError:
            logger.exception("trigger_due_charges: compute_charge_amount failed for org_id=%s", sub.org_id)
            skipped_catalog_error += 1
            continue

        try:
            order = await charge_org(
                session, org_id=sub.org_id, order_id=order_id, amount_minor=amount_minor,
                currency=currency, order_name="Sprintable 정기결제(갱신)",
            )
        except Exception:
            logger.exception("trigger_due_charges: charge_org failed for org_id=%s order_id=%s", sub.org_id, order_id)
            order = (
                await session.execute(select(BillingOrder).where(BillingOrder.order_id == order_id))
            ).scalar_one_or_none()

        if order is not None and order.status == "confirmed":
            new_end = compute_period_end(sub.current_period_end, sub.billing_cycle)
            await session.execute(
                update(OrgSubscription).where(OrgSubscription.org_id == sub.org_id).values(
                    current_period_start=sub.current_period_end, current_period_end=new_end,
                )
            )
            await session.commit()
            charged += 1
        else:
            await session.execute(
                update(OrgSubscription).where(OrgSubscription.org_id == sub.org_id).values(status="past_due")
            )
            await session.commit()
            # fast-follow(유나양 design 비차단 권고④, 2026-08-21) — 이 실패 order의
            # created_at을 앵커로 쓴다(`_sync_renewal_retry_outcome`이 재시도 실패마다
            # 쓰는 앵커와 동일 소스). `now`는 DB 트랜잭션 타임스탬프와 미세하게(또는
            # 자정 근처면 하루) 어긋날 수 있어 두 지점이 서로 다른 grace 만료일을
            # 계산할 위험이 있었다 — order가 없는 극단적 실패(claim INSERT 자체가
            # 안 됨)만 now.date()로 폴백.
            grace_anchor = order.created_at.date() if order is not None else now.date()
            grace_expires_at = grace_anchor + timedelta(days=grace_days)
            await _notify_dunning_failure(session, sub.org_id, tier=sub.tier, grace_expires_at=grace_expires_at)
            failed += 1

    return {
        "due_subs_seen": len(due_subs), "charged": charged, "failed": failed,
        "skipped_catalog_error": skipped_catalog_error,
    }
