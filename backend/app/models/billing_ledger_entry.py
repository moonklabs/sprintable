"""append-only 결제 원장(#2472 A2, 설계문서 billing-arch-modular-pg-ledger-v0-1 §3).

모든 돈/크레딧 이동의 «정본». PG-무관 — provider/provider_ref는 멱등 식별용이지 이 테이블의
존재 이유가 아니다. 잔액/사용량은 이 테이블에서 파생(뷰 org_ledger_balances) — 별도 잔액
컬럼을 어디에도 두지 않는다.

불변성은 DB 트리거(billing_ledger_entries_block_mutation, 0229 마이그)가 강제한다 — UPDATE/
DELETE 시도는 예외로 거부된다. 정정이 필요하면 반대 방향 entry(refund/adjustment)를 새로
추가한다."""
from __future__ import annotations

import uuid
from datetime import datetime

from sqlalchemy import BigInteger, DateTime, ForeignKey, Text, func
from sqlalchemy.dialects.postgresql import JSONB, UUID
from sqlalchemy.orm import Mapped, mapped_column

from app.core.database import Base


class BillingLedgerEntry(Base):
    __tablename__ = "billing_ledger_entries"

    id: Mapped[uuid.UUID] = mapped_column(UUID(as_uuid=True), primary_key=True, default=uuid.uuid4)
    org_id: Mapped[uuid.UUID] = mapped_column(UUID(as_uuid=True), nullable=False)
    ts: Mapped[datetime] = mapped_column(
        DateTime(timezone=True), server_default=func.now(), nullable=False
    )
    entry_type: Mapped[str] = mapped_column(Text, nullable=False)
    amount_minor: Mapped[int] = mapped_column(BigInteger, nullable=False)
    currency: Mapped[str] = mapped_column(Text, nullable=False)
    direction: Mapped[str] = mapped_column(Text, nullable=False)
    # PG-무관 원칙 — 내부전용 이동(예: 어드민 goodwill credit_grant)은 provider가 없을 수
    # 있다. nullable.
    provider: Mapped[str | None] = mapped_column(Text, nullable=True)
    # 웹훅/중복 요청 멱등키. UNIQUE(nullable) — Postgres는 NULL을 서로 다른 값으로 취급하니
    # provider_ref 없는(내부전용) 엔트리는 유일성 제약 밖이고, 있는 엔트리끼리만 충돌한다.
    provider_ref: Mapped[str | None] = mapped_column(Text, unique=True, nullable=True)
    subscription_id: Mapped[uuid.UUID | None] = mapped_column(
        UUID(as_uuid=True), ForeignKey("org_subscriptions.id"), nullable=True
    )
    # DB 컬럼명은 AC 원문대로 "metadata" — Python 속성명만 entry_metadata(Base.metadata와
    # 충돌 방지, SQLAlchemy 예약명).
    entry_metadata: Mapped[dict | None] = mapped_column("metadata", JSONB, nullable=True)
