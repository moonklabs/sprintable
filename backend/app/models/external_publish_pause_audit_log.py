"""story #3953(마케팅·안전장치·블루프린트 §1-5, 페드루 PO 確定 2026-09-16) — 조직
전체 「외부 발행 일시 중지」 pause/resume 감사 로그.

`AuditLog`(permission_audit_logs)는 `action` 컬럼에 DB CHECK
(`permission_audit_logs_action_check` — 실측: `action = ANY(ARRAY['member_added',
'member_removed','role_changed'])`)가 있어 role-변경 전용 스키마다 — 재사용 시
IntegrityError. 이 코드베이스가 이미 두 번 같은 상황에서 새 전용 테이블을
택했다(0262_gate_github_check.py의 `gate_github_check_event`·
0285_chat_command_audit_logs.py의 `chat_command_audit_logs`, 둘 다 "기존 audit
3종은 전부 목적이 달라 재사용 부적합"이라 명시) — 같은 결의 신규 도메인이라
그 선례를 그대로 따른다(페드루 PO 確認 2026-09-16 15:04Z)."""
from __future__ import annotations

import uuid
from datetime import datetime

from sqlalchemy import DateTime, Text, func
from sqlalchemy.dialects.postgresql import UUID
from sqlalchemy.orm import Mapped, mapped_column

from app.core.database import Base


class ExternalPublishPauseAuditLog(Base):
    __tablename__ = "external_publish_pause_audit_logs"

    id: Mapped[uuid.UUID] = mapped_column(UUID(as_uuid=True), primary_key=True, default=uuid.uuid4)
    org_id: Mapped[uuid.UUID] = mapped_column(UUID(as_uuid=True), nullable=False, index=True)
    # 'pause' | 'resume'.
    action: Mapped[str] = mapped_column(Text, nullable=False)
    # FK 無 — publication_command.py::requested_by_member_id와 동형 관례(team_members는
    # 뷰라 FK 대상이 될 수 없다, 0393 마이그 코멘트 참고 — rebase 개명 前엔 0379).
    actor_member_id: Mapped[uuid.UUID] = mapped_column(UUID(as_uuid=True), nullable=False)
    reason: Mapped[str | None] = mapped_column(Text, nullable=True)
    created_at: Mapped[datetime] = mapped_column(
        DateTime(timezone=True), server_default=func.now(), nullable=False
    )
