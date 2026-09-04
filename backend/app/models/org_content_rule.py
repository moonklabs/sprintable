"""story #3471(Phase1·마케팅운영, 페드루 PO 確定 2026-09-05) — 조직 콘텐츠 규칙 원장.
org당 1행(UNIQUE org_id) — 이력 테이블 없음, `version`(PUT마다 +1)+`updated_by_member_id`
로 감사 충분(블루프린트 §2(f) AC "규칙을 바꾸면 이후 초안 lint 결과가 달라지고 과거
evidence는 보존된다" — 과거 evidence 보존은 이 테이블이 아니라 draft.lint_result
스냅샷 쪽 책임, 이 테이블 자체는 "지금 규칙이 뭔가"만 안다).

`rules`(JSONB, 자유 형식) — 제품이 기계로 검사하는 것(`banned_terms: string[]`·
`require_utm: bool`)과 에이전트가 읽는 선언 슬롯(`tone`·`taxonomy`·`channel_priority`·
`brand_kit`)이 같은 객체 안에 같이 산다(휴먼이 한 화면에서 편집하는 단위 — 검사
여부는 `content_rules.py::lint_content`가 특정 키만 골라 본다, 스키마 자체는 여기서
강제 안 함)."""
from __future__ import annotations

import uuid
from datetime import datetime

from sqlalchemy import DateTime, Integer, func
from sqlalchemy.dialects.postgresql import JSONB, UUID
from sqlalchemy.orm import Mapped, mapped_column

from app.core.database import Base


class OrgContentRule(Base):
    __tablename__ = "org_content_rules"

    id: Mapped[uuid.UUID] = mapped_column(UUID(as_uuid=True), primary_key=True, default=uuid.uuid4)
    org_id: Mapped[uuid.UUID] = mapped_column(UUID(as_uuid=True), nullable=False, unique=True)
    rules: Mapped[dict] = mapped_column(JSONB, nullable=False, server_default="{}")
    version: Mapped[int] = mapped_column(Integer, nullable=False, server_default="0")
    updated_by_member_id: Mapped[uuid.UUID | None] = mapped_column(UUID(as_uuid=True), nullable=True)
    updated_at: Mapped[datetime] = mapped_column(
        DateTime(timezone=True), server_default=func.now(), onupdate=func.now(), nullable=False
    )
