"""story #3474(Phase1·마케팅운영, 페드루 PO 確定 2026-09-05) — 워커가 adapter 호출
직전 게이트 승인을 재검증한 결과를 매 시도마다 남기는 원장. 블루프린트 §1 구조적
차단 장치 4 「승인 없는 adapter 호출」을 `SELECT count(*) FROM publication_attempts
WHERE adapter_called AND approval_check <> 'ok'` 한 줄로 셀 수 있게 한다(정상
경로에서 항상 0).

`approval_check`: `ok`(재검증 통과)·`missing`(게이트가 approved가 아님)·
`voided`(무효화됨 — void_pending_commands_for_gate가 선제 처리한 경우 이 원장엔
안 남는다, 워커가 뒤늦게 잡은 경우만)·`version_mismatch`(sealed_content_sha256이
지금 버전과 다름 — 승인 뒤 재편집됐는데 아직 이 command가 안 걸러짐).

`finished_at`이 채워진 첫 성공(`approval_check='ok' AND adapter_called`) 행이
dead_letter 뒤 첫 번째면 「복구시간 = 그 finished_at − dead_letter_at」이 이
원장만으로 파생된다(디디 그라운딩 "복구 완료 시각 컬럼 없음"을 이 원장이 대신
채운다 — publication_commands에 신규 컬럼 0)."""
from __future__ import annotations

import uuid
from datetime import datetime

from sqlalchemy import Boolean, DateTime, Text
from sqlalchemy.dialects.postgresql import UUID
from sqlalchemy.orm import Mapped, mapped_column

from app.core.database import Base


class PublicationAttempt(Base):
    __tablename__ = "publication_attempts"

    id: Mapped[uuid.UUID] = mapped_column(UUID(as_uuid=True), primary_key=True, default=uuid.uuid4)
    command_id: Mapped[uuid.UUID] = mapped_column(UUID(as_uuid=True), nullable=False, index=True)
    gate_id: Mapped[uuid.UUID] = mapped_column(UUID(as_uuid=True), nullable=False, index=True)
    approval_check: Mapped[str] = mapped_column(Text, nullable=False)
    adapter_called: Mapped[bool] = mapped_column(Boolean, nullable=False)
    started_at: Mapped[datetime] = mapped_column(DateTime(timezone=True), nullable=False)
    finished_at: Mapped[datetime | None] = mapped_column(DateTime(timezone=True), nullable=True)
    result_code: Mapped[str | None] = mapped_column(Text, nullable=True)
