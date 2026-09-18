"""story #3672(BE·BFF·FE·관측, 페드루 PO 確定 2026-09-07) — 미처리 500이 Cloud Run
로그에만 남아 사람(gcloud) 없이는 원인 재개가 안 되던 것(3663 실사고)을 닫는다.

`main.py::unhandled_exception_handler`가 매 미처리 예외마다 이 행을 하나 심는다 —
id 자체가 응답 봉투에 실리는 error_id와 동일(로그 한 줄 ↔ 응답 ↔ 이 행 셋이 같은
값으로 상관된다). FK 없음(channel_connections·channel_post_drafts와 동일 관례,
login_audit_logs와도 동형) — org/user가 인증 실패 전에 죽으면 그 자체로 null이
정직한 값이라 강제 조인을 걸 이유가 없다. 비밀값(헤더·바디·쿼리스트링) 미저장 —
message는 str(exc)[:2000]만(트레이스백 원문은 로그에만 남는다, 이 테이블은 조회
편의용 요약이지 로그 대체가 아니다)."""
from __future__ import annotations

import uuid
from datetime import datetime

from sqlalchemy import DateTime, Text, func
from sqlalchemy.dialects.postgresql import UUID
from sqlalchemy.orm import Mapped, mapped_column

from app.core.database import Base


class UnhandledErrorEvent(Base):
    __tablename__ = "unhandled_error_events"

    # id=error_id 그 자체 — uuid4는 서버(main.py)가 발급, 여기 PK로 그대로 심는다.
    id: Mapped[uuid.UUID] = mapped_column(UUID(as_uuid=True), primary_key=True)
    occurred_at: Mapped[datetime] = mapped_column(
        DateTime(timezone=True), server_default=func.now(), nullable=False, index=True
    )
    method: Mapped[str] = mapped_column(Text, nullable=False)
    # 쿼리스트링 제외 — 토큰/코드류(oauth-channel authorize state 등)가 쿼리에 실릴 수
    # 있어(AC2 "비밀값 기록 금지") request.url.path만(쿼리 없는 경로) 저장한다.
    path: Mapped[str] = mapped_column(Text, nullable=False)
    exception_class: Mapped[str] = mapped_column(Text, nullable=False)
    message: Mapped[str | None] = mapped_column(Text, nullable=True)
    # FK 없음(그라운딩 §9 관례 그대로) — 인증 실패 前에 죽은 요청은 org_id 자체가
    # 없을 수 있다(null 허용, 지어내지 않는다).
    org_id: Mapped[uuid.UUID | None] = mapped_column(UUID(as_uuid=True), nullable=True, index=True)
    user_id: Mapped[uuid.UUID | None] = mapped_column(UUID(as_uuid=True), nullable=True)
    # 엣지(CF 등)가 실어 보내는 X-Request-Id 그대로(모르면 null) — 새 트레이싱 체계
    # 발명 0(story "안 하는 것" 절 — Sentry류 APM은 범위 밖).
    request_id: Mapped[str | None] = mapped_column(Text, nullable=True)
