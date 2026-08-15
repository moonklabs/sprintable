"""요금제 v2.3 오퍼링 카탈로그 스냅샷(#2471 A1, doc pricing-policy-v2-3·billing-arch-modular-pg-ledger-v0-1 §4).

v2.1 §13.1의 판정을 그대로 따른다 — pricing_versions(가격만) + plan_tier_limits(저장만)로
흩어져 있던 "티어가 뭘 의미하는가"를 하나의 불변 행에 원자적으로 스냅샷한다: 가격·좌석·
한도(AU·저장·연결·에이전트·웹훅·규칙·레이트·재생)·팩 단위가 같은 offering_version 행 안에서
함께 버전 관리된다. append-only 정신은 pricing_versions와 동일 — 값이 바뀌면 새 행, 기존
행은 절대 UPDATE하지 않는다(effective_to로 "닫기"만).

⛔대표 승인 前이므로 이 표의 가격은 확定가가 아니다. 대외 노출/가격 화면에 쓰지 않는다
(내부 카탈로그 한정).

⚠️A1 스코프: krw_v1(4티어: free/starter/team/business)만 시드한다. USD/Polar 카탈로그는
그대로 기존 하드코딩 상수(ee/routers/billing.py _PLAN_CATALOG/_POLAR_PRICE_IDS)로 운영
중이며, 이 스토리에서 임의의 USD 연납/추가좌석 숫자를 발명하지 않는다 — 그 이관은 B단계
(PolarAdapter)의 몫이다.
"""
from __future__ import annotations

import uuid
from datetime import datetime

from sqlalchemy import BigInteger, Boolean, CheckConstraint, DateTime, Integer, Text, func
from sqlalchemy.dialects.postgresql import JSONB, UUID
from sqlalchemy.orm import Mapped, mapped_column

from app.core.database import Base


class OfferingVersion(Base):
    __tablename__ = "offering_versions"
    __table_args__ = (
        CheckConstraint(
            "tier IN ('free','starter','team','business')", name="offering_versions_tier_check"
        ),
        CheckConstraint("currency IN ('usd','krw')", name="offering_versions_currency_check"),
    )

    id: Mapped[uuid.UUID] = mapped_column(UUID(as_uuid=True), primary_key=True, default=uuid.uuid4)
    tier: Mapped[str] = mapped_column(Text, nullable=False)
    currency: Mapped[str] = mapped_column(Text, nullable=False)
    # 정책 버전 라벨(예: "krw_v1") — pricing-policy-v2-3 문서의 버전 문자열과 1:1.
    version_label: Mapped[str] = mapped_column(Text, nullable=False)

    monthly_price_minor: Mapped[int] = mapped_column(BigInteger, nullable=False)
    annual_price_minor: Mapped[int] = mapped_column(BigInteger, nullable=False)
    included_seats: Mapped[int] = mapped_column(Integer, nullable=False)
    # NULL = 추가 좌석을 판매하지 않음(v2.3 Starter).
    extra_seat_price_minor: Mapped[int | None] = mapped_column(BigInteger, nullable=True)
    # NULL = 무제한(Starter 이상). Free만 유한값(사람 좌석과 연동 — v2.1 §4.4).
    max_agents: Mapped[int | None] = mapped_column(Integer, nullable=True)

    au_limit: Mapped[int] = mapped_column(BigInteger, nullable=False)
    realtime_connection_limit: Mapped[int] = mapped_column(Integer, nullable=False)
    storage_mb_limit: Mapped[int] = mapped_column(BigInteger, nullable=False)
    max_file_mb: Mapped[int] = mapped_column(Integer, nullable=False)
    lab_credit_minor: Mapped[int] = mapped_column(BigInteger, nullable=False)
    rate_limit_per_min: Mapped[int] = mapped_column(Integer, nullable=False)
    automation_rule_limit: Mapped[int] = mapped_column(Integer, nullable=False)
    webhook_limit: Mapped[int] = mapped_column(Integer, nullable=False)
    event_replay_days: Mapped[int] = mapped_column(Integer, nullable=False)

    # 포함량 도달 시 팩 구매로 이어갈 수 있는지(Free=false=멈춘다·나머지=true).
    overage_allowed: Mapped[bool] = mapped_column(Boolean, nullable=False)
    # 팩 카탈로그 스냅샷(자원별 {unit, price_minor, max_packs}) — NULL=팩 없음(Free).
    pack_catalog: Mapped[dict | None] = mapped_column(JSONB, nullable=True)

    effective_from: Mapped[datetime] = mapped_column(DateTime(timezone=True), nullable=False)
    effective_to: Mapped[datetime | None] = mapped_column(DateTime(timezone=True), nullable=True)
    created_by: Mapped[str] = mapped_column(Text, nullable=False)
    created_at: Mapped[datetime] = mapped_column(
        DateTime(timezone=True), server_default=func.now(), nullable=False
    )
