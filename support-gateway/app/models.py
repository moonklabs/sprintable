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

from sqlalchemy import DateTime, Float, ForeignKey, Text, Uuid, func
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

    # story #3261 AC3 — org별 대화 메모리(요약 압축). app/memory.py가
    # memory_summarize_after_messages(설정값) 초과 시 지식-Task급 모델로 압축해 여기 갱신한다.
    # None이면 "아직 압축 전"(원문 메시지가 곧 메모리) — Interaction 프롬프트 조립 시 이 필드
    # 존재 여부로 분기(app/interaction.py::_build_history).
    memory_summary: Mapped[str | None] = mapped_column(Text, nullable=True)
    memory_summarized_through_message_id: Mapped[uuid.UUID | None] = mapped_column(
        UUID(as_uuid=True), nullable=True
    )


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

    # story #3261 AC5 — role='agent' 메시지(Interaction 모델 호출 결과)의 실측 비용. cost_cap.py가
    # `SUM(cost_usd) WHERE org_id=... AND created_at >= ...`로 org/일·org/세션 캡을 판정한다.
    # role='customer'/'system' 행은 항상 NULL(모델 호출 없음).
    cost_usd: Mapped[float | None] = mapped_column(Float, nullable=True)


class SupportExecutionLog(Base):
    """story #3261 AC3 "워커별 로그" — Interaction이 스폰하는 각 Execution Task(지식/org
    상태/에스컬레이션) 1회 호출마다 1행. 고객에게 보이는 SupportMessage와 분리된 이유: 이건
    운영/디버그용 내부 궤적이지 대화 내용이 아니다(주입 방어 관점에서도 고객이 이 로그를
    직접 읽지 않는다 — 노출면 최소)."""

    __tablename__ = "support_execution_logs"

    id: Mapped[uuid.UUID] = mapped_column(UUID(as_uuid=True), primary_key=True, default=uuid.uuid4)
    conversation_id: Mapped[uuid.UUID] = mapped_column(
        UUID(as_uuid=True), ForeignKey("support_conversations.id"), nullable=False, index=True
    )
    org_id: Mapped[uuid.UUID] = mapped_column(UUID(as_uuid=True), nullable=False, index=True)
    task_type: Mapped[str] = mapped_column(Text, nullable=False)  # 'classifier'|'interaction'|'knowledge'|'org_status'|'escalation'
    model: Mapped[str] = mapped_column(Text, nullable=False)
    summary: Mapped[str] = mapped_column(Text, nullable=False)  # 사람이 읽는 1~2문장 궤적(입력 원문 아님)
    cost_usd: Mapped[float | None] = mapped_column(Float, nullable=True)
    created_at: Mapped[datetime] = mapped_column(DateTime(timezone=True), server_default=func.now(), nullable=False)


class SupportEscalation(Base):
    """story #3261 AC2/AC5 — 사람에게 넘기는 경로. 두 트리거: 인입 분류기가 "사람 필요"로
    판정하거나(reason='classifier'), 비용 상한 초과(reason='cost_cap'). Blueprint §1.5의
    "버그는 스토리 초안화(사람 승인 후 등재)"는 story #5(에스컬레이션 본 구현) 스코프 —
    이 테이블은 그 전 단계인 "사람에게 큐잉됐다"는 사실 자체의 저장소."""

    __tablename__ = "support_escalations"

    id: Mapped[uuid.UUID] = mapped_column(UUID(as_uuid=True), primary_key=True, default=uuid.uuid4)
    conversation_id: Mapped[uuid.UUID] = mapped_column(
        UUID(as_uuid=True), ForeignKey("support_conversations.id"), nullable=False, index=True
    )
    org_id: Mapped[uuid.UUID] = mapped_column(UUID(as_uuid=True), nullable=False, index=True)
    reason: Mapped[str] = mapped_column(Text, nullable=False)  # 'classifier'|'cost_cap'
    detail: Mapped[str] = mapped_column(Text, nullable=False)
    status: Mapped[str] = mapped_column(Text, nullable=False, default="open")  # 'open'|'resolved'
    created_at: Mapped[datetime] = mapped_column(DateTime(timezone=True), server_default=func.now(), nullable=False)
