"""결제②-C2(story #2493) — orderId-먼저-기록 pending/confirmed/failed. 되돌릴 수 없는 Toss
호출 前에 의도를 먼저 남겨 크래시/타임아웃도 복구 가능하게 한다(C1 authKey nit과 동일 규율).
billing_ledger_entries(A2, append-only)는 「승인 대기」 상태를 못 담아 이 테이블이 따로 있다."""
from __future__ import annotations

import uuid

from sqlalchemy import BigInteger, Text
from sqlalchemy.dialects.postgresql import UUID
from sqlalchemy.orm import Mapped, mapped_column

from app.core.database import Base
from app.models.base import OrgScopedMixin, TimestampMixin


class BillingOrder(Base, TimestampMixin, OrgScopedMixin):
    __tablename__ = "billing_orders"

    id: Mapped[uuid.UUID] = mapped_column(UUID(as_uuid=True), primary_key=True, default=uuid.uuid4)
    # org_id: OrgScopedMixin(index만 — 한 org가 여러 주문을 가지므로 unique 아님, org_billing_keys와 다름).
    order_id: Mapped[str] = mapped_column(Text, nullable=False, unique=True)
    amount_minor: Mapped[int] = mapped_column(BigInteger, nullable=False)
    currency: Mapped[str] = mapped_column(Text, nullable=False)
    status: Mapped[str] = mapped_column(Text, nullable=False, default="pending")
    # 카디르 CRITICAL(2026-08-21, PR#3306 리뷰) — 이 컬럼이 없어 "이 org의 최근 confirmed
    # order"가 pack 구매와 구독 charge를 구분 못해 상향 부분취소가 무관한 pack 결제를
    # 잘못 취소한 실 재현 결함(0268). charge_org()가 받는 entry_type과 같은 값을 그대로
    # 찍는다(billing_ledger_entries.entry_type과 개념 중복이 아니라 — order 자체에도
    # 같은 사실이 필요해서 복제, "이 order가 왜 만들어졌나"를 join 없이 즉시 알아야 하는
    # 자리(org_subscription_tier_change.py의 부분취소 대상 선별)가 있다).
    purpose: Mapped[str] = mapped_column(Text, nullable=False, default="charge")
    payment_key: Mapped[str | None] = mapped_column(Text, nullable=True)
    failure_reason: Mapped[str | None] = mapped_column(Text, nullable=True)
    # story #2880(0267) — 이 confirmed order에 대한 부분취소 시도 결과. NULL=시도 없음.
    # "confirmed"/"failed" — 마지막 시도 결과만(누적 이력 아님). 부분취소 실패가 이 order의
    # 원 charge(status='confirmed')를 되돌리지 않는다(선생님 지시) — 그래서 실패 표기는
    # status가 아니라 이 별도 필드다.
    refund_status: Mapped[str | None] = mapped_column(Text, nullable=True)
