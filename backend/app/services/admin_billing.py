"""story #2777(E-ADMIN-REDESIGN·결제 운영) — 어드민 처리 액션(빌링 재시도·사용권 부여).

두 "부품은 있는데 조립 안 됨" 재료를 조립한다(그라운딩 2026-08-18):
- 재시도: `charge_org`(#2493, sweep_dunning_retries가 이미 쓰는 그 함수) 그대로 재사용
  — cron 케이던스(day+1/3/5) 게이트는 걸지 않는다(자동 스윕만의 비즈니스 리듬이지, 수동
  트리거의 안전조건이 아니다 — charge_org 자체가 idempotent/claim을 이미 지킨다). 유일한
  게이트는 "지금 이 order가 정말 failed인가"뿐.
- 사용권: `billing_ledger.record_ledger_entry(entry_type='credit_grant')`만으로는 아무것도
  안 풀린다(org_ledger_balances 소비처 0, 그라운딩 확認) — 실제 gating이 읽는 유일한 값은
  `org_subscriptions.tier`뿐이라, 원장기록 + tier 세팅 두 쓰기를 **같은 세션·같은 트랜잭션**
  으로 묶는다(`record_ledger_entry`가 내부에서 commit하므로, tier 갱신을 그보다 먼저
  flush만 해두면 그 commit이 둘 다 함께 확정한다 — 별도 트랜잭션 관리 불요).

PR2(sweep_expired_grants, 후속 별도 PR)가 되돌릴 재료를 여기서 심는다 — ledger entry의
entry_metadata에 kind/target_tier/prev_tier/grant_expires_at을 남긴다(신규 컬럼 0).

PO AC 리뷰 CHANGES(2026-08-18, head d488d2f) 반영:
① Idempotency-Key replay 시 provider_ref 기존 행을 **먼저** 조회 — 있으면 구독(tier/
   period) 무접촉으로 기존 entry 그대로 반환한다(이전 버전은 tier bump를 항상 먼저
   flush해 재전송마다 current_period_end가 뒤로 밀리는 결함이 있었다).
② audit 로그(pricing_version.py `_audit()`와 동형 JSON) 추가 — retry/grant 양쪽.
③ amount_minor는 어드민 자유입력이 아니라 `offering_versions`(checkout과 동일 가격
   원천)에서 서버가 파생 — monthly_price_minor × months. 원천 없는 tier/currency
   조합은 fail loud(422, 지어낸 수를 장부에 남기지 않는다)."""
from __future__ import annotations

import json
import logging
import uuid
from datetime import datetime, timezone
from typing import Literal

from sqlalchemy import func, select
from sqlalchemy import update as sa_update
from sqlalchemy.ext.asyncio import AsyncSession

from app.models.billing_ledger_entry import BillingLedgerEntry
from app.models.billing_order import BillingOrder
from app.models.grandfather_policy import GrandfatherPolicy
from app.models.offering_version import OfferingVersion
from app.models.org_subscription import OrgSubscription
from app.services.billing_charge import charge_org
from app.services.billing_ledger import record_ledger_entry
from app.services.billing_period import _add_months

audit_logger = logging.getLogger("sprintable.audit.admin_billing")

GrantTier = Literal["starter", "team", "business"]
# grant는 오직 유료 tier로만 — free/overage는 "부여" 대상이 아니다(overage=사용량과금,
# 구독 tier 서열 밖 — PO 판정 2026-08-18).
_TIER_RANK: dict[str, int] = {"free": 0, "starter": 1, "team": 2, "business": 3}


def _audit(*, actor_email: str, org_id: uuid.UUID | None, action: str, before: dict | None, after: dict) -> None:
    # story #2474: offering_version은 org-scope 밖(플랫폼 카탈로그)이라 org_id=None 허용.
    audit_logger.info(
        json.dumps(
            {
                "audit": "admin_billing",
                "actor_email": actor_email,
                "org_id": str(org_id) if org_id is not None else None,
                "action": action,
                "before": before,
                "after": after,
            },
            default=str, ensure_ascii=False,
        )
    )


class AdminBillingError(Exception):
    """라우터가 status_code로 매핑. code는 FE가 분기하는 안정 식별자(HTTP status만으론
    "왜"가 안 잡히므로 — retry의 409 ALREADY_HANDLED가 그 예)."""

    def __init__(self, status_code: int, code: str, message: str) -> None:
        self.status_code = status_code
        self.code = code
        self.message = message
        super().__init__(message)


async def retry_billing_order(
    session: AsyncSession, *, org_id: uuid.UUID, order_id: str, actor_email: str,
) -> BillingOrder:
    order = (
        await session.execute(
            select(BillingOrder).where(BillingOrder.order_id == order_id, BillingOrder.org_id == org_id)
        )
    ).scalar_one_or_none()
    if order is None:
        raise AdminBillingError(404, "ORDER_NOT_FOUND", f"order {order_id} not found for this org")
    if order.status != "failed":
        # PO 지적(부수 1건) — FE가 "실패"로 오인해 잘못된 복구 행동(예: 재재시도 반복)을
        # 유도하지 않도록 사람이 읽을 사유를 명시한다.
        raise AdminBillingError(
            409, "ALREADY_HANDLED",
            f"이미 처리됨 — 현재 상태: {order.status}(재시도 불필요)",
        )

    status_before = order.status
    await charge_org(
        session, org_id=org_id, order_id=order.order_id,
        amount_minor=order.amount_minor, currency=order.currency,
    )
    refreshed = (
        await session.execute(select(BillingOrder).where(BillingOrder.order_id == order_id))
    ).scalar_one()
    _audit(
        actor_email=actor_email, org_id=org_id, action="billing_retry",
        before={"order_id": order_id, "status": status_before},
        after={"order_id": order_id, "status": refreshed.status},
    )
    return refreshed


async def reset_billing_key(session: AsyncSession, *, org_id: uuid.UUID, actor_email: str) -> dict:
    """story #2989 AC3 — admin 개입용 결제수단 초기화(테스트/운영 개입, 예: 심사·테스트
    계정 재등록). `revoke_billing_key(force=True)`로 셀프서브와 동일한 단일 레일을 타되
    (Toss 실 폐기 먼저·DB는 그 다음 — 신규 규칙 발명 0), 활성 유료 구독 차단을 우회한다
    (이 경로 자체가 "정상 사용자 플로우 밖의 명시적 개입"이라는 뜻이므로 그 가드가
    여기선 장애물일 뿐 — retry_billing_order와 동형으로 이 라우터의 admin 인가
    (require_admin_operator)가 이미 그 신뢰를 감당)."""
    from app.services.org_billing_key import ActiveSubscriptionBlocksRevoke, revoke_billing_key

    try:
        result = await revoke_billing_key(session, org_id=org_id, actor_id=None, actor_type="agent", force=True)
    except ActiveSubscriptionBlocksRevoke:
        # force=True라 이 분기는 원리적으로 안 탄다 — 방어적 재-raise(향후 force 인자
        # 제거/리팩터가 이 불변식을 실수로 깨도 조용히 안 통과하게).
        raise AdminBillingError(409, "ACTIVE_SUBSCRIPTION_BLOCKS_REVOKE", "예상치 못한 차단(force=True인데 발생)")

    _audit(
        actor_email=actor_email, org_id=org_id, action="billing_key_reset",
        before={"had_billing_key": result.get("deleted", False)},
        after=result,
    )
    return result


async def _derive_grant_amount_minor(session: AsyncSession, *, target_tier: GrantTier, currency: str, months: int) -> int:
    """checkout과 동일 가격 원천(offering_versions)에서 파생 — 어드민 손입력 금지(PO
    지적③: 지어낸 수를 장부에 남기지 않는다). 원천 없으면 조용한 0/추정 대신 fail loud."""
    offering = (
        await session.execute(
            select(OfferingVersion).where(
                OfferingVersion.tier == target_tier,
                OfferingVersion.currency == currency,
                OfferingVersion.effective_to.is_(None),
            )
        )
    ).scalar_one_or_none()
    if offering is None:
        raise AdminBillingError(
            422, "PRICING_SOURCE_UNAVAILABLE",
            f"tier={target_tier}/currency={currency}의 유효 offering_version이 없어 금액을 파생할 수 없음",
        )
    return offering.monthly_price_minor * months


async def grant_credit(
    session: AsyncSession,
    *,
    org_id: uuid.UUID,
    target_tier: GrantTier,
    months: int,
    reason: str,
    currency: str,
    idempotency_key: str,
    actor_email: str,
    now: datetime | None = None,
) -> BillingLedgerEntry:
    now = now or datetime.now(timezone.utc)

    # PO 지적①(블로커) — replay 여부를 tier/period에 손대기 **전에** 먼저 판정한다.
    # 이전 버전은 구독 UPDATE를 항상 먼저 flush해, 같은 idempotency_key 재전송(타임아웃
    # 재시도 등)마다 current_period_end가 매번 now+months로 다시 밀렸다(응답의 entry
    # 메타 grant_expires_at과 실제 subscription 상태가 어긋나는 결함).
    #
    # PO 지적(2026-08-18, PR2 비블로커) — provider_ref는 전역 UNIQUE라 org 스코프가 없다.
    # 조회에 org_id 조건이 없으면 타 org가 우연히/의도적으로 같은 idempotency_key를 재사용할
    # 때 남의 org의 grant entry를 그대로 반환해버린다(IDOR류) — org_id 불일치는 409로 닫는다.
    #
    # PO 지적(2026-08-18, PR2 비블로커② — 1차 fix가 반쪽이었던 지점) — provider_ref
    # UNIQUE는 entry_type 무관 테이블 전체 스코프(0229 마이그)다. **조회**에 entry_type
    # 필터만 걸고 저장은 그대로 두면, 충돌 키가 들어왔을 때 조회는 이종 entry를 걸러
    # "replay 아님"으로 정상 경로에 진입시키지만 그다음 tier가 이미 commit된 뒤 **저장
    # INSERT**가 여전히 같은 UNIQUE를 위반해 ON CONFLICT DO NOTHING으로 조용히 무삽입되고,
    # `record_ledger_entry`의 충돌 폴백이 그 이종 entry를 재조회해 반환한다 — 장부 없는
    # tier 변경(entry 자체가 생성 안 됨) + 반환값이 credit_grant가 아니라 이후 이 값을
    # 읽는 어디선가 KeyError. 조회만 좁히는 건 반쪽 fix(필터 前보다 정합이 오히려 나쁨).
    #
    # 정공법 — provider_ref 자체를 이 grant 전용 네임스페이스로 저장한다(revert companion의
    # `grant-revert:<id>` 규율과 동일 패턴). 이러면 admin_grant_provider_ref가 다른 종류의
    # entry(웹훅 provider_ref 등 임의 문자열)와 우연히 겹칠 확률이 사실상 0으로 떨어져
    # 저장 INSERT 층의 충돌 자체가 원천 소멸한다 — entry_type 필터는 방어 depth로 유지.
    admin_grant_provider_ref = f"admin-grant:{idempotency_key}"
    existing = (
        await session.execute(
            select(BillingLedgerEntry).where(
                BillingLedgerEntry.provider_ref == admin_grant_provider_ref,
                BillingLedgerEntry.entry_type == "credit_grant",
            )
        )
    ).scalar_one_or_none()
    if existing is not None:
        if existing.org_id != org_id:
            raise AdminBillingError(
                409, "IDEMPOTENCY_KEY_ORG_MISMATCH",
                "이 Idempotency-Key는 다른 조직의 요청에 이미 쓰였음 — 새 키로 재시도할 것",
            )
        _audit(
            actor_email=actor_email, org_id=org_id, action="credit_grant_replay",
            before=None, after={"entry_id": str(existing.id), "idempotency_key": idempotency_key},
        )
        return existing

    sub = (
        await session.execute(select(OrgSubscription).where(OrgSubscription.org_id == org_id))
    ).scalar_one_or_none()
    current_tier = sub.tier if sub is not None else "free"
    if _TIER_RANK[target_tier] < _TIER_RANK.get(current_tier, 0):
        raise AdminBillingError(
            422, "GRANT_WOULD_DOWNGRADE",
            f"target_tier({target_tier})가 현재 tier({current_tier})보다 낮음 — grant는 강등을 하지 않는다",
        )

    amount_minor = await _derive_grant_amount_minor(session, target_tier=target_tier, currency=currency, months=months)

    period_end = _add_months(now, months)
    metadata = {
        "kind": "tier_grant",
        "target_tier": target_tier,
        "prev_tier": current_tier,
        "grant_expires_at": period_end.isoformat(),
        "months": months,
        "granted_by": actor_email,
        "reason": reason,
    }

    # tier bump — flush만(commit은 record_ledger_entry가 아래서 함께 확정, 모듈 docstring 참고).
    if sub is None:
        sub = OrgSubscription(
            id=uuid.uuid4(), org_id=org_id, tier=target_tier, status="active",
            currency=currency, current_period_start=now, current_period_end=period_end,
        )
        session.add(sub)
    else:
        sub.tier = target_tier
        sub.status = "active"
        sub.current_period_start = now
        sub.current_period_end = period_end
    await session.flush()

    entry = await record_ledger_entry(
        session, org_id=org_id, entry_type="credit_grant",
        amount_minor=amount_minor, currency=currency, direction="credit",
        provider_ref=admin_grant_provider_ref, metadata=metadata,
    )
    _audit(
        actor_email=actor_email, org_id=org_id, action="credit_grant",
        before={"tier": current_tier},
        after={"entry_id": str(entry.id), "tier": target_tier, "grant_expires_at": period_end.isoformat(), "amount_minor": amount_minor},
    )
    return entry


# ─────────────────────────────────────────────────────────────────────────
# story #2474 — offering_version/grandfather_policy 어드민 CRUD(그릇은 #2471 A1이 이미
# 착지, 여기선 편집 표면만 신설). 값 「수정」은 없다 — append-only 불변 행이므로 CREATE만
# 존재하고, 새 활성 버전 등록 시 기존 활성 행을 같은 트랜잭션에서 닫는다.
#
# ⚠️원자성 — 최초 설계(행잠금만으로 직렬화)를 realdb 동시성 테스트로 직접 반증했다:
# "기존 활성 행을 닫는 UPDATE가 락을 쥔다"는 그 스코프 키에 **이미 활성 행이 있을 때만**
# 성립한다. 그 tier+currency(또는 org_id)의 **첫 버전**을 두 요청이 동시에 만들면 닫을
# 행 자체가 없어 UPDATE가 둘 다 0건으로 즉시 통과하고, 뒤이은 INSERT 두 개가 동시에
# 충돌해 partial unique index가 `UniqueViolationError`(500)로 터진다(실측:
# test_concurrent_offering_version_create_serializes_via_row_lock_no_history_loss).
# `pg_advisory_xact_lock(hashtext(...))`로 스코프 키 자체를 세션 진입 시점부터 잠근다
# (billing_pack.py:111의 pack 구매 cap 잠금과 동일 패턴, [[feedback_check_then_insert_toctou]]
# 교훈 그대로 — "행이 있을 때만 잠기는" SELECT/UPDATE 기반 락은 TOCTOU에 무력하다).
# 트랜잭션 스코프 락이라 별도 해제 불요(커밋/롤백 시 자동 반납).
# ─────────────────────────────────────────────────────────────────────────

async def create_offering_version(
    session: AsyncSession, *, actor_email: str, now: datetime | None = None, **fields: object,
) -> OfferingVersion:
    now = now or datetime.now(timezone.utc)
    tier = fields["tier"]
    currency = fields["currency"]

    await session.execute(select(func.pg_advisory_xact_lock(func.hashtext(f"offering_version:{tier}:{currency}"))))

    prev_active = (
        await session.execute(
            select(OfferingVersion).where(
                OfferingVersion.tier == tier,
                OfferingVersion.currency == currency,
                OfferingVersion.effective_to.is_(None),
            )
        )
    ).scalar_one_or_none()
    prev_id = prev_active.id if prev_active is not None else None

    await session.execute(
        sa_update(OfferingVersion)
        .where(
            OfferingVersion.tier == tier,
            OfferingVersion.currency == currency,
            OfferingVersion.effective_to.is_(None),
        )
        .values(effective_to=now)
    )

    new_version = OfferingVersion(effective_from=now, effective_to=None, created_by=actor_email, **fields)
    session.add(new_version)
    await session.flush()
    await session.refresh(new_version)

    _audit(
        actor_email=actor_email, org_id=None, action="offering_version_create",
        before={"prev_active_id": str(prev_id) if prev_id else None, "tier": tier, "currency": currency},
        after={"id": str(new_version.id), "version_label": new_version.version_label},
    )
    return new_version


async def create_grandfather_policy(
    session: AsyncSession, *, actor_email: str, now: datetime | None = None, **fields: object,
) -> GrandfatherPolicy:
    now = now or datetime.now(timezone.utc)
    org_id = fields["org_id"]
    offering_version_id = fields["offering_version_id"]

    await session.execute(select(func.pg_advisory_xact_lock(func.hashtext(f"grandfather_policy:{org_id}"))))

    offering = (
        await session.execute(select(OfferingVersion).where(OfferingVersion.id == offering_version_id))
    ).scalar_one_or_none()
    if offering is None:
        raise AdminBillingError(
            404, "OFFERING_VERSION_NOT_FOUND",
            f"offering_version_id={offering_version_id} 미존재 — grandfather 정책은 실재 버전에만 묶는다",
        )

    prev_active = (
        await session.execute(
            select(GrandfatherPolicy).where(
                GrandfatherPolicy.org_id == org_id,
                GrandfatherPolicy.effective_to.is_(None),
            )
        )
    ).scalar_one_or_none()
    prev_id = prev_active.id if prev_active is not None else None

    await session.execute(
        sa_update(GrandfatherPolicy)
        .where(GrandfatherPolicy.org_id == org_id, GrandfatherPolicy.effective_to.is_(None))
        .values(effective_to=now)
    )

    new_policy = GrandfatherPolicy(effective_from=now, effective_to=None, created_by=actor_email, **fields)
    session.add(new_policy)
    await session.flush()
    await session.refresh(new_policy)

    _audit(
        actor_email=actor_email, org_id=org_id, action="grandfather_policy_create",
        before={"prev_active_id": str(prev_id) if prev_id else None},
        after={"id": str(new_policy.id), "offering_version_id": str(offering_version_id)},
    )
    return new_policy
