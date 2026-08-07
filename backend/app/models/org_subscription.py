import uuid
from datetime import datetime

from sqlalchemy import DateTime, ForeignKey, Text, func
from sqlalchemy.dialects.postgresql import UUID
from sqlalchemy.orm import Mapped, mapped_column

from app.core.database import Base


class OrgSubscription(Base):
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
    pricing_version_id: Mapped[uuid.UUID | None] = mapped_column(
        UUID(as_uuid=True), ForeignKey("pricing_versions.id"), nullable=True
    )
    # #2471(A1): 이 구독이 지금 실제로 묶인 offering_version(가격·좌석·한도·팩 원자 스냅샷).
    # pricing_version_id와 동일 grandfather 패턴 — nullable(기존 행·아직 어댑터 미기입 행은
    # NULL). "언제 자동 이전할지" 같은 정책 규칙은 grandfather_policies가 별도로 진다.
    offering_version_id: Mapped[uuid.UUID | None] = mapped_column(
        UUID(as_uuid=True), ForeignKey("offering_versions.id"), nullable=True
    )
    created_at: Mapped[datetime] = mapped_column(
        DateTime(timezone=True), server_default=func.now(), nullable=False
    )
    updated_at: Mapped[datetime] = mapped_column(
        DateTime(timezone=True), server_default=func.now(), nullable=False
    )
