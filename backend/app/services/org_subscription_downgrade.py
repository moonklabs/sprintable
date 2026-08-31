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


async def _active_paid_sub_or_raise(session: AsyncSession, org_id: uuid.UUID) -> OrgSubscription:
    """reserve_downgrade·cancel_subscription 공통 전제 — 활성 유료 구독+적용일을 정할
    current_period_end가 있어야 한다(재구현 0)."""
    sub = (
        await session.execute(select(OrgSubscription).where(OrgSubscription.org_id == org_id))
    ).scalar_one_or_none()
    if sub is None or sub.status != "active" or sub.tier not in PAID_TIERS:
        raise DowngradeError(f"org_id={org_id} 활성 유료 구독이 아님 — 하향/취소 예약 대상 아님")
    if sub.current_period_end is None:
        raise DowngradeError(f"org_id={org_id} current_period_end 없음 — 적용일을 정할 수 없음")
    return sub


async def _offering_or_raise(session: AsyncSession, *, tier: str, currency: str) -> OfferingVersion:
    offering = (
        await session.execute(
            select(OfferingVersion).where(
                OfferingVersion.tier == tier,
                OfferingVersion.currency == currency,
                OfferingVersion.effective_to.is_(None),
            )
        )
    ).scalar_one_or_none()
    if offering is None:
        raise DowngradeError(f"tier={tier!r}의 활성 offering_version({currency!r})을 찾을 수 없음")
    return offering


async def _reserve_pending_change(session: AsyncSession, *, sub: OrgSubscription, new_tier: str, offering_id: uuid.UUID) -> OrgSubscription:
    await session.execute(
        update(OrgSubscription)
        .where(OrgSubscription.org_id == sub.org_id)
        .values(
            pending_tier=new_tier, pending_offering_version_id=offering_id,
            pending_change_apply_at=sub.current_period_end,
        )
    )
    await session.commit()
    return await _refetch_subscription(session, sub.org_id)


async def reserve_downgrade(session: AsyncSession, *, org_id: uuid.UUID, new_tier: str) -> OrgSubscription:
    """①③④ — 하향 예약(단일 슬롯, 재예약은 이전 예약을 덮어씀). 돈이 안 걸린 순수
    메타데이터 write라 checkout/change-tier류의 claim(checkout_claimed_at) 불요 —
    UPDATE 자체가 원자적이고, 같은 org의 동시 재예약은 마지막 커밋이 이긴다(그게
    "재예약=덮어씀" 정책과 정합, 레이스가 아니라 사양)."""
    if new_tier not in PAID_TIERS:
        raise DowngradeError(f"new_tier={new_tier!r}는 유료 티어만(starter/team/business) — free 전환은 구독 취소(story #2882)")

    sub = await _active_paid_sub_or_raise(session, org_id)
    if _TIER_RANK.get(new_tier, 0) >= _TIER_RANK.get(sub.tier, 0):
        raise DowngradeError(
            f"{sub.tier!r}→{new_tier!r}는 하향이 아님(상향/동일) — 상향은 story #2880(change-tier)"
        )

    new_offering = await _offering_or_raise(session, tier=new_tier, currency=sub.currency)
    return await _reserve_pending_change(session, sub=sub, new_tier=new_tier, offering_id=new_offering.id)


async def cancel_subscription(session: AsyncSession, *, org_id: uuid.UUID) -> OrgSubscription:
    """story #2882(구독 취소, 선생님 확定 2026-08-21) — v2.1 §12 「월간 구독 취소: 현재
    기간 말까지 사용, 다음 갱신 중지, 부분 환불 없음」. 메커니즘은 reserve_downgrade와
    동일(즉시 전이 없음·단일 슬롯 재예약·`sweep_pending_tier_downgrades`가 갱신일에
    적용)이라 «tier=free로의 하향»으로 취급 — 같은 pending_* 슬롯·같은 sweep 재사용
    (새 컬럼·새 스윕 발명 0).

    ⛔단, 좌석 게이트는 **타지 않는다**(페드루 확定 판정, #2881의 유료↔유료 하향과
    결정적으로 다른 지점) — 하향은 «선택»이라 조건 미충족 시 안 해줘도 되지만, 취소는
    «해지 의사»라 좌석 초과를 이유로 거부하면 사용자가 결제를 끊을 수 없는 상태가
    된다(해지 방해). `sweep_pending_tier_downgrades`가 `pending_tier == "free"`일 때
    이 스킵을 구현한다(이 함수 자체는 예약만 걸 뿐, 게이트 스킵은 sweep 쪽 책임).
    초과 좌석 기존 멤버는 제거하지 않고, free 전이 後 **신규 좌석 추가만** 기존
    `ee/plan_limits.check_member_invite_limit`(무수정 재사용)가 자연히 막는다 — 스토리
    #2906(storage 초과=신규 업로드만 차단)과 같은 판별.

    월납만(연납은 §12의 별도 환불식이 필요해 미착수 — story #2880/#2881과 동일 선례)."""
    sub = await _active_paid_sub_or_raise(session, org_id)
    free_offering = await _offering_or_raise(session, tier="free", currency=sub.currency)
    return await _reserve_pending_change(session, sub=sub, new_tier="free", offering_id=free_offering.id)


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
    # 유나양 design 반려(PR#3308, 2026-08-21) — 영문 메일이 제품의 기존 한국어 메일
    # (초대·#3316 dunning)과 보이스가 갈렸다. 로케일별 분기 정책은 아직 없음(PO 확認) —
    # 기존 메일 관례대로 한국어 단일. 문안은 design이 첨부한 원문 그대로(#3316 톤 매칭).
    subject = "[Sprintable] 예약된 하향 전환이 취소되었습니다 — 좌석 한도 초과"
    html = (
        f"<p>안녕하세요, Sprintable입니다.</p>"
        f"<p>예약하신 {tier} 플랜으로의 하향 전환이 자동으로 취소되었습니다. 현재 조직 "
        f"멤버가 {seat_count}명으로, 해당 플랜의 포함 좌석({included_seats}석)을 초과하기 "
        f"때문입니다.</p>"
        f"<p>기존 멤버는 제거되지 않았습니다. 팀 규모를 줄이거나 현재 플랜을 유지하신 뒤, "
        f"하향 전환이 여전히 필요하시면 다시 예약해 주세요.</p>"
        f"<p>문의사항이 있으시면 언제든 회신해 주세요.</p>"
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

        # story #2882(선생님 확定 2026-08-21) — 취소(pending_tier="free")는 좌석 게이트를
        # 타지 않는다. 하향은 «선택»이라 조건 미충족 시 거부해도 되지만, 취소는 «해지
        # 의사»라 좌석 초과를 이유로 거부하면 사용자가 결제를 끊을 수 없는 상태가 된다
        # (해지 방해 — 소비자 보호·심사 관점 둘 다 위험). free 전이는 무조건 실행하고,
        # 초과 멤버는 제거하지 않는다 — 이후 신규 좌석 추가만 기존
        # ee/plan_limits.check_member_invite_limit이 자연히 막는다(재구현 0).
        is_cancellation = sub.pending_tier == "free"
        seat_count = 0 if is_cancellation else await count_human_seats(session, sub.org_id)
        if not is_cancellation and seat_count > new_offering.included_seats:
            # 카디르 확定 버그(PR#3308 QA, 2026-08-21) — 아래 raw UPDATE(pending_tier=None)를
            # session.execute()가 실행하면 SQLAlchemy Core update()의 기본 "evaluate"
            # synchronize_session 전략이 PK로 매칭되는 이 in-session `sub` 객체를 자동으로
            # in-place 동기화한다(populate_existing 없이도) — 그 直後 `sub.pending_tier`를
            # 읽으면 이미 None이라, 알림 메일이 항상 "Plan downgrade to None was
            # cancelled..."로 발송됐다(오늘 PR#3312에서 배운 identity-map staleness의
            # 정반대 실패모드 — 거긴 sync 부재가 문제, 여긴 sync 존재가 문제). UPDATE
            # 前에 로컬 변수로 스냅샷해 그 값을 메일에 넘긴다.
            pending_tier_snapshot = sub.pending_tier
            await session.execute(
                update(OrgSubscription)
                .where(OrgSubscription.id == sub.id)
                .values(pending_tier=None, pending_offering_version_id=None, pending_change_apply_at=None)
            )
            await session.commit()
            await _notify_downgrade_auto_cancelled(
                session, org_id=sub.org_id, tier=pending_tier_snapshot,
                seat_count=seat_count, included_seats=new_offering.included_seats,
            )
            cancelled_seat_overage += 1
            continue

        if is_cancellation:
            # free는 Toss 결제 주기가 없다 — downgrade_to_free(dunning 강제전환)의 free
            # upsert 관례와 동형으로 billing_cycle/period를 비운다(재구현 0).
            update_values = {
                "tier": "free", "offering_version_id": sub.pending_offering_version_id,
                "billing_cycle": None, "current_period_start": None, "current_period_end": None,
                "pending_tier": None, "pending_offering_version_id": None, "pending_change_apply_at": None,
            }
        else:
            new_period_end = compute_period_end(now, sub.billing_cycle or "monthly")
            update_values = {
                "tier": sub.pending_tier, "offering_version_id": sub.pending_offering_version_id,
                "current_period_start": now, "current_period_end": new_period_end,
                "pending_tier": None, "pending_offering_version_id": None, "pending_change_apply_at": None,
            }
        await session.execute(
            update(OrgSubscription).where(OrgSubscription.id == sub.id).values(**update_values)
        )
        await session.commit()
        applied += 1

    return {"pending_seen": len(pending), "applied": applied, "cancelled_seat_overage": cancelled_seat_overage, "skipped": skipped}
