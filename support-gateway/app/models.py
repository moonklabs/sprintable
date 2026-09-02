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

from sqlalchemy import CheckConstraint, DateTime, Float, ForeignKey, Index, Text, Uuid, func, text
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
    """story #3276(지원v1·후속) — org는 절대 격리 경계(불변)지만, 상담 자체는 **사용자 단위로
    분리**된다: (org_id, external_user_id)당 활성(ended_at IS NULL) 상담 최대 1개(통례 —
    인터컴류). external_user_id가 NULL인 행은 이 마이그레이션 *이전* 생성분("org당 1스레드"
    시절, Blueprint v0.3 §1.1 원 설계) — 봉인(backfill 안 함, 삭제도 안 함): 새 조회 경로는
    exact (org_id, external_user_id) 매치만 보므로 그 행들은 이제 누구의 조회에도 안 걸린다
    (감사 목적으로 DB엔 남는다). ended_at이 채워지면 읽기 전용 이력(app/routers/sessions.py
    ".../conversations/{id}/end") — SupportEscalation.status(사람 연결 완료 여부)와는 완전히
    별개 축이다(상담을 종료해도 열린 에스컬레이션은 안 건드린다, 그 반대도 마찬가지)."""

    __tablename__ = "support_conversations"
    # story #3285(지원v1·후속, 2026-09-01) — realdb 드리프트 게이트가 처음 실행되며 발견한
    # 별개 사전 존재 드리프트(operator role과 무관). migration 0003이 실제로 만든 건
    # (org_id, external_user_id) 복합 인덱스 하나(그 조합으로 "활성 상담" 조회, 위 docstring)
    # 인데, 모델은 external_user_id에 `index=True`만 붙여 실제 배포엔 없는 단일 컬럼 인덱스를
    # 따로 선언하고 있었다(compare_metadata 실측으로 적발). 실 배포 스키마에 맞춰 정정.
    #
    # story #3298(2026-09-02, fleet CI blocker 정정) — migration 0005(story #3278, PR#3681)가
    # (org_id, external_user_id) WHERE ended_at IS NULL 부분 유니크 인덱스
    # ux_support_conversations_org_user_active를 실 DB에 추가했으나, 이 모델은 그때 갱신 안
    # 됨(compare_metadata 실측: DB엔 있고 metadata엔 없어 'remove_index'로 잡힘 — 정본은
    # migration 쪽, 모델이 뒤처졌던 것). 위 ix_(0003, 비유니크·전체행) 인덱스는 0005가 안
    # 지웠으므로 DB에 그대로 남아 있다 — 둘 다 선언해야 실 스키마와 일치.
    # ⛔postgresql_where만 주면 SQLite(테스트 dialect)는 그 kwarg를 무시하고 **전체행** 유니크
    # 인덱스를 만든다(부분 조건 없이) — 실측으로 걸림: test_conversation_user_scope.py 3건이
    # "새 상담 시작이 이전 걸 종료 처리"하는 흐름에서 ended_at 무관 유니크 위반으로 깨졌다.
    # sqlite_where를 나란히 줘야 SQLite에서도 진짜 부분 인덱스(ended_at IS NULL만 대상)가 된다.
    __table_args__ = (
        Index("ix_support_conversations_org_user_active", "org_id", "external_user_id"),
        Index(
            "ux_support_conversations_org_user_active",
            "org_id",
            "external_user_id",
            unique=True,
            postgresql_where=text("ended_at IS NULL"),
            sqlite_where=text("ended_at IS NULL"),
        ),
    )

    id: Mapped[uuid.UUID] = mapped_column(UUID(as_uuid=True), primary_key=True, default=uuid.uuid4)
    org_id: Mapped[uuid.UUID] = mapped_column(UUID(as_uuid=True), nullable=False, index=True)
    session_id: Mapped[uuid.UUID] = mapped_column(
        UUID(as_uuid=True), ForeignKey("support_sessions.id"), nullable=False
    )
    # NULL=레거시 봉인 행(위 docstring). 신규 생성 경로(_get_or_create_active_conversation 등)는
    # 항상 값을 채운다 — 코드 레벨 불변식, DB NOT NULL 제약은 아니다(레거시 행 공존 때문).
    external_user_id: Mapped[uuid.UUID | None] = mapped_column(UUID(as_uuid=True), nullable=True)
    ended_at: Mapped[datetime | None] = mapped_column(DateTime(timezone=True), nullable=True)
    created_at: Mapped[datetime] = mapped_column(DateTime(timezone=True), server_default=func.now(), nullable=False)

    # story #3261 AC3 — org별 대화 메모리(요약 압축). app/memory.py가
    # memory_summarize_after_messages(설정값) 초과 시 지식-Task급 모델로 압축해 여기 갱신한다.
    # None이면 "아직 압축 전"(원문 메시지가 곧 메모리) — Interaction 프롬프트 조립 시 이 필드
    # 존재 여부로 분기(app/interaction.py::_build_history).
    memory_summary: Mapped[str | None] = mapped_column(Text, nullable=True)
    memory_summarized_through_message_id: Mapped[uuid.UUID | None] = mapped_column(
        UUID(as_uuid=True), nullable=True
    )


# story #3285(지원v1·후속, 2026-09-01) — #3672가 이 값 목록을 코드(app/routers/operator_replies.py
# role="operator")에서 먼저 넓혔는데 마이그레이션(ck_support_messages_role, migration 0001)은
# 그대로였다 — dev PG에서 실제로 IntegrityError 500(#3279 실왕복). 이 상수가 "코드가 믿는
# 유효 role 집합"의 유일한 출처다 — CheckConstraint도, 아래 realdb 드리프트 프로브
# (tests/test_gateway_schema_drift_realdb.py)도 전부 이 상수 하나를 순회/참조한다. 새 role을
# 추가할 땐 여기만 고치면 되고, 그 순간 프로브가 자동으로 그 값을 실제 INSERT해 마이그레이션
# 누락을 구조적으로 잡는다(하드코딩된 별도 목록을 테스트에 두면 갱신을 잊는 바로 그 실수가
# 재발한다 — PO 확定).
#
# ⚠️migration 0004(story #3279 핫픽스, PR#3678)가 실 제약을 이 4개 값으로 넓히기 전까지는
# 이 선언과 dev/prod 배포 상태가 불일치한다 — 그동안은 realdb 드리프트 테스트가 **의도적으로
# RED**다(정확히 이 사고를 재현·증명하는 것). #3678 머지 전까지 이 PR은 머지 보류.
ALLOWED_ROLES: tuple[str, ...] = ("customer", "agent", "system", "operator")


class SupportMessage(Base):
    """고객 텍스트 저장 — role='customer'인 행은 항상 injection_defense.sanitize_customer_text()를
    거친 *이후* 값이어야 한다(app/injection_defense.py·story #3259 AC5 골격, 본 방어는 story #6)."""

    __tablename__ = "support_messages"
    __table_args__ = (
        CheckConstraint(
            "role IN (" + ", ".join(f"'{r}'" for r in ALLOWED_ROLES) + ")",
            name="ck_support_messages_role",
        ),
    )

    id: Mapped[uuid.UUID] = mapped_column(UUID(as_uuid=True), primary_key=True, default=uuid.uuid4)
    conversation_id: Mapped[uuid.UUID] = mapped_column(
        UUID(as_uuid=True), ForeignKey("support_conversations.id"), nullable=False, index=True
    )
    org_id: Mapped[uuid.UUID] = mapped_column(UUID(as_uuid=True), nullable=False, index=True)
    # story #3279 핫픽스(2026-09-01, 마이그 0004) — 'operator' 편입 전엔 DB CHECK 제약이
    # 이 role을 몰라 실 PG에서 500이었다. story #3285가 "주석과 마이그레이션을 항상 같이
    # 갱신할 것"이라는 수동 규율을 구조로 대체 — 이제 이 컬럼의 유효값은 ALLOWED_ROLES
    # 상수(위)가 유일한 출처이고, CheckConstraint도 realdb 드리프트 프로브도 전부 거기서
    # 도출된다. 새 role 추가 시 여기(주석 아님, ALLOWED_ROLES)만 고칠 것.
    role: Mapped[str] = mapped_column(Text, nullable=False)  # ALLOWED_ROLES 중 하나 — 위 상수 참고.
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
