"""story #2881(결제 트랙 갭②) — 월납/연납 유료→유료 하향 예약 + 갱신일 적용 + 좌석 게이트.
doc `billing-policy-scenario-audit-20260821` 4·5번 갭: 자발 하향 write 경로가 0건이었고
(유일한 tier 하강=dunning 강제 전환), 좌석 vs 신규 티어 한도 체크도 전무했다.

**정책 확定(선생님, 2026-08-21, 페드루 릴레이)**:
①하향은 **즉시 전이 없음** — `pending_tier`/`pending_offering_version_id`/
  `pending_change_apply_at`(=current_period_end)만 기록(예약, 단일 슬롯 — 재예약은
  이전 예약을 덮어씀). 부분 환불 없음(v2.2 D10 그대로).
②갱신일 적용은 `sweep_pending_tier_downgrades`(billing_scheduler.py, toss-billing-
  maintenance cron에 편입)가 `pending_change_apply_at <= now()`인 행을 훑어 처리한다.
  ⛔이 크론의 «도는 자리»(Cloud Scheduler)가 아직 전 리전 0건(story #2896 대기) — 이
  스토리는 코드+sweep 실DB 테스트까지가 완료선이고, **라이브 집행은 #2896 착지 後**다
  (PR/AC에 명시 — 「만들어졌는데 도는 자리가 없다」 재발 방지).
③좌석 게이트: 적용 시점에 좌석수(count_human_seats) > 신규 offering.included_seats면
  **하향을 자동 취소**(pending_* 클리어)하고 org owner/admin에게 이메일 통지 —
  ⛔기존 멤버 강제 제거 없음, ⛔extra_seat 자동 유료전환도 없음(동의 없는 과금 금지,
  페드루 지시 — «신규 초대만 차단»과 동형 패턴이지만 이 스토리에서 신규 초대 차단
  자체를 구현하진 않는다, 좌석초과 자체가 «하향 무산» 사유일 뿐).
④예약 철회(재상향 아닌 단순 취소)는 별도 엔드포인트로 연다 — pending_*만 클리어,
  구독 자체는 원 tier 그대로 무변화.
"""
from __future__ import annotations

import logging
import uuid
from datetime import datetime, timezone

from sqlalchemy import select, update
from sqlalchemy.ext.asyncio import AsyncSession

from app.models.offering_version import OfferingVersion
from app.models.org_subscription import OrgSubscription
from app.models.project import OrgMember
from app.models.user import User
from app.services.billing_charge_amount import count_human_seats
from app.services.billing_period import compute_period_end
from app.services.email import send_email
from app.services.org_subscription_tier_change import PAID_TIERS, _TIER_RANK

logger = logging.getLogger(__name__)


class DowngradeError(Exception):
    """하향 예약/철회를 진행할 수 없는 상태(정책 위반·데이터 갭) — 명시 실패, 400 매핑 대상."""


async def _refetch_subscription(session: AsyncSession, org_id: uuid.UUID) -> OrgSubscription:
    return (
        await session.execute(select(OrgSubscription).where(OrgSubscription.org_id == org_id))
    ).scalar_one()


async def reserve_downgrade(session: AsyncSession, *, org_id: uuid.UUID, new_tier: str) -> OrgSubscription:
    """①③④ — 하향 예약(단일 슬롯, 재예약은 이전 예약을 덮어씀). 돈이 안 걸린 순수
    메타데이터 write라 checkout/change-tier류의 claim(checkout_claimed_at) 불요 —
    UPDATE 자체가 원자적이고, 같은 org의 동시 재예약은 마지막 커밋이 이긴다(그게
    "재예약=덮어씀" 정책과 정합, 레이스가 아니라 사양)."""
    if new_tier not in PAID_TIERS:
        raise DowngradeError(f"new_tier={new_tier!r}는 유료 티어만(starter/team/business) — free 전환은 구독 취소(story #2882)")

    sub = (
        await session.execute(select(OrgSubscription).where(OrgSubscription.org_id == org_id))
    ).scalar_one_or_none()
    if sub is None or sub.status != "active" or sub.tier not in PAID_TIERS:
        raise DowngradeError(f"org_id={org_id} 활성 유료 구독이 아님 — 하향 예약 대상 아님")
    if sub.current_period_end is None:
        raise DowngradeError(f"org_id={org_id} current_period_end 없음 — 적용일을 정할 수 없음")
    if _TIER_RANK.get(new_tier, 0) >= _TIER_RANK.get(sub.tier, 0):
        raise DowngradeError(
            f"{sub.tier!r}→{new_tier!r}는 하향이 아님(상향/동일) — 상향은 story #2880(change-tier)"
        )

    new_offering = (
        await session.execute(
            select(OfferingVersion).where(
                OfferingVersion.tier == new_tier,
                OfferingVersion.currency == sub.currency,
                OfferingVersion.effective_to.is_(None),
            )
        )
    ).scalar_one_or_none()
    if new_offering is None:
        raise DowngradeError(f"tier={new_tier!r}의 활성 offering_version({sub.currency!r})을 찾을 수 없음")

    await session.execute(
        update(OrgSubscription)
        .where(OrgSubscription.org_id == org_id)
        .values(
            pending_tier=new_tier, pending_offering_version_id=new_offering.id,
            pending_change_apply_at=sub.current_period_end,
        )
    )
    await session.commit()
    return await _refetch_subscription(session, org_id)


async def cancel_pending_downgrade(session: AsyncSession, *, org_id: uuid.UUID) -> OrgSubscription:
    """④ — 예약 철회. pending_*만 클리어, 구독 원 tier는 무변화."""
    sub = (
        await session.execute(select(OrgSubscription).where(OrgSubscription.org_id == org_id))
    ).scalar_one_or_none()
    if sub is None:
        raise DowngradeError(f"org_id={org_id} 구독 없음")
    if sub.pending_change_apply_at is None:
        raise DowngradeError(f"org_id={org_id} 철회할 예약된 하향이 없음")

    await session.execute(
        update(OrgSubscription)
        .where(OrgSubscription.org_id == org_id)
        .values(pending_tier=None, pending_offering_version_id=None, pending_change_apply_at=None)
    )
    await session.commit()
    return await _refetch_subscription(session, org_id)


async def _notify_downgrade_auto_cancelled(session: AsyncSession, *, org_id: uuid.UUID, tier: str, seat_count: int, included_seats: int) -> None:
    """③ — 좌석초과로 하향이 자동 취소됐음을 owner/admin에게 통지(storage-usage-warn과
    동형 best-effort 이메일 패턴, 재구현 0)."""
    emails = [
        r[0] for r in (
            await session.execute(
                select(User.email)
                .join(OrgMember, User.id == OrgMember.user_id)
                .where(OrgMember.org_id == org_id, OrgMember.role.in_(["owner", "admin"]), OrgMember.deleted_at.is_(None))
            )
        ).all()
    ]
    subject = f"[Sprintable] Plan downgrade to {tier} was cancelled — seat limit exceeded"
    html = (
        f"<p>Your scheduled downgrade to <b>{tier}</b> was automatically cancelled because your "
        f"organization has <b>{seat_count}</b> members, exceeding that plan's included seat limit "
        f"of <b>{included_seats}</b>.</p>"
        f"<p>No members were removed. Reduce your team size or keep your current plan, then "
        f"reschedule the downgrade if you still want it.</p>"
    )
    for em in emails:
        try:
            send_email(em, subject, html)
        except Exception:
            logger.warning("downgrade auto-cancel notify 실패 org=%s", org_id, exc_info=True)


async def sweep_pending_tier_downgrades(session: AsyncSession, *, now: datetime | None = None) -> dict:
    """② — 갱신일(pending_change_apply_at)이 도래한 하향 예약을 적용한다. ⛔story #2896
    (Cloud Scheduler 잡)이 착지하기 前엔 이 함수를 «부르는 자리» 자체가 없다 — 코드
    완결과 라이브 집행은 별개(PR 본문 명시)."""
    now = now or datetime.now(timezone.utc)
    pending = (
        await session.execute(
            select(OrgSubscription).where(
                OrgSubscription.pending_change_apply_at.is_not(None),
                OrgSubscription.pending_change_apply_at <= now,
            )
        )
    ).scalars().all()

    applied = cancelled_seat_overage = skipped = 0
    for sub in pending:
        if sub.pending_offering_version_id is None or sub.pending_tier is None:
            skipped += 1
            continue
        new_offering = await session.get(OfferingVersion, sub.pending_offering_version_id)
        if new_offering is None:
            skipped += 1
            continue

        seat_count = await count_human_seats(session, sub.org_id)
        if seat_count > new_offering.included_seats:
            await session.execute(
                update(OrgSubscription)
                .where(OrgSubscription.id == sub.id)
                .values(pending_tier=None, pending_offering_version_id=None, pending_change_apply_at=None)
            )
            await session.commit()
            await _notify_downgrade_auto_cancelled(
                session, org_id=sub.org_id, tier=sub.pending_tier,
                seat_count=seat_count, included_seats=new_offering.included_seats,
            )
            cancelled_seat_overage += 1
            continue

        new_period_end = compute_period_end(now, sub.billing_cycle or "monthly")
        await session.execute(
            update(OrgSubscription)
            .where(OrgSubscription.id == sub.id)
            .values(
                tier=sub.pending_tier, offering_version_id=sub.pending_offering_version_id,
                current_period_start=now, current_period_end=new_period_end,
                pending_tier=None, pending_offering_version_id=None, pending_change_apply_at=None,
            )
        )
        await session.commit()
        applied += 1

    return {"pending_seen": len(pending), "applied": applied, "cancelled_seat_overage": cancelled_seat_overage, "skipped": skipped}
