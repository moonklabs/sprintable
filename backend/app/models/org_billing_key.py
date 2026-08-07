"""결제②-C1(story #2492) — org당 Toss 빌링키 1건(카드 교체 = 재발급으로 대체, 이력 테이블
아님 — `toss-adapter-c-plan-v0-1` §4). `encrypted_billing_key`는 절대 평문으로 두지 않는다
(app/services/billing_key_crypto.py 경유만).

#2512(결제②-D선행): encrypted_billing_key/issued_at이 nullable인 이유 — Toss 위젯은
customerKey를 "시작 前"에 요구하는데 실 빌링키는 위젯 인증이 끝나야(authKey) 발급받을
수 있다. status='awaiting_auth'인 placeholder 행(customer_key만 있고 나머지는 NULL)을
허용해 그 순서 문제를 푼다 — charge_org의 status=='active' 필터가 이 행을 자동으로
제외하므로 실 빌링키 없이 청구가 시도될 위험은 없다."""
from __future__ import annotations

import uuid
from datetime import datetime

from sqlalchemy import DateTime, Text
from sqlalchemy.dialects.postgresql import UUID
from sqlalchemy.orm import Mapped, mapped_column

from app.core.database import Base
from app.models.base import OrgScopedMixin, TimestampMixin


class OrgBillingKey(Base, TimestampMixin, OrgScopedMixin):
    __tablename__ = "org_billing_keys"

    id: Mapped[uuid.UUID] = mapped_column(UUID(as_uuid=True), primary_key=True, default=uuid.uuid4)
    # OrgScopedMixin의 org_id(index=True만)를 재선언 — 이 테이블은 org당 정확히 1행(카드
    # 교체=재발급으로 UPDATE, 이력 아님)이라 unique 제약을 추가로 건다.
    org_id: Mapped[uuid.UUID] = mapped_column(UUID(as_uuid=True), nullable=False, unique=True)
    customer_key: Mapped[str] = mapped_column(Text, nullable=False, unique=True)
    # #2512: placeholder(customer_key만 발급, 위젯 인증 前) 상태에선 NULL.
    encrypted_billing_key: Mapped[str | None] = mapped_column(Text, nullable=True)
    # 카드 표시정보(마스킹) — Toss 응답 그대로, 원본 카드번호 아님.
    card_issuer_code: Mapped[str | None] = mapped_column(Text, nullable=True)
    card_acquirer_code: Mapped[str | None] = mapped_column(Text, nullable=True)
    card_number_masked: Mapped[str | None] = mapped_column(Text, nullable=True)
    card_type: Mapped[str | None] = mapped_column(Text, nullable=True)
    card_owner_type: Mapped[str | None] = mapped_column(Text, nullable=True)
    status: Mapped[str] = mapped_column(Text, nullable=False, default="active")
    # #2512: placeholder 상태에선 NULL(아직 발급된 적 없음).
    issued_at: Mapped[datetime | None] = mapped_column(DateTime(timezone=True), nullable=True)
