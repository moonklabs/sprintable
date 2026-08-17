"""⛔DEPRECATED(story #2731/82593fb0, 2026-08-18 그라운딩) — v2.3 이행 후 `offering_versions`
(migration 0228, `app/models/offering_version.py`)가 실 가격/과금 결정 축을 전부 대체했다.
그라운딩 실측: 이 클래스(`PricingVersion`)를 import하는 곳은 이 파일과 `models/__init__.py`
(등록용) 뿐 — 어떤 router·service·repository도 쿼리하지 않는다(전수 grep, 0건). FE도 무접촉.
잔존 참조는 딱 둘: ①`org_subscriptions.pricing_version_id`(FK, nullable) — 컬럼은 있으나
아무 코드도 채우거나 읽지 않는 순수 vestige(grep 0건) ②sprintable-admin(internal-api)의
CRUD write 경로 — prod는 `PRICING_VERSIONS_ENABLED=false`로 완전 게이트오프(2026-07-09
부팅실패 발견 이후)돼 있으나 **dev는 env override가 없어 기본값 True로 여전히 라이브**
(admin-web `/pricing` 다이얼로그로 새 행 생성 가능) — 단 그렇게 만든 행을 읽는 코드가
없어 실제 가격에 영향 0.

**DROP 안 함** — story #70bc4bc3("P0급 잠재·prod DB: alembic_version(0253)과 pricing_versions
실 스키마 불일치 — prod pre-0228 형상·polar_price_id 잔존 판별")이 이 테이블 자체를 대상으로
진행 중이라 스키마 변경은 그쪽 판별에 종속. 이 docstring 갱신은 순수 문서화(코드 동작 무변경).

---
가격 버전 이력(E-ADMIN B1, story 553fc58d) — team/pro 유료 tier의 가격 변경 이력.

**append-only**: 가격 값이 담긴 행은 절대 UPDATE되지 않는다. 가격이 바뀌면 새 행을
INSERT하고, 직전 "열린"(effective_to IS NULL) 행의 effective_to를 새 행의 effective_from
으로 닫는다(행을 닫는 것뿐 — price_cents 등 가격 값 자체는 불변).

free tier는 가격이 항상 0이라 버전 이력 대상에서 제외(tier CHECK가 team/pro/overage만 허용).

grandfather: org_subscriptions.pricing_version_id가 가입(플랜변경) 시점의 이 테이블 행을
참조 — 이후 가격이 바뀌어도 기존 구독은 그 시점 행의 price_cents를 유지한다.

currency: PG가 USD/KRW를 별개 price 객체(각자 provider_price_ref)로 관리해 (tier,
billing_cycle, currency)가 계보 키다 — 통화별 독립 grandfather. price_cents는 그 통화의
최소단위 그대로(USD=센트·KRW=원, Polar 자체 규칙과 동일).

#2471(A1) provider-agnostic화: polar_price_id(NOT NULL) → provider_price_ref(nullable) +
provider(NOT NULL, toss/polar). provider는 currency로부터만 파생된다는 불변식을 CHECK
제약으로 DB가 직접 강제(krw→toss·usd→polar, 03:41Z 確定). tier CHECK에서 'pro'는 은퇴하고
'starter'/'business'가 대신한다(v2.3 D12) — 이 테이블은 마이그 시점에 0행이라 무손실
전환이다."""
from __future__ import annotations

import uuid
from datetime import datetime

from sqlalchemy import DateTime, Integer, Text, func
from sqlalchemy.dialects.postgresql import UUID
from sqlalchemy.orm import Mapped, mapped_column

from app.core.database import Base


class PricingVersion(Base):
    __tablename__ = "pricing_versions"

    id: Mapped[uuid.UUID] = mapped_column(UUID(as_uuid=True), primary_key=True, default=uuid.uuid4)
    tier: Mapped[str] = mapped_column(Text, nullable=False)
    billing_cycle: Mapped[str] = mapped_column(Text, nullable=False)
    currency: Mapped[str] = mapped_column(Text, nullable=False, default="usd")
    price_cents: Mapped[int] = mapped_column(Integer, nullable=False)
    provider: Mapped[str] = mapped_column(Text, nullable=False)
    provider_price_ref: Mapped[str | None] = mapped_column(Text, nullable=True)
    effective_from: Mapped[datetime] = mapped_column(DateTime(timezone=True), nullable=False)
    effective_to: Mapped[datetime | None] = mapped_column(DateTime(timezone=True), nullable=True)
    created_by: Mapped[str] = mapped_column(Text, nullable=False)
    created_at: Mapped[datetime] = mapped_column(
        DateTime(timezone=True), server_default=func.now(), nullable=False
    )
