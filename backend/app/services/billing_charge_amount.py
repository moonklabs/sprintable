"""결제②(story #2500) — 청구액 계산 엔진. offering_version(불변 가격표) × «사람 좌석» ×
명시적으로 산 팩 → org의 이번 결제 주기 청구액. C3(#2494) trigger_due_charges가 이 값을
얻어 C2(#2493) charge_org에 amount로 넘길 소스가 된다(C2/C3와 마찬가지로 "메커니즘만" —
"누가 오늘 청구대상인지" 판정은 여기 책임이 아니다, #2502).

⛔순수 read-only 계산 — Toss를 호출하지도 원장에 기입하지도 않는다.

좌석 = «사람(human) 멤버»만(org_members, PO 확認 2026-08-07·pricing-policy-v2-3) —
등록 에이전트는 별개 축(feature-gate)이라 좌석 계산에 넣지 않는다.

팩분은 billing_ledger_entries(entry_type='pack_purchase') 기간집계로 읽는다 — "팩 구매
트리거"(관리자 명시 확認 후 원장 기입) 자체는 아직 코드 어디에도 없어(그라운딩 grep 0건,
story #2505로 별도 추적) 지금은 항상 0을 반환한다. current_period_start/end가 없는 org
(Toss 신규 유료 전환 진입점이 아직 없다 — #2502)는 팩분을 0으로 취급(기간을 특정할 수
없으니 집계 자체를 건너뛴다)."""
from __future__ import annotations

import math
import uuid
from datetime import datetime

from sqlalchemy import func, select
from sqlalchemy.ext.asyncio import AsyncSession

from app.models.billing_ledger_entry import BillingLedgerEntry
from app.models.offering_version import OfferingVersion
from app.models.org_subscription import OrgSubscription
from app.models.project import OrgMember
from app.services.platform_settings import get_platform_settings


class ChargeAmountError(Exception):
    """청구액을 계산할 수 없는 상태(구독/카탈로그 불변식 위반) — 잘못된 금액으로 조용히
    진행하는 대신 명시적으로 실패한다."""


def apply_vat_minor(amount_minor: int, vat_rate_bp: int) -> int:
    """story #3097(선생님 결정 2026-08-26) — 공급가(minor unit)에 VAT를 가산한 최종
    청구액. `vat_rate_bp`는 platform_settings.vat_rate_bp(basis points, 1bp=0.01%) —
    호출부가 하드코딩하지 않고 매번 이 파라미터로 받는다.

    ⚠️FE `withVatKrw`(apps/web/src/ee/components/billing/pricing-data.ts,
    `Math.round(krw * (1 + VAT_RATE))`)와 **지금은 결과가 같지만 두 사본**이다 —
    근본(율 단일 출처화)은 아직 안 닫혔다(페드루 PO 리뷰, PR#3506, 2026-08-26 —
    후속 story #3104 「VAT율 단일 출처화 — FE가 BE platform_settings.vat_rate_bp를
    소비하도록」에 등재). 구체적으로 갈리는 축 3개:
      ①**출처** — FE `VAT_RATE=0.1`은 하드코딩 상수, BE는 이 함수의 `vat_rate_bp`
        인자(어드민이 platform_settings에서 바꿀 수 있음) — 어드민이 vat_rate_bp를
        1000(10%) 밖으로 바꾸는 순간 FE 표시와 BE 실 청구가 갈라진다.
      ②**가산 순서** — 구독 청구(`_compute_amount_for_offering`)는 여기처럼 합산
        後 가산(FE와 동형)이지만, **팩 구매**(billing_pack.py::purchase_packs)는
        개당 가산 後 quantity를 곱한다(그래야 `_packs_reserved_this_period`의
        총액÷개당가 역산이 나눠떨어진다 — purchase_packs 주석 참고) — FE
        `PackPurchaseDialog`는 `withVatKrw(pack.priceKrwPerPack * quantity)`로
        합산 後 가산이라 이 둘도 산식 자체가 다르다(현재 가격대에선 우연히 결과가
        같음 — 카탈로그가 1,000원 단위라 나눗셈 잔차가 안 생기는 것뿐).
      ③**반올림 규칙** — Python `round()`는 5 근처에서 은행가 반올림(round-half-
        to-even), JS `Math.round()`는 항상 올림(round-half-up) — 정확히 .5로
        떨어지는 금액이면 이 둘이 다른 정수로 갈 수 있다(현재 카탈로그 가격들은
        이 경계에 안 걸림, 실측 확認 — test_3097_vat_fe_be_cross_pin.py 참고).
    이 함수/파일을 고칠 때는 위 세 축이 여전히 우연 일치인지, 근본(단일 출처화)이
    닫혔는지부터 확認할 것 — 안 닫혔으면 test_3097_vat_fe_be_cross_pin.py가 먼저
    빨개지는 걸 신뢰(가격/율/산식 변경의 조기경보 tripwire)."""
    return round(amount_minor * (10_000 + vat_rate_bp) / 10_000)


async def count_human_seats(session: AsyncSession, org_id: uuid.UUID) -> int:
    """이 org의 현재 실 «사람» 좌석 수. org_subscriptions에는 이 값을 담는 컬럼이 없다
    (그라운딩 확認) — org_members에서 매번 파생한다(get_impact/check_member_invite_limit과
    동일 쿼리 — SSOT 재사용, 새 카운팅 개념 발명 아님)."""
    return (
        await session.execute(
            select(func.count()).select_from(OrgMember).where(
                OrgMember.org_id == org_id,
                OrgMember.deleted_at.is_(None),
            )
        )
    ).scalar_one()


async def compute_pack_charge_minor(
    session: AsyncSession,
    *,
    org_id: uuid.UUID,
    subscription_id: uuid.UUID,
    period_start,
    period_end,
) -> int:
    """이번 결제 주기 동안 명시적으로 구매된 팩의 합계(minor unit). 주기 경계가 없으면
    (current_period_start/end 미세팅 — #2502 갭) 집계 범위를 특정할 수 없으니 0."""
    if period_start is None or period_end is None:
        return 0
    # story #2892(P0, 실사고 2026-08-21) — Postgres SUM(bigint)은 SQL 표준상 numeric을
    # 반환한다(컬럼 자체는 BigInteger인데도) — asyncpg가 그걸 Python Decimal로 디코드해,
    # 이 값이 그대로 charge_org→TossAdapter.charge()의 JSON 바디까지 흘러 들어가 httpx의
    # json.dumps가 "Object of type Decimal is not JSON serializable"로 500을 냈다(Toss
    # API 호출 前 — 네트워크 왕복 자체가 안 나간 순수 인코딩 실패). 경계(DB→Python)를
    # 넘는 즉시 명시 int 변환 — 이 함수의 반환 타입 힌트(-> int)가 실제로 참이 되게 한다.
    result = (
        await session.execute(
            select(func.coalesce(func.sum(BillingLedgerEntry.amount_minor), 0)).where(
                BillingLedgerEntry.org_id == org_id,
                BillingLedgerEntry.subscription_id == subscription_id,
                BillingLedgerEntry.entry_type == "pack_purchase",
                BillingLedgerEntry.ts >= period_start,
                BillingLedgerEntry.ts < period_end,
            )
        )
    ).scalar_one()
    return int(result)


async def _compute_amount_for_offering(
    session: AsyncSession, *, org_id: uuid.UUID, sub: OrgSubscription, offering: OfferingVersion,
) -> tuple[int, str]:
    """기저가(월/연) + 좌석초과분 + 팩분 — `offering`을 명시로 받는다(story #2880: 티어
    전환 시점엔 `sub`가 아직 구 tier라 sub.offering_version_id 그대로는 신 tier 금액을
    못 낸다 — `compute_charge_amount`/`compute_full_charge_for_new_offering` 둘 다
    이 헬퍼로 수렴, 로직 재구현 0)."""
    # 카디르 결함사냥(#2509, 2026-08-07) — org_subscriptions.billing_cycle에 DB CHECK가
    # 없어(Text nullable) NULL·'Annual'·'yearly'·오타가 조용히 monthly로 폴백해 annual
    # 구독을 10배 저청구할 수 있었다. "annual 아니면 monthly=안전한 기본값"이라는 판단
    # 자체가 틀렸다 — 불명확한 값은 명시 실패로.
    if sub.billing_cycle not in ("monthly", "annual"):
        raise ChargeAmountError(
            f"org_subscription(org_id={org_id}).billing_cycle={sub.billing_cycle!r}이 "
            "'monthly'/'annual' 둘 다 아님 — monthly로 조용히 폴백하지 않는다"
        )
    base_amount = (
        offering.annual_price_minor if sub.billing_cycle == "annual" else offering.monthly_price_minor
    )

    seat_count = await count_human_seats(session, org_id)
    seat_overage = max(0, seat_count - offering.included_seats)
    if seat_overage > 0:
        if offering.extra_seat_price_minor is None:
            raise ChargeAmountError(
                f"org_id={org_id} tier={offering.tier!r}가 included_seats를 {seat_overage}석 "
                "초과했으나 이 offering은 추가좌석을 팔지 않음(정책상 상위 티어 전환 후에만 "
                "가능한 상태 — 초과 상태로 청구를 계산하면 안 됨)"
            )
        seat_amount = seat_overage * offering.extra_seat_price_minor
    else:
        seat_amount = 0

    pack_amount = await compute_pack_charge_minor(
        session,
        org_id=org_id,
        subscription_id=sub.id,
        period_start=sub.current_period_start,
        period_end=sub.current_period_end,
    )

    # 카디르 결함사냥(#2509) — offering.currency와 sub.currency 사이엔 FK만 있고 값 일치
    # 제약이 없다(구조적 갭). 반환 직전 대조해 불일치를 명시 실패로 잡는다(예: USD
    # offering이 KRW sub에 잘못 바인딩된 상태로 조용히 금액만 나가는 것 방지).
    if offering.currency != sub.currency:
        raise ChargeAmountError(
            f"offering_version.currency={offering.currency!r} != "
            f"org_subscription.currency={sub.currency!r} for org_id={org_id}"
        )

    # story #3097(선생님 결정 2026-08-26) — VAT는 base+seat(공급가)에만 가산한다.
    # pack_amount는 compute_pack_charge_minor가 billing_ledger_entries(entry_type=
    # 'pack_purchase')에서 합산한 값 — 그 원장은 purchase_packs()가 기입 시점에 이미
    # VAT를 가산해 기록한다(billing_pack.py 참고). 여기서 pack_amount까지 다시 VAT를
    # 매기면 이중가산이 된다 — 그래서 base+seat 합만 가산하고 pack_amount는 그대로
    # 더한다(현재 subscription_id 미기입 갭으로 pack_amount는 항상 0 — compute_pack_
    # charge_minor 독스트링 참고 — 이 분기는 그 갭이 닫힐 미래를 위한 정확성 보장).
    settings = await get_platform_settings(session)
    taxed_base_and_seat = apply_vat_minor(base_amount + seat_amount, settings.vat_rate_bp)

    return taxed_base_and_seat + pack_amount, offering.currency


async def _load_sub(session: AsyncSession, org_id: uuid.UUID) -> OrgSubscription:
    sub = (
        await session.execute(select(OrgSubscription).where(OrgSubscription.org_id == org_id))
    ).scalar_one_or_none()
    if sub is None:
        raise ChargeAmountError(f"no org_subscription row for org_id={org_id}")
    return sub


async def compute_charge_amount(session: AsyncSession, *, org_id: uuid.UUID) -> tuple[int, str]:
    """(amount_minor, currency) 반환. 기저가(월/연) + 좌석초과분 + 팩분 — sub의 현재
    offering_version_id 기준."""
    sub = await _load_sub(session, org_id)
    if sub.offering_version_id is None:
        raise ChargeAmountError(
            f"org_subscription(org_id={org_id})에 offering_version_id가 바인딩되지 않음"
        )
    offering = await session.get(OfferingVersion, sub.offering_version_id)
    if offering is None:
        raise ChargeAmountError(f"offering_version {sub.offering_version_id}를 찾을 수 없음")
    return await _compute_amount_for_offering(session, org_id=org_id, sub=sub, offering=offering)


async def compute_full_charge_for_new_offering(
    session: AsyncSession, *, org_id: uuid.UUID, new_offering: OfferingVersion,
) -> tuple[int, str]:
    """story #2880 — 유료→유료 상향 시 «신 offering 전액»(좌석초과+팩 포함, 선생님 확定
    2026-08-21: 일할 차감 없이 신 tier 전액을 즉시 청구한다 — 구 tier 잔여분은 charge
    쪽이 아니라 별도 부분취소(refund) 경로가 정산한다, org_subscription_tier_change.py
    참고). sub는 여전히 구 tier인 시점에 호출된다는 전제(호출부가 confirmed 확認 前에
    부른다)."""
    sub = await _load_sub(session, org_id)
    return await _compute_amount_for_offering(session, org_id=org_id, sub=sub, offering=new_offering)


def prorate_minor(
    price_minor: int, *, now: datetime, period_start: datetime, period_end: datetime,
) -> int:
    """story #2880 — `price_minor`의 잔여기간 비례 몫(minor unit), 순수 함수(DB 접근
    없음). (period_end − now) / (period_end − period_start) 비율을 곱한다 — 초 단위
    정밀도(타임스탬프가 이미 초 단위 저장이므로 일 단위로 먼저 절삭하지 않는다).

    ⛔라운딩 방향은 **floor**로 확定(페드루 지시 ⓒ, 2026-08-21 — 돈은 방향이 계약이라
    round()의 기본 반올림에 맡기지 않는다, 항상 사용자 유리).

    선생님 재확定(2026-08-21) 후 이 함수는 «청구액»이 아니라 **구 tier 잔여분 부분취소
    (refund) 금액**을 잰다 — 상향 자체의 청구는 신 offering 전액(`compute_full_charge_
    for_new_offering`)이고, 이 값은 그 직전 confirmed 결제 건에 Toss cancelAmount로
    넘긴다(org_subscription_tier_change.py 참고)."""
    total_seconds = (period_end - period_start).total_seconds()
    remaining_seconds = (period_end - now).total_seconds()
    if total_seconds <= 0 or remaining_seconds <= 0:
        raise ChargeAmountError(
            f"잔여기간 계산 불가(total_seconds={total_seconds}, remaining_seconds={remaining_seconds})"
        )
    remaining_seconds = min(remaining_seconds, total_seconds)
    return math.floor(price_minor * remaining_seconds / total_seconds)
