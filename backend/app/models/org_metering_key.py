"""story #3354(마케팅자동화·측정, 페드루 PO 확定 2026-09-03) — org 조회수 beacon용 공개
식별자. GA4 속성을 우리 계정이 못 읽어(담롱·PO 실측) 자사 서버가 직접 세는 수단이 필요하다.

이 키는 **비밀이 아니다** — 랜딩 JS(정적 페이지 소스)에 그대로 박히는 공개 식별자다(PO
확定, Q1 답변). 그래서 시크릿처럼 hash해 저장하지 않고 평문으로 둔다 — value가 새도 할 수
있는 일은 그 org 앞으로 pageview count를 늘리는 것뿐(쓰기 폭이 애초에 낮다). revoked_at으로
재발급(rotate)만 지원 — 옛 값은 즉시 무효화되고 새 값이 그 자리를 대신한다(행은 이력으로
남김, 물리삭제 안 함)."""
from __future__ import annotations

import uuid
from datetime import datetime

from sqlalchemy import DateTime, Index, Text, func
from sqlalchemy.dialects.postgresql import UUID
from sqlalchemy.orm import Mapped, mapped_column

from app.core.database import Base


class OrgMeteringKey(Base):
    __tablename__ = "org_metering_keys"
    __table_args__ = (
        Index("ix_org_metering_keys_org_id", "org_id"),
    )

    id: Mapped[uuid.UUID] = mapped_column(UUID(as_uuid=True), primary_key=True, default=uuid.uuid4)
    org_id: Mapped[uuid.UUID] = mapped_column(UUID(as_uuid=True), nullable=False)
    public_key: Mapped[str] = mapped_column(Text, nullable=False, unique=True)
    created_at: Mapped[datetime] = mapped_column(
        DateTime(timezone=True), server_default=func.now(), nullable=False
    )
    revoked_at: Mapped[datetime | None] = mapped_column(DateTime(timezone=True), nullable=True)
