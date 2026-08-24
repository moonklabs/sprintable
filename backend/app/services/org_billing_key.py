"""결제②-C1(story #2492) — org_billing_keys 오케스트레이션: customerKey 발급 + Toss
create_billing_key 호출 + 암호화 저장. `app/services/billing_ledger.py`(A2, ON CONFLICT
DO NOTHING 멱등 기입)와 다르게 이 테이블은 org당 1행을 **갱신**한다(카드 교체 = 재발급)이라
ON CONFLICT DO UPDATE를 쓴다 — org_billing_keys는 append-only가 아니다.
"""
from __future__ import annotations

import logging
import uuid
from datetime import datetime, timezone

from sqlalchemy import func, select, update
from sqlalchemy.dialects.postgresql import insert as pg_insert
from sqlalchemy.ext.asyncio import AsyncSession

from app.models.org_billing_key import OrgBillingKey
from app.services.billing_key_crypto import decrypt_billing_key, encrypt_billing_key, ensure_configured
from app.services.payment.toss_adapter import TossAdapter

logger = logging.getLogger("sprintable.billing_key")


class ActiveSubscriptionBlocksRevoke(Exception):
    """story #2989 AC2(PO 확定 2026-08-24, block 정책) — 활성 유료 구독이 있는 채로 결제
    수단을 지우면 다음 청구가 "no active billing key"로 조용히 실패한다(billing_charge.py
    charge_org의 기존 active-필터 가드 재사용, 신규 분기 불요 — mark_billing_key_deleted
    docstring과 동형 근거). 차단이 기본값: 구독 해지가 먼저(org_subscription_checkout.py의
    change-tier/cancel 레일), 결제수단 삭제는 그 다음이라는 순서를 서버가 강제한다."""

    def __init__(self, *, org_id: uuid.UUID, tier: str, billing_cycle: str | None):
        self.org_id = org_id
        self.tier = tier
        self.billing_cycle = billing_cycle
        super().__init__(
            f"org_id={org_id}는 활성 유료 구독(tier={tier!r})이 있어 결제수단을 지울 수 "
            "없습니다 — 구독 해지/변경을 먼저 진행하세요."
        )


def generate_customer_key(org_id: uuid.UUID) -> str:
    """Toss 요구: 2~300자·특수문자(-_=.@) 최소 1개 포함·충분히 무작위. org_id를 그대로
    쓰지 않는다(순차 UUID라도 org_id는 여러 API 응답에 노출되는 값이라 「추측 불가능」 요건과
    별개 축 — 신규 랜덤 성분을 더한다)."""
    return f"org-{uuid.uuid4()}"


async def ensure_customer_key(session: AsyncSession, *, org_id: uuid.UUID) -> str:
    """#2512(결제②-D선행, 미르코 FE 연동 발견 2026-08-07) — Toss 위젯은 시작 前에
    customerKey가 필요한데, 기존 issue_billing_key()는 authKey를 받은 "뒤"에야 생성했다
    (FE가 위젯 열 순간엔 아직 authKey가 없다). 이 함수가 그 순서를 뒤집는 진입점 —
    기존 행(placeholder든 실 발급 완료든)이 있으면 그 customer_key를 그대로 반환(멱등),
    없으면 status='awaiting_auth' placeholder 행을 새로 만든다(encrypted_billing_key/
    issued_at은 NULL — 아직 위젯 인증 前). 이후 issue_billing_key()가 이 placeholder를
    찾아 실 빌링키로 덮어쓴다(기존 재사용 로직 그대로, 코드 변경 불요)."""
    existing = (
        await session.execute(select(OrgBillingKey.customer_key).where(OrgBillingKey.org_id == org_id))
    ).scalar_one_or_none()
    if existing is not None:
        return existing

    customer_key = generate_customer_key(org_id)
    stmt = pg_insert(OrgBillingKey).values(
        id=uuid.uuid4(), org_id=org_id, customer_key=customer_key, status="awaiting_auth",
    ).on_conflict_do_nothing(index_elements=["org_id"])
    result = await session.execute(stmt)
    await session.commit()

    if result.rowcount == 0:
        # 레이스 패배(동시에 다른 요청이 먼저 만듦) — 그 행의 customer_key를 그대로 쓴다.
        return (
            await session.execute(select(OrgBillingKey.customer_key).where(OrgBillingKey.org_id == org_id))
        ).scalar_one()

    return customer_key


async def issue_billing_key(
    session: AsyncSession, *, org_id: uuid.UUID, auth_key: str
) -> OrgBillingKey:
    """FE 위젯 인증 완료 후 authKey로 실 빌링키를 발급받아 저장한다.

    기존 행이 있으면(재발급 = 카드 교체) 그 customer_key를 재사용 — Toss 쪽 고객 식별을
    유지한다. 새 billingKey로 UPDATE — story #2989(PO 동승 권고, PR#3423 리뷰) 이전엔
    이전 빌링키의 Toss측 폐기가 C4 유예 항목이었으나, 이제 delete_billing_key가 생겨
    같은 함수 안에서 닫는다(신 키 저장 성공 → 구 키 Toss 폐기, 순서 고정 — 아래 참고).

    카디르 결함사냥 fix(#2892 리뷰, 2026-08-07) — 크로스-커넥션 레이스: 예전엔 이 함수가
    raw SELECT로 스스로 customer_key를 결정했다. ensure_customer_key()의 원자적 INSERT..
    ON CONFLICT 커밋 前에(#2512, 별도 커넥션에서 진행 중인 동시 요청) 이 SELECT가 끼어들면
    "아직 아무 행도 없다"고 잘못 판단해 새 랜덤 키로 Toss를 불러버렸다 — Toss엔 키 A로
    등록되는데 DB엔(ensure_customer_key가 나중에 커밋한) 키 B가 최종 저장돼 영구 불일치
    (실측: asyncio.gather 진짜 동시성). 이제 이 함수도 ensure_customer_key()를 거쳐 "모든
    호출자가 항상 같은 customer_key로 수렴"하게 한다 — 스스로 새 키를 발명하지 않는다."""
    # PO nit①(#2880 리뷰, 2026-08-07 — C2에서 함께 정리): 되돌릴 수 없는 authKey 소모(아래
    # create_billing_key) 前에 암호화 키 가용성부터 확認 — 순서를 바꾸면 authKey를 태우고도
    # encrypt 단계에서 502가 나는 낭비가 생긴다.
    ensure_configured()

    customer_key = await ensure_customer_key(session, org_id=org_id)

    # story #2989(PO 동승 권고, PR#3423 리뷰) — 재발급이 아래 ON CONFLICT DO UPDATE로 구
    # 행을 덮어쓰기 前에 구 encrypted_billing_key를 미리 읽어둔다(덮어쓴 뒤엔 사라짐).
    # placeholder(awaiting_auth, encrypted_billing_key=None)면 폐기할 실 키가 없어 자연히
    # None — revoke_billing_key의 placeholder-skip과 동형 판단.
    old_encrypted_billing_key = (
        await session.execute(
            select(OrgBillingKey.encrypted_billing_key).where(OrgBillingKey.org_id == org_id)
        )
    ).scalar_one_or_none()

    result = await TossAdapter().create_billing_key(auth_key=auth_key, customer_key=customer_key)

    # ⛔PO guard② — 평문은 이 스코프를 벗어나지 않는다: 암호화해 encrypted 변수로 즉시 대체.
    encrypted = encrypt_billing_key(result["billingKey"])

    card = result.get("card") or {}
    authenticated_at_raw = result.get("authenticatedAt")
    issued_at = (
        datetime.fromisoformat(authenticated_at_raw) if authenticated_at_raw else datetime.now(timezone.utc)
    )

    values = dict(
        org_id=org_id,
        customer_key=customer_key,
        encrypted_billing_key=encrypted,
        card_issuer_code=card.get("issuerCode"),
        card_acquirer_code=card.get("acquirerCode"),
        card_number_masked=card.get("number"),
        card_type=card.get("cardType"),
        card_owner_type=card.get("ownerType"),
        status="active",
        issued_at=issued_at,
    )
    stmt = pg_insert(OrgBillingKey).values(id=uuid.uuid4(), **values)
    stmt = stmt.on_conflict_do_update(
        index_elements=["org_id"],
        # 재발급(UPDATE 경로) — TimestampMixin의 onupdate=func.now()는 ORM UPDATE 문에만
        # 붙는 파이썬 레벨 훅이라 raw INSERT..ON CONFLICT DO UPDATE는 안 거친다(PO nit②,
        # #2880 리뷰). updated_at을 SET 절에 명시로 넣어 재발급 시에도 갱신되게 한다.
        set_={
            **{k: v for k, v in values.items() if k not in ("org_id", "customer_key")},
            "updated_at": func.now(),
        },
    )
    await session.execute(stmt)
    await session.commit()

    if old_encrypted_billing_key:
        # 신 키 저장은 이미 커밋됐다(PO 지시 순서: 성공 후 구 키 폐기, 폐기가 실패해도
        # 신 키 저장은 유지 — 롤백하지 않는다). Toss 실패는 org_id를 남겨 수동 정리가
        # 가능하게만 로깅한다.
        try:
            old_plaintext = decrypt_billing_key(old_encrypted_billing_key)
            await TossAdapter().delete_billing_key(billing_key=old_plaintext)
        except Exception:
            logger.warning(
                "재발급 후 구 빌링키 Toss 폐기 실패(org_id=%s) — 신 키 저장은 유지, 수동 정리 필요",
                org_id, exc_info=True,
            )

    return (
        await session.execute(select(OrgBillingKey).where(OrgBillingKey.org_id == org_id))
    ).scalar_one()


async def revoke_billing_key(
    session: AsyncSession, *, org_id: uuid.UUID, actor_id: uuid.UUID | None, actor_type: str,
    force: bool = False,
) -> dict:
    """story #2989(AC1·AC3) — 사용자 셀프서브 삭제 + admin 초기화가 공유하는 단일 레일
    (신규 규칙 발명 0, [[feedback_behavior_declared_one_place]] 동형 — 어디서 부르든
    같은 불변식). 순서 고정: ①활성 유료 구독 차단(force가 아니면) ②**Toss 실 폐기가
    먼저**(성공해야 DB를 건드림 — 반대 순서면 Toss엔 남고 DB만 지워진 유령 상태) ③DB
    행을 status='deleted'로 마킹(mark_billing_key_deleted와 동형 — customer_key는
    유지해 재등록 시 ensure_customer_key()가 그대로 재사용, 신규 customer_key 발급 불요)
    ④ActivityLog에 감사 기록(actor·masked card·revoke 시각 — admin 초기화의 AC3 요건이나
    셀프서브도 동일하게 남겨 감사 표면 일관).

    `force=True`(admin 전용 경로가 넘김) — 활성 구독 차단을 우회한다(테스트/운영 개입,
    story #2989 AC3 "admin 개입용 초기화"가 명시한 그 예외 — 셀프서브 라우터는 이 인자를
    노출하지 않는다).

    반환: 삭제 여부(deleted)·이미 카드가 없던 경우(no-op)·마스킹 카드 정보 — 호출자
    (라우터·admin 스크립트)가 "무엇을 지웠는지"를 사람이 읽을 형태로 보고할 수 있게."""
    from app.models.org_subscription import OrgSubscription
    from app.services.org_subscription_checkout import PAID_TIERS

    key = (
        await session.execute(select(OrgBillingKey).where(OrgBillingKey.org_id == org_id))
    ).scalar_one_or_none()
    if key is None or key.status == "deleted":
        return {"deleted": False, "reason": "no_active_billing_key"}

    if not force:
        sub = (
            await session.execute(select(OrgSubscription).where(OrgSubscription.org_id == org_id))
        ).scalar_one_or_none()
        if sub is not None and sub.status == "active" and sub.tier in PAID_TIERS:
            raise ActiveSubscriptionBlocksRevoke(org_id=org_id, tier=sub.tier, billing_cycle=sub.billing_cycle)

    masked_card = key.card_number_masked
    toss_revoked = False
    if key.encrypted_billing_key:
        plaintext = decrypt_billing_key(key.encrypted_billing_key)
        # ⛔平문은 이 스코프를 벗어나지 않는다(issue_billing_key의 동형 guard 재사용) —
        # Toss 호출 인자로만 쓰고 로깅·반환값에 절대 안 실음.
        await TossAdapter().delete_billing_key(billing_key=plaintext)
        toss_revoked = True
    # placeholder(status='awaiting_auth', encrypted_billing_key=None)는 Toss에 애초에
    # 발급된 적이 없어 폐기할 대상이 없다 — DB 정리만으로 충분(no-fiction: 안 한 걸 했다고
    # 안 함).

    key.status = "deleted"
    key.encrypted_billing_key = None
    key.card_issuer_code = None
    key.card_acquirer_code = None
    key.card_number_masked = None
    key.card_type = None
    key.card_owner_type = None

    from app.services.activity_log import ActivityLogService

    await ActivityLogService(session).record(
        org_id=org_id,
        action="billing_key_revoked",
        actor_id=actor_id,
        actor_type=actor_type,
        entity_type="org_billing_key",
        entity_id=key.id,
        context={
            "toss_revoked": toss_revoked,
            "card_number_masked": masked_card,
            "force": force,
        },
    )
    await session.commit()

    return {"deleted": True, "toss_revoked": toss_revoked, "card_number_masked": masked_card}


async def mark_billing_key_deleted(session: AsyncSession, *, customer_key: str) -> None:
    """결제②-C4(story #2495) — Toss BILLING_DELETED 웹훅 수신 시 호출. 멱등 UPDATE(몇 번
    재생돼도 최종 상태는 동일 — PO 확認 2026-08-07, 웹훅 서명이 상시 보장 안 되는 축이라
    별도 dedup 테이블 없이 이 자체-멱등성이 안전망). 이후 billing_charge.charge_org가
    이 org의 활성 빌링키를 조회할 때(status='active' 필터) 걸리지 않아 "no active billing
    key" 로 명시 실패한다(기존 가드 재사용, 신규 분기 불요)."""
    await session.execute(
        update(OrgBillingKey)
        .where(OrgBillingKey.customer_key == customer_key)
        .values(status="deleted", updated_at=func.now())
    )
    await session.commit()
