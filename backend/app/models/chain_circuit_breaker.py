"""story #2630: 폭주 에피소드 «자동 차단»(서킷브레이커) — human-less 대화 agent 발신 차단.

#2626 에피소드 판별자(chain_escalation.py, Redis 마커) 위에 얹는 집행 계층. Redis TTL이
아니라 이 테이블 행의 존재가 서킷 open의 SSOT다 — release_mode='manual'인 org는 에피소드가
속도축에서 자연 해소(Redis 마커 삭제)돼도 서킷은 계속 열려 있어야 하는데(사람이 아직 안
눌렀으니), TTL 붙은 캐시로는 그 요구를 못 담는다(자동 만료가 "해제"를 오독).

conversation_id당 released_at IS NULL 행은 항상 최대 1개(부분 unique index, 아래) — 발신
차단 체크(conversations.py send_message)가 이 인덱스로 O(1) 조회한다. 이 행이 human-less
대화에서만 열리므로(오픈 호출부가 이미 그 조건을 확인한 뒤에만 부른다), 존재 자체가
"이 대화는 human-less"를 함의한다 — 발신 체크가 별도 human 유무 조회를 안 해도 되는 이유.
"""
from __future__ import annotations

import uuid
from datetime import datetime

from sqlalchemy import DateTime, Index, Text, text
from sqlalchemy.dialects.postgresql import UUID
from sqlalchemy.orm import Mapped, mapped_column

from app.core.database import Base


class ChainCircuitBreaker(Base):
    """org당 다수(대화당 최대 1개 open) — 폭주 에피소드가 연 서킷의 open/release 기록."""
    __tablename__ = "chain_circuit_breaker"
    __table_args__ = (
        Index(
            "uq_chain_circuit_breaker_open_conversation",
            "conversation_id",
            unique=True,
            postgresql_where=text("released_at IS NULL"),
        ),
    )

    id: Mapped[uuid.UUID] = mapped_column(UUID(as_uuid=True), primary_key=True, default=uuid.uuid4)
    org_id: Mapped[uuid.UUID] = mapped_column(UUID(as_uuid=True), nullable=False, index=True)
    conversation_id: Mapped[uuid.UUID] = mapped_column(UUID(as_uuid=True), nullable=False, index=True)
    project_id: Mapped[uuid.UUID | None] = mapped_column(UUID(as_uuid=True), nullable=True)
    opened_at: Mapped[datetime] = mapped_column(
        DateTime(timezone=True), server_default=text("now()"), nullable=False
    )
    released_at: Mapped[datetime | None] = mapped_column(DateTime(timezone=True), nullable=True)
    # human-only(is_org_owner_or_admin) 릴리즈만 채운다 — auto-release(에피소드 자연 해소)는
    # NULL로 남아 "누가 눌렀나"와 "자동 해소됐다"를 released_by 유무만으로 구분할 수 있다.
    released_by: Mapped[uuid.UUID | None] = mapped_column(UUID(as_uuid=True), nullable=True)
    release_reason: Mapped[str | None] = mapped_column(Text, nullable=True)
