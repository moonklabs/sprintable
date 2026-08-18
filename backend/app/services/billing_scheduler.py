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
import uuid
from datetime import datetime, timedelta, timezone

from sqlalchemy import func, or_, select, text, update
from sqlalchemy.dialects.postgresql import insert as pg_insert
from sqlalchemy.ext.asyncio import AsyncSession

from app.models.billing_order import BillingOrder
from app.models.offering_version import OfferingVersion
from app.models.org_billing_key import OrgBillingKey
from app.models.org_subscription import OrgSubscription
from app.services.billing_charge import (
    _confirm_with_ledger,
    _mark_failed_if_not_confirmed,
    charge_org,
)
from app.services.org_subscription_checkout import STALE_CLAIM_WINDOW
from app.services.payment.toss_adapter import TossAdapter

logger = logging.getLogger(__name__)

# pricing-policy-proposal-v1 §12.1(2026-08-07 재확認) — 지어내지 않음, 문서 원문 그대로.
_DUNNING_RETRY_DAYS = frozenset({1, 3, 5})
_DUNNING_DOWNGRADE_DAY = 8

# Toss charge는 최대 60초(공식 문서) — 그보다 넉넉히 오래 pending이면 크래시/타임아웃으로
# 간주해 대사 대상.
PENDING_STALE_AFTER = timedelta(minutes=5)


def next_dunning_action(order: BillingOrder, *, now: datetime) -> str:
    """failed order 하나에 대해 지금 뭘 해야 하는지 — 순수 함수(DB/네트워크 접촉 없음).
    "wait" | "retry" | "downgrade_to_free" 중 하나.

    같은 날 중복 재시도 방지: `updated_at`이 오늘 이미 갱신됐으면(=오늘 이미 시도함) 또
    재시도하지 않는다 — cron이 하루에 여러 번 돌아도(예: */10분) 하루 1회만 재결제한다."""
    if order.status != "failed":
        return "wait"
    age_days = (now.date() - order.created_at.date()).days
    if age_days >= _DUNNING_DOWNGRADE_DAY:
        return "downgrade_to_free"
    already_attempted_today = order.updated_at.date() >= now.date()
    if age_days in _DUNNING_RETRY_DAYS and not already_attempted_today:
        return "retry"
    return "wait"


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
    """failed billing_orders를 스윕 — §12.1 케이던스대로 재시도하거나 Free로 전환."""
    now = now or datetime.now(timezone.utc)
    failed_orders = (
        await session.execute(select(BillingOrder).where(BillingOrder.status == "failed"))
    ).scalars().all()

    retried = downgraded = 0
    for order in failed_orders:
        action = next_dunning_action(order, now=now)
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
        elif action == "downgrade_to_free":
            await downgrade_to_free(session, order.org_id, order.order_id)
            downgraded += 1

    return {"failed_orders_seen": len(failed_orders), "retried": retried, "downgraded": downgraded}


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

    confirmed = failed = skipped = 0
    for order in stale_orders:
        try:
            lookup = await TossAdapter().get_payment_by_order_id(order_id=order.order_id)
        except Exception:
            # PO fix-forward(#2884 리뷰) — 조회 자체가 실패(네트워크 일시 장애 등)한 것과
            # "Toss가 이 주문을 모른다/실패로 안다"는 다른 신호다. 전자를 failed로 찍으면
            # 실은 성공했을 수도 있는 charge를 오분류한다 — pending 그대로 두고 다음
            # 스윕이 다시 조회하게 한다(무한 대기 아님 — lookup이 언젠가 성공하면 정리됨).
            logger.exception("stale pending reconciliation lookup failed for order_id=%s — leaving pending", order.order_id)
            skipped += 1
            continue

        if lookup.get("status") == "DONE" and lookup.get("paymentKey"):
            await _confirm_with_ledger(
                session, org_id=order.org_id, order_id=order.order_id,
                amount_minor=order.amount_minor, currency=order.currency,
                payment_key=lookup["paymentKey"],
            )
            confirmed += 1
        else:
            await _mark_failed_if_not_confirmed(
                session, order.order_id, f"stale pending — lookup status={lookup.get('status')}"
            )
            failed += 1

    return {
        "stale_pending_seen": len(stale_orders), "confirmed": confirmed,
        "failed": failed, "skipped_lookup_error": skipped,
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
    metadata.reverted_entry_id=원 grant id)을 append하고, 후보 조회 자체가 그 companion이
    이미 있는 grant를 SQL NOT EXISTS로 원천 제외한다. 그러면 ⓐ동일 tier 재부여도 정확히
    한 번만 되돌려짐(반복 재현 불가) ⓑ이미 되돌려진 grant는 재조회 후보에도 안 잡히므로
    `skipped_already_reverted`는 자연히 0으로 수렴(그 휴리스틱 분기 자체가 이제 불요 —
    반환 키는 하위호환으로 유지) ⓒcompanion 자체가 감사 기록이라 audit 이중화 불요.
    동일 tier 재부여 자체(정상 유스케이스)는 계속 허용 — 이 fix가 막는 건 "재부여"가 아니라
    "같은 grant를 여러 번 되돌리는" 회귀뿐이다."""
    from app.services.admin_billing import _audit  # 순환 임포트 회피(admin_billing이 이 모듈을 안 씀)
    from app.services.billing_ledger import record_ledger_entry

    now = now or datetime.now(timezone.utc)

    # entry_metadata는 BillingLedgerEntry의 Python 속성명일 뿐, DB 컬럼명은 "metadata"다
    # (모델 주석 — AC 원문대로·Base.metadata 예약명 충돌 회피). raw SQL은 실 컬럼명을 쓴다.
    # NOT EXISTS — 이미 revert companion(adjustment/tier_grant_revert)이 붙은 grant는
    # 후보 자체에서 제외(값-비교 대신 마커 존재로 "이미 처리됨" 판정, 위 docstring).
    latest_grants = (
        await session.execute(
            text(
                """
                SELECT DISTINCT ON (g.org_id) g.id, g.org_id, g.amount_minor, g.currency,
                       g.metadata AS entry_metadata
                FROM billing_ledger_entries g
                WHERE g.entry_type = 'credit_grant' AND g.metadata->>'kind' = 'tier_grant'
                  AND NOT EXISTS (
                    SELECT 1 FROM billing_ledger_entries r
                    WHERE r.entry_type = 'adjustment'
                      AND r.metadata->>'kind' = 'tier_grant_revert'
                      AND r.metadata->>'reverted_entry_id' = g.id::text
                  )
                ORDER BY g.org_id, g.ts DESC
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


async def trigger_due_charges(session: AsyncSession) -> dict:
    """오늘 신규 결제 주기가 도래한 org를 찾아 charge_org를 트리거하는 자리 — 이 스토리
    스코프 밖(PO 확認, 2026-08-07). `org_subscriptions.current_period_start/end`가 Toss
    구독에 세팅되는 경로 자체가 아직 없다(story #2502가 그 전제를 채운다). #2502 완료
    후 이 함수를 채운다."""
    raise NotImplementedError(
        "trigger_due_charges — blocked on story #2502(Toss 구독 주기 확定). "
        "org_subscriptions.current_period_start/end가 Toss 경로에 세팅되지 않아 "
        "\"누가 오늘 청구 대상인지\" 판단할 데이터 소스가 없다."
    )
