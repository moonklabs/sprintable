"""story #3414(Phase1·마케팅운영, 페드루 PO 確定 2026-09-04) — 발행 명령 원장.

블루프린트 v3 §3 그대로: 휴먼의 발행/예약 요청(POST .../publish)이 이 행을
만든다(PO 確定 (B) — 승인 자체는 트리거가 아니다, "승인 없는 명령이 없다"일
뿐). `UNIQUE(org_id, destination, approved_version, operation)` — 블루프린트
멱등키. `scheduled_at`은 요청 시점 gate.sealed_scheduled_at을 그대로 옮긴
값(null=즉시) — command 자체는 그 뒤 gate가 재봉인돼도 안 따라간다(불변,
`approved_version` 고정과 같은 사상 — "그 순간 승인된 것"의 스냅샷).

`gate_id`는 FK 없음(channel_connections·channel_post_drafts와 동일 관례,
그라운딩 §9) — 승인 뒤 편집으로 이 gate가 pending 복귀할 때 이 gate에 걸린
pending 명령을 voided로 무효화하는 조회(`void_pending_commands_for_gate`)의
유일한 키.

`failure_kind`는 유나 design §11-5 정본 3값(`connection`/`needs_check`/
`transient`) — 화면이 실패를 조립하지 않도록 서버가 값으로 낸다. 매핑을 모르는
error_code는 `needs_check`로 fail-closed(임의로 transient=재시도 가능이라
단정하지 않는다)."""
from __future__ import annotations

import uuid
from datetime import datetime

from sqlalchemy import CheckConstraint, DateTime, Integer, Text, UniqueConstraint, func
from sqlalchemy.dialects.postgresql import UUID
from sqlalchemy.orm import Mapped, mapped_column

from app.core.database import Base


class PublicationCommand(Base):
    __tablename__ = "publication_commands"
    __table_args__ = (
        UniqueConstraint(
            "org_id", "destination", "approved_version", "operation",
            name="uq_publication_commands_idempotency",
        ),
        # story #3516 조각② 라이브 핫픽스(마이그 0340, 2026-09-05) — 0323이 이 CHECK를
        # raw SQL로만 걸고 여기 모델에 미러를 안 남겨(뿌리 원인) 로컬 create_all() 기반
        # 테스트가 이 제약 자체를 못 보고 죄다 그린으로 통과했다(실 마이그된 dev DB에서만
        # content_kind="comment_reply" INSERT가 IntegrityError→500). 마이그(0323→0340)가
        # 정본, 이건 그 정본의 미러 — 이름을 반드시 같게 유지할 것(`ck_publication_
        # commands_content_kind`), 새 값을 추가할 땐 이 두 곳을 항상 같이 고칠 것.
        CheckConstraint(
            "content_kind IN ('channel_post', 'site_post', 'comment_reply')",
            name="ck_publication_commands_content_kind",
        ),
    )

    id: Mapped[uuid.UUID] = mapped_column(UUID(as_uuid=True), primary_key=True, default=uuid.uuid4)
    org_id: Mapped[uuid.UUID] = mapped_column(UUID(as_uuid=True), nullable=False, index=True)
    gate_id: Mapped[uuid.UUID] = mapped_column(UUID(as_uuid=True), nullable=False, index=True)
    destination: Mapped[uuid.UUID] = mapped_column(UUID(as_uuid=True), nullable=False)
    approved_version: Mapped[uuid.UUID] = mapped_column(UUID(as_uuid=True), nullable=False)
    operation: Mapped[str] = mapped_column(Text, nullable=False, server_default="publish")
    # story e4fc29fa(조각③c) — 'channel_post'|'site_post'. approved_version이 어느
    # 테이블(ChannelPostVersion|SitePostVersion)을 가리키는지의 유일한 판별축(워커
    # 분기) — FK 없음 관례라 이 컬럼 없이는 워커가 두 도메인을 못 구분한다.
    content_kind: Mapped[str] = mapped_column(Text, nullable=False, server_default="channel_post")
    scheduled_at: Mapped[datetime | None] = mapped_column(DateTime(timezone=True), nullable=True)
    # 'pending'|'in_progress'|'completed'|'failed'|'dead_letter'|'voided'|'blocked'
    # (blocked=connection 복구 대기, PO 정정2 추가② — 일반 재시도 큐 밖).
    status: Mapped[str] = mapped_column(Text, nullable=False, server_default="pending")
    attempt_count: Mapped[int] = mapped_column(Integer, nullable=False, server_default="0")
    next_attempt_at: Mapped[datetime | None] = mapped_column(DateTime(timezone=True), nullable=True)
    last_error: Mapped[str | None] = mapped_column(Text, nullable=True)
    # voided 전이 사유('CONTENT_CHANGED'|'SCHEDULE_CHANGED') — PO 確定3.
    reason_code: Mapped[str | None] = mapped_column(Text, nullable=True)
    # 'connection'|'needs_check'|'transient' — 유나 design §11-5.
    failure_kind: Mapped[str | None] = mapped_column(Text, nullable=True)
    dead_letter_at: Mapped[datetime | None] = mapped_column(DateTime(timezone=True), nullable=True)
    requested_by_member_id: Mapped[uuid.UUID] = mapped_column(UUID(as_uuid=True), nullable=False)
    created_at: Mapped[datetime] = mapped_column(DateTime(timezone=True), server_default=func.now(), nullable=False)
    updated_at: Mapped[datetime] = mapped_column(
        DateTime(timezone=True), server_default=func.now(), onupdate=func.now(), nullable=False,
    )
