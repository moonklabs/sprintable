"""결제②-C2(story #2493) — orderId-먼저-기록 pending/confirmed/failed. 되돌릴 수 없는 Toss
호출 前에 의도를 먼저 남겨 크래시/타임아웃도 복구 가능하게 한다(C1 authKey nit과 동일 규율).
billing_ledger_entries(A2, append-only)는 「승인 대기」 상태를 못 담아 이 테이블이 따로 있다."""
from __future__ import annotations

import uuid

from sqlalchemy import BigInteger, CheckConstraint, Text
from sqlalchemy.dialects.postgresql import UUID
from sqlalchemy.orm import Mapped, mapped_column

from app.core.database import Base
from app.models.base import OrgScopedMixin, TimestampMixin


class BillingOrder(Base, TimestampMixin, OrgScopedMixin):
    __tablename__ = "billing_orders"
    __table_args__ = (
        # story #3522(BE·위생, 2026-09-06) — 마이그(0267·0268) raw SQL 미러
        # (마이그=정본·모델=미러, publication_command.py 0340 관례와 동일 사상).
        CheckConstraint(
            "refund_status IS NULL OR refund_status IN ('confirmed', 'failed')",
            name="ck_billing_orders_refund_status",
        ),
        CheckConstraint("purpose IN ('charge', 'pack_purchase')", name="ck_billing_orders_purpose"),
        # story #3522 — 같은 테이블(billing_orders)의 원래 생성 마이그(0231, status
        # 값은 0232가 'downgraded' 추가 뒤 최종본)에 걸린 3개도 같은 사유로 미러
        # (이 테이블을 __table_args__로 손대는 김에 같이 — 스코프는 이 5개 테이블
        # 안으로 한정, 프로젝트 전역 스윕은 이 스토리 밖에 별도 기록).
        CheckConstraint(
            "status IN ('pending','confirmed','failed','downgraded')", name="billing_orders_status_check",
        ),
        CheckConstraint("currency IN ('usd','krw')", name="billing_orders_currency_check"),
        CheckConstraint("amount_minor > 0", name="billing_orders_amount_positive_check"),
    )

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
    # story #3209(PR-1) — Toss 결제 승인 응답의 `receipt.url`(호스팅 매출전표 등, 공식
    # 문서 §Payment). confirmed 시점에만 채워짐(pending/failed는 NULL) — billing_charge.py의
    # _confirm_with_ledger 단일 지점에서만 쓴다(신규 발급 로직 없이 Toss URL 그대로 저장).
    receipt_url: Mapped[str | None] = mapped_column(Text, nullable=True)
