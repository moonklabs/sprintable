"""결제②-D선행(story #2502+#2506, PO 확定 2026-08-07) — Toss 구독 체크아웃. org가 Toss
위젯으로 카드 인증을 마친 뒤 도달하는 진입점 — 결제②의 "실 진입점"이 없었던 마지막 갭을
채운다(TossAdapter 호출부 전수 grep으로 확認했던 그 자리).

**상태기계**(PO 확定, "돈이 걸린 판단"으로 명시 승인받은 설계):
1. `issue_billing_key`(C1) — 카드 인증 완료 → 실 빌링키 발급.
2. org_subscription을 status='pending'으로 생성/전이(tier·billing_cycle·offering_version_id·
   current_period 세팅) — **아직 active 아님**.
3. `compute_charge_amount`(#2500) + `charge_org`(C2) — **즉시 1차 청구**(PG 관례상 구독
   시작=즉시 결제·프로레이션 없음·pricing-policy-v2-3에 트라이얼 규정 없음, PO 확定).
4. 청구 **성공 時에만** status='active' 전이. 실패 시 active 세팅 안 함(pending인 채로
   남아 재시도 가능) — "부분실패가 어디서 나도 유료 권리 없음"이 안전한 방향.

⚠️issue_billing_key가 내부에서 자체 commit하는 기존 코드(C1, 이미 리뷰 통과)를 이 스토리
때문에 리팩터하지 않는다(PO 확定) — ①②가 별도 커밋되는 2단계지만, ③에서 구독 active
게이트가 걸려 있어 그 사이 크래시나도 유료 권리가 새지 않는다(무해 — issue_billing_key
자체도 재호출 시 기존 customer_key 재사용이라 안전하게 재시도됨).

#2511(카디르 #2890 결함사냥 재QA, 2026-08-07) — 위 상태기계는 "같은" tier/cycle 재시도
(더블클릭)만 방어했다(결정적 order_id + C2 원자적 claim). 같은 org가 checkout **진행
中**(Toss 응답 대기)에 **다른** tier/cycle로 재제출하면 offering_version_id가 달라
order_id도 달라져(§_checkout_order_id) 서로 다른 claim이 둘 다 성공 — 이중 청구가
가능했다. advisory_xact_lock은 이 함수처럼 여러 번 commit하는 흐름 전체를 못 덮는다
(중간 commit마다 락이 풀려 그 틈에 경쟁자가 끼어들 수 있음 — 재획득해도 "재획득 시도
자체"가 다시 경쟁이라 완전 직렬화가 안 됨, 실측 확認). 그래서 이 fix는 advisory lock이
아니라 **org_subscriptions 행 자체를 서버 정본 claim으로** 쓴다(story #2511 AC 옵션①)
— `checkout_claimed_at` 가드가 걸린 단일 원자적 UPSERT(Postgres 자체의 행단위 write
직렬화가 소스, 별도 락 메커니즘 불요)로 동시 다른 tier/cycle 요청 중 **정확히 하나만**
claim에 성공하고, 나머지는 Toss를 한 번도 부르기 전에(issue_billing_key조차 호출
안 함) rowcount=0으로 즉시 거부된다. 성공/거절(CheckoutDeclined)/예상 밖 예외 어느
경로든 `finally`에서 claim을 해제(NULL)한다 — 프로세스가 해제 前에 죽어도 STALE_CLAIM_
WINDOW가 지나면 다음 요청이 claim을 훔쳐가 org가 영구히 막히지 않는다(자기치유)."""
from __future__ import annotations

import uuid
from datetime import datetime, timedelta, timezone

from sqlalchemy import or_, select, text, update
from sqlalchemy.dialects.postgresql import insert as pg_insert
from sqlalchemy.ext.asyncio import AsyncSession

from app.models.offering_version import OfferingVersion
from app.models.org_subscription import OrgSubscription
from app.services.billing_charge import charge_org
from app.services.billing_charge_amount import compute_charge_amount
from app.services.billing_period import new_subscription_period
from app.services.org_billing_key import issue_billing_key
from app.services.payment.toss_adapter import TossApiError

PAID_TIERS = frozenset({"starter", "team", "business"})
BILLING_CYCLES = frozenset({"monthly", "annual"})

# #2511 — claim이 release 전에 프로세스 크래시로 영영 안 풀리는 경우의 자기치유 윈도.
# Toss billing-key 발급+청구 왕복은 정상적으로 수 초~수십 초 내 끝난다(참고: C4의 Toss
# webhook 재시도 최대 7회/~3일19시간과는 별개 축 — 이건 "이 요청 자체"의 처리시간 상한).
STALE_CLAIM_WINDOW = timedelta(minutes=3)


class CheckoutError(Exception):
    """체크아웃을 진행할 수 없는 상태 — 명시 실패."""


class CheckoutInProgress(CheckoutError):
    """#2511 — 같은 org의 다른 checkout이 이미 진행 中(claim 보유)이라 이 요청은 Toss를
    한 번도 부르지 않고 즉시 거부됨. 사용자 입력 오류가 아니라 타이밍 충돌 — 라우터가
    409로 매핑(카드 거절인 CheckoutDeclined의 200과도, 내부 상태 오류인 다른
    CheckoutError의 500과도 다른 자리)."""


class CheckoutDeclined(Exception):
    """카드 인증·구독 레코드까지는 성립했으나 즉시 1차 청구가 Toss에 의해 거절됨(카드
    한도·정지 등 비즈니스 사유) — 시스템 오류가 아니다. 구독은 status='pending'으로
    남아(active 아님) 재시도 가능."""

    def __init__(self, message: str, *, subscription: OrgSubscription):
        self.subscription = subscription
        super().__init__(message)


def _checkout_order_id(org_id: uuid.UUID, offering_version_id: uuid.UUID, today: datetime) -> str:
    """결정적 orderId — 같은 org가 같은 offering으로 같은 날 여러 번 요청(더블클릭·FE
    재시도)해도 charge_org의 원자적 claim(#2493)이 같은 order_id로 수렴시켜 중복 Toss
    호출을 막는다. 날짜를 넣는 이유: 순수 (org_id, offering_version_id)만 쓰면 다운그레이드
    後 몇 달 뒤 재구독 시 옛(이미 confirmed) order와 충돌해 새 청구 없이 옛 결과를 그대로
    반환해버린다 — 그건 실 결제 누락이라 날짜로 그 함정을 피한다."""
    return f"checkout:{org_id}:{offering_version_id}:{today.date().isoformat()}"


async def checkout_subscription(
    session: AsyncSession,
    *,
    org_id: uuid.UUID,
    auth_key: str,
    tier: str,
    billing_cycle: str,
) -> OrgSubscription:
    if tier not in PAID_TIERS:
        raise CheckoutError(f"tier={tier!r}는 체크아웃 대상이 아님(free 제외, {sorted(PAID_TIERS)}만)")
    if billing_cycle not in BILLING_CYCLES:
        raise CheckoutError(f"billing_cycle={billing_cycle!r}는 'monthly'/'annual'만 허용")

    offering = (
        await session.execute(
            select(OfferingVersion).where(
                OfferingVersion.tier == tier,
                OfferingVersion.currency == "krw",
                OfferingVersion.effective_to.is_(None),
            )
        )
    ).scalar_one_or_none()
    if offering is None:
        raise CheckoutError(f"tier={tier!r}의 활성 offering_version(krw)을 찾을 수 없음")

    now = datetime.now(timezone.utc)
    period_start, period_end = new_subscription_period(now=now, billing_cycle=billing_cycle)

    # 카디르 결함사냥 TOCTOU-fix(#2898 3차 재QA, 2026-08-07) — org_subscriptions.org_id는
    # organizations에 FK가 없어(provider-agnostic 구조, #2471 A1) DB가 "이 org가 지금
    # 삭제 진행 中인가"를 write 시점에 원천 차단하지 못한다. 이 claim UPSERT와 #2092의
    # 조직 삭제(organizations 행 FOR UPDATE)를 **같은 org 행 위에서 직렬화**한다 — 삭제가
    # 먼저 이 행을 잠그면 이 SELECT가 대기하다 삭제 커밋 後 0행(org 없음)으로 실패해
    # 죽은 org에 claim이 서는 걸 원천에서 막는다. 이 claim이 먼저면 삭제 쪽 FOR UPDATE가
    # 대기하다 이 UPSERT 커밋 後에야 재조회하므로 "진행 中"을 놓치지 않는다.
    org_exists = await session.execute(
        text("SELECT 1 FROM organizations WHERE id = :org_id FOR UPDATE"), {"org_id": str(org_id)},
    )
    if org_exists.first() is None:
        raise CheckoutError(f"org_id={org_id} 조직을 찾을 수 없음")

    # ⭐#2511 — 원자적 claim(=② 구독을 'pending'으로 생성/전이를 겸한다). WHERE 가드가
    # 걸린 단일 UPSERT라 동시에 여러 tier/cycle이 도착해도 Postgres 행단위 write
    # 직렬화상 정확히 하나만 rowcount=1(claim 성공)이고 나머지는 0(거부) — Toss를 부르기
    # 前이라 issue_billing_key조차 낭비되지 않는다.
    claim_stmt = pg_insert(OrgSubscription).values(
        id=uuid.uuid4(), org_id=org_id, tier=tier, billing_cycle=billing_cycle, status="pending",
        provider="toss", currency="krw", offering_version_id=offering.id,
        current_period_start=period_start, current_period_end=period_end,
        checkout_claimed_at=now,
    ).on_conflict_do_update(
        index_elements=["org_id"],
        set_={
            "tier": tier, "billing_cycle": billing_cycle, "status": "pending",
            "provider": "toss", "currency": "krw", "offering_version_id": offering.id,
            "current_period_start": period_start, "current_period_end": period_end,
            "checkout_claimed_at": now,
        },
        where=or_(
            OrgSubscription.checkout_claimed_at.is_(None),
            OrgSubscription.checkout_claimed_at < now - STALE_CLAIM_WINDOW,
        ),
    )
    claim_result = await session.execute(claim_stmt)
    await session.commit()
    if claim_result.rowcount == 0:
        raise CheckoutInProgress(f"org_id={org_id}에 다른 checkout이 이미 진행 中 — 완료 후 재시도")

    try:
        # ① 빌링키 발급(C1 재사용) — 카드 인증 완료.
        await issue_billing_key(session, org_id=org_id, auth_key=auth_key)

        # ③ 즉시 1차 청구(#2500 계산 + C2 집행) — 전액·프로레이션 없음(PO 확定).
        amount_minor, currency = await compute_charge_amount(session, org_id=org_id)
        order_id = _checkout_order_id(org_id, offering.id, now)

        try:
            order = await charge_org(
                session, org_id=org_id, order_id=order_id, amount_minor=amount_minor,
                currency=currency, order_name=f"Sprintable {tier} 구독 시작",
            )
        except TossApiError as exc:
            # 카드 거절 등 비즈니스 사유 — 시스템 오류 아님. 구독은 pending인 채(재시도 가능).
            sub = await _refetch_subscription(session, org_id)
            raise CheckoutDeclined(str(exc), subscription=sub) from exc

        # ④ 청구 성공 時에만 active — 그 외(pending=경쟁 중·failed 도달 안 함, 위에서 잡힘)는
        # active로 안 올린다.
        #
        # 카디르 결함사냥(codex, #2896 리뷰, 2026-08-07) CRITICAL — 이 UPDATE가 org_id로만
        # 매칭하면 이 호출의 claim이 STALE_CLAIM_WINDOW를 넘겨 이미 다른 요청에게 뺏긴
        # 뒤(자기는 안 죽고 그냥 느렸을 뿐 — Toss charge 65초+issue 15초 정상 왕복만으로도
        # 합이 STALE_CLAIM_WINDOW에 근접·초과할 수 있다, 이론이 아니라 실 타임아웃 스펙)
        # 늦게 도착한 confirmed 결과가, 그 사이 새로 claim을 쥐고 아직 자기 charge를
        # confirm받지 못한(status='pending') 다른 요청의 tier 행을 소유권 재확認 없이
        # active로 밀어버릴 수 있었다 — release와 동일한 CAS(checkout_claimed_at==이
        # 호출이 claim한 그 값)를 걸어, 이미 뺏긴 뒤라면(rowcount==0) active로 안 올린다
        # (이 호출 자신의 charge_org 청구 자체는 이미 confirmed로 남아 있다 — 그 청구를
        # 취소하는 건 이 fix의 범위 밖, C4/화불 축).
        if order.status == "confirmed":
            await session.execute(
                update(OrgSubscription)
                .where(OrgSubscription.org_id == org_id, OrgSubscription.checkout_claimed_at == now)
                .values(status="active")
            )
            await session.commit()

        return await _refetch_subscription(session, org_id)
    finally:
        # #2511 — claim 해제. checkout_claimed_at이 여전히 "우리가 세팅한 그 값"일 때만
        # 지운다 — STALE_CLAIM_WINDOW를 넘겨 다른 요청이 이미 훔쳐간 claim을 우리가 뒤늦게
        # 돌아와 실수로 지워버리는 것(그 다른 요청의 상호배제가 깨짐)을 막는다.
        await session.execute(
            update(OrgSubscription)
            .where(OrgSubscription.org_id == org_id, OrgSubscription.checkout_claimed_at == now)
            .values(checkout_claimed_at=None)
        )
        await session.commit()


async def _refetch_subscription(session: AsyncSession, org_id: uuid.UUID) -> OrgSubscription:
    return (
        await session.execute(select(OrgSubscription).where(OrgSubscription.org_id == org_id))
    ).scalar_one()
