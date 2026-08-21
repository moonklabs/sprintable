"""story #2836([결함·관측], 실사고 — 유나 세션 6시간+ 침묵·미르코 revoke 사례) — 에이전트 API키
인증실패(401)가 어떤 표면에도 안 뜨던 것을 원장으로 남긴다.

append-only(1행 = 1회 401). 「연속 N회」는 별도 상태 컬럼 없이 이 원장을 windowed COUNT로
읽어 판정한다(agent_stuck·story_stalled 등 command_center.py의 기존 관측 패턴과 동형 — 발명
0, 새 서킷브레이커 상태기계 도입 안 함).

reason(AC④, 페드루 확定 — 추측 금지·서버가 아는 사실만): 'expired'(행 있고 expires_at 도과)·
'revoked'(revoked_at 세팅)·'invalid'(해당 prefix 행 없음 — org 귀속 불가, org_id/member_id
NULL). key_prefix만 저장(AC⑤ — 값 자체는 어떤 원장/로그/이벤트에도 안 남는다)."""
from __future__ import annotations

import uuid
from datetime import datetime

from sqlalchemy import CheckConstraint, DateTime, Index, Text, func
from sqlalchemy.dialects.postgresql import UUID
from sqlalchemy.orm import Mapped, mapped_column

from app.core.database import Base


class AgentAuthFailure(Base):
    __tablename__ = "agent_auth_failure"
    __table_args__ = (
        CheckConstraint(
            "reason IN ('expired', 'revoked', 'invalid')", name="ck_agent_auth_failure_reason",
        ),
        Index("ix_agent_auth_failure_org_member_occurred", "org_id", "member_id", "occurred_at"),
    )

    id: Mapped[uuid.UUID] = mapped_column(UUID(as_uuid=True), primary_key=True, default=uuid.uuid4)
    # invalid(prefix 자체가 미상)는 어느 org 소속인지 원리적으로 모른다 — NULL이 정직한 값
    # (다른 org의 attention에 새는 것보다 「이 org엔 안 뜬다」가 안전한 기본).
    org_id: Mapped[uuid.UUID | None] = mapped_column(UUID(as_uuid=True), nullable=True, index=True)
    api_key_id: Mapped[uuid.UUID | None] = mapped_column(
        UUID(as_uuid=True), nullable=True,
    )
    member_id: Mapped[uuid.UUID | None] = mapped_column(UUID(as_uuid=True), nullable=True)
    key_prefix: Mapped[str] = mapped_column(Text, nullable=False)
    reason: Mapped[str] = mapped_column(Text, nullable=False)
    occurred_at: Mapped[datetime] = mapped_column(
        DateTime(timezone=True), server_default=func.now(), nullable=False
    )
