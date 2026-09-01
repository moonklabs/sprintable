import uuid
from datetime import datetime

from sqlalchemy import DateTime, ForeignKey, Text, func
from sqlalchemy.dialects.postgresql import UUID
from sqlalchemy.orm import Mapped, mapped_column

from app.core.database import Base


class OrgSubscription(Base):
    """OSS(sprintable backend)의 **유일한** 구독 정본 모델(story #2476, 2026-09-01 재그라운딩).

    ⛔ legacy `subscriptions`·`subscription_checkout_sessions` 테이블은 여기서 안 쓴다 — OSS
    레포 전수 grep 확認 참조 0건. 그렇다고 死 테이블은 아니다: `docs/pk-triage-orm-unmodeled.md`
    (story a74bdc84)가 이미 그 둘을 «(보류) SaaS-only 라이브»로 분류해 뒀다(별도 SaaS 제품이
    같은 물리 DB를 Supabase로 직접 침 — subscriptions 206 refs·subscription_checkout_sessions
    35 refs). 그래서 DROP은 금지(SaaS prod 데이터 파괴 위험) — 대신 마이그 0298이 `COMMENT ON
    TABLE`로 그 두 테이블에 같은 사실을 DB 메타데이터 레벨에도 못박아 뒀다. 새 코드가 이
    ORM 모델 대신 그 legacy 테이블을 다시 참조하려 하면 그게 회귀다(스코프 밖 SaaS 얘기가
    아닌 한).
    """

    __tablename__ = "org_subscriptions"

    id: Mapped[uuid.UUID] = mapped_column(UUID(as_uuid=True), primary_key=True, default=uuid.uuid4)
    org_id: Mapped[uuid.UUID] = mapped_column(
        UUID(as_uuid=True), nullable=False, unique=True
    )
    # #2471(A1): provider-agnostic화 — Toss(원화) 구독은 Polar customer가 없다(v2.1 §13.1
    # "버린다" 판정). NOT NULL이던 시절엔 Free/Toss 조직이 빈 문자열을 넣어야 했다.
    polar_customer_id: Mapped[str | None] = mapped_column(Text, nullable=True)
    polar_subscription_id: Mapped[str | None] = mapped_column(Text, nullable=True)
    tier: Mapped[str] = mapped_column(Text, nullable=False, default="free")
    billing_cycle: Mapped[str | None] = mapped_column(Text, nullable=True)
    status: Mapped[str] = mapped_column(Text, nullable=False, default="active")
    # #2471(A1): provider = 통화의 함수(원화→toss·달러→polar, per-org, 03:41Z 確定). 두
    # 컬럼 다 nullable — 기존 행·아직 어댑터가 안 채우는 행은 NULL. CHECK(provider_currency_fn)
    # 로 "provider는 currency로부터만 파생된다" 불변식을 DB가 직접 강제한다. 실제 값 기입은
    # B단계(PolarAdapter/TossAdapter)에서 — 이 스토리는 그릇만 만든다.
    currency: Mapped[str | None] = mapped_column(Text, nullable=True)
    provider: Mapped[str | None] = mapped_column(Text, nullable=True)
    current_period_start: Mapped[datetime | None] = mapped_column(DateTime(timezone=True), nullable=True)
    current_period_end: Mapped[datetime | None] = mapped_column(DateTime(timezone=True), nullable=True)
    # S8 Phase 2: 80% storage 경고 메일 dedup 마커(마지막 발송 시각·NULL=미발송).
    storage_warn_notified_at: Mapped[datetime | None] = mapped_column(DateTime(timezone=True), nullable=True)
    # #2511: 진행 중 checkout의 서버 정본 claim 마커(org_subscription_checkout.py 참고).
    # NULL=진행 중 아님·값 있음=그 시각에 어떤 checkout이 이 org를 claim했다는 뜻(원자적
    # UPSERT WHERE 가드로 동시 다른 tier/cycle 재제출의 이중청구를 막는다).
    checkout_claimed_at: Mapped[datetime | None] = mapped_column(DateTime(timezone=True), nullable=True)
    # E-ADMIN B1: grandfather — 가입(플랜변경)시점 pricing_version 참조. free tier·백필 전
    # 기존 구독은 NULL(0146은 구조만, 값 백필은 가격 확정 후 별도 마이그).
    # ⛔VESTIGE(story #2731/82593fb0, 2026-08-18) — offering_version_id(아래)가 이 컬럼을
    # 완전히 대체했다. 이 컬럼을 채우거나 읽는 코드는 전수 grep 0건(app/models/
    # pricing_version.py의 DEPRECATED 표기 참고) — DROP은 story #70bc4bc3(prod 스키마
    # 불일치 판별)에 종속돼 미루되, 신규 코드는 이 컬럼을 쓰지 말 것.
    pricing_version_id: Mapped[uuid.UUID | None] = mapped_column(
        UUID(as_uuid=True), ForeignKey("pricing_versions.id"), nullable=True
    )
    # #2471(A1): 이 구독이 지금 실제로 묶인 offering_version(가격·좌석·한도·팩 원자 스냅샷).
    # pricing_version_id와 동일 grandfather 패턴 — nullable(기존 행·아직 어댑터 미기입 행은
    # NULL). "언제 자동 이전할지" 같은 정책 규칙은 grandfather_policies가 별도로 진다.
    offering_version_id: Mapped[uuid.UUID | None] = mapped_column(
        UUID(as_uuid=True), ForeignKey("offering_versions.id"), nullable=True
    )
    # story #2881(0268) — 하향 예약(단일 슬롯, 큐 아님 — 재예약은 이전 예약을 덮어씀).
    # pending_change_apply_at=NULL이 "예약 없음"(가장 흔한 상태). sweep(billing_scheduler.
    # sweep_pending_tier_downgrades)이 apply_at<=now()인 행만 적용한다 — 즉시 전이 없음
    # (v2.2 D10, 부분 환불 없음).
    pending_tier: Mapped[str | None] = mapped_column(Text, nullable=True)
    pending_offering_version_id: Mapped[uuid.UUID | None] = mapped_column(
        UUID(as_uuid=True), ForeignKey("offering_versions.id"), nullable=True
    )
    pending_change_apply_at: Mapped[datetime | None] = mapped_column(DateTime(timezone=True), nullable=True)
    # story #3176(결제②-C, doc au-limit-enforcement-grounding-3176 §1.3) — AU는 storage_
    # warn_notified_at과 달리 2단계 경고(80%/90%)+유예(110%/7일)라 크론(`au-usage-warn`)이
    # 계산할 상태가 더 필요하다. paused 여부는 요청마다 재계산하지 않고 크론이 캐시에
    # 박아두는 값만 읽는다(au_metering.py::check_au_not_paused) — au_eval_at은 크론이 매
    # 실행마다 무조건 갱신하는 last-evaluated 마커로, 이게 stale이면(크론이 죽으면) 캐시된
    # au_paused_at을 신뢰하지 않고 fail-open한다(페드루 PO 조건, 2026-08-28).
    au_warn_80_notified_at: Mapped[datetime | None] = mapped_column(DateTime(timezone=True), nullable=True)
    au_warn_90_notified_at: Mapped[datetime | None] = mapped_column(DateTime(timezone=True), nullable=True)
    au_grace_started_at: Mapped[datetime | None] = mapped_column(DateTime(timezone=True), nullable=True)
    au_paused_at: Mapped[datetime | None] = mapped_column(DateTime(timezone=True), nullable=True)
    au_eval_at: Mapped[datetime | None] = mapped_column(DateTime(timezone=True), nullable=True)
    created_at: Mapped[datetime] = mapped_column(
        DateTime(timezone=True), server_default=func.now(), nullable=False
    )
    updated_at: Mapped[datetime] = mapped_column(
        DateTime(timezone=True), server_default=func.now(), nullable=False
    )
