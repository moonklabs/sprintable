"""story #3259 AC2 — 지원 대화·세션 전용 저장소. backend의 conversations/conversation_messages
테이블과 스키마·프로세스·(설계상) 인스턴스 전부 분리한다 — FK로 교차 참조하지 않는다(물리
분리 DB라 애초에 불가능하고, 가능해도 만들지 않는다: org 소속 검증은 항상 위임 토큰의 클레임을
믿지 DB join으로 넘어가지 않는다).

⛔이 파일 어디에도 org_id를 특정 리터럴 값과 비교하는 분기가 있으면 안 된다 — moonklabs도
고객 #N(Blueprint v0.3 §0). tests/test_no_org_special_case.py가 이걸 grep으로 고정한다.
"""
from __future__ import annotations

import uuid
from datetime import datetime

from sqlalchemy import DateTime, ForeignKey, Text, Uuid, func
from sqlalchemy.orm import DeclarativeBase, Mapped, mapped_column

# SQLAlchemy 2.0 제네릭 Uuid — PG는 native UUID로, SQLite(테스트 전용, aiosqlite)는 CHAR(32)로
# 자동 매핑된다. dialects.postgresql.UUID를 쓰면 SQLite에서 바인딩이 깨진다(실측 — float으로
# 오역).
UUID = Uuid


class Base(DeclarativeBase):
    pass


class SupportSession(Base):
    """org-스코프 위젯 세션. 1 세션 = 위임 토큰 1회 교환의 결과 — org_id/external_user_id는
    항상 위임 토큰 클레임에서만 채워진다(요청 바디에서 신뢰 입력으로 받지 않는다)."""

    __tablename__ = "support_sessions"

    id: Mapped[uuid.UUID] = mapped_column(UUID(as_uuid=True), primary_key=True, default=uuid.uuid4)
    org_id: Mapped[uuid.UUID] = mapped_column(UUID(as_uuid=True), nullable=False, index=True)
    external_user_id: Mapped[uuid.UUID] = mapped_column(UUID(as_uuid=True), nullable=False, index=True)
    created_at: Mapped[datetime] = mapped_column(DateTime(timezone=True), server_default=func.now(), nullable=False)
    last_seen_at: Mapped[datetime] = mapped_column(DateTime(timezone=True), server_default=func.now(), nullable=False)
    expired_at: Mapped[datetime | None] = mapped_column(DateTime(timezone=True), nullable=True)


class SupportConversation(Base):
    """org당 1스레드 계승(Blueprint v0.3 §1.1) — org_id별 유니크 제약은 마이그레이션에서
    건다(story #3259는 저장소 골격까지, 스레드 재사용 정책 자체는 story #3 오케스트레이션 스코프)."""

    __tablename__ = "support_conversations"

    id: Mapped[uuid.UUID] = mapped_column(UUID(as_uuid=True), primary_key=True, default=uuid.uuid4)
    org_id: Mapped[uuid.UUID] = mapped_column(UUID(as_uuid=True), nullable=False, index=True)
    session_id: Mapped[uuid.UUID] = mapped_column(
        UUID(as_uuid=True), ForeignKey("support_sessions.id"), nullable=False
    )
    created_at: Mapped[datetime] = mapped_column(DateTime(timezone=True), server_default=func.now(), nullable=False)


class SupportMessage(Base):
    """고객 텍스트 저장 — role='customer'인 행은 항상 injection_defense.sanitize_customer_text()를
    거친 *이후* 값이어야 한다(app/injection_defense.py·story #3259 AC5 골격, 본 방어는 story #6)."""

    __tablename__ = "support_messages"

    id: Mapped[uuid.UUID] = mapped_column(UUID(as_uuid=True), primary_key=True, default=uuid.uuid4)
    conversation_id: Mapped[uuid.UUID] = mapped_column(
        UUID(as_uuid=True), ForeignKey("support_conversations.id"), nullable=False, index=True
    )
    org_id: Mapped[uuid.UUID] = mapped_column(UUID(as_uuid=True), nullable=False, index=True)
    role: Mapped[str] = mapped_column(Text, nullable=False)  # 'customer' | 'agent' | 'system'
    content: Mapped[str] = mapped_column(Text, nullable=False)
    created_at: Mapped[datetime] = mapped_column(DateTime(timezone=True), server_default=func.now(), nullable=False)
