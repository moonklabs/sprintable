from __future__ import annotations

import uuid
from datetime import datetime

from sqlalchemy import CheckConstraint, DateTime, Enum, ForeignKey, Text, func
from sqlalchemy.dialects.postgresql import JSONB, UUID
from sqlalchemy.orm import Mapped, mapped_column

from app.core.database import Base
from app.models.base import OrgScopedMixin

import enum


class EventType(str, enum.Enum):
    # story #2379 — memo_created/memo_replied 제거(2026-08-01). 전수 grep(프로덕션+테스트)
    # 결과 `EventType.memo_created`/`EventType.memo_replied` 속성 접근이 어디에도 없었다 —
    # events.event_type 컬럼 자체가 Text(native enum 아님)라 역직렬화 경로도 없다. 살아 있는
    # memo 기능(SaaS webhook 발송 등)은 이 enum을 거치지 않으므로 영향 없음.
    #
    # ⚠️story #2391 AC4 후속 — 이 enum과 `event_type`의 실사용은 `EventStatus`보다 훨씬 크게
    # 어긋난다(dev DB DISTINCT, 2026-08-01, PO): dispatched 2,694 · conversation.message_created
    # 1,602 · story_assigned 19 · a2a.task_message 1 · qa_test_ping 1 — dispatched만 이 enum과
    # 일치하고 나머지 넷은 전부 밖이다. `status_changed`(선언)는 dev에 0건. `event_type`은 이
    # 스토리(#2391)의 스코프(EventStatus + /events/stream docstring) 밖이라 CHECK 제약을 안
    # 붙였다 — 여기 손대면 실제로 쓰이는 문자열 리터럴 이벤트 타입(자유 형식 네임스페이스,
    # a2a.*류)까지 전수해야 하는 별도 규모의 작업이다. 다음 사람을 위해 사실만 남긴다.
    dispatched = "dispatched"
    status_changed = "status_changed"


class EventSourceEntityType(str, enum.Enum):
    memo = "memo"
    story = "story"
    epic = "epic"
    doc = "doc"
    sprint = "sprint"


class EventRecipientType(str, enum.Enum):
    agent = "agent"
    human = "human"


class EventStatus(str, enum.Enum):
    """story #2391(2026-08-01) — dev DB status DISTINCT 실측(전량 · 2026-08-01 12:4xZ, PO):
    delivered 4,151 · pending 86 · expired 80 · failed 0. `expired`는 30일 초과 pending을
    회수하는 실동작 경로(expire_stale_events_core, 이 파일 밑 events.py 참조)가 실제로 쓰는데
    이 enum에 없었다 — 추가한다.

    `failed`는 반대 방향 문제다 — 코드 전수 grep(프로덕션+테스트, `EventType.memo_created`
    제거 때와 동일 방법)으로 `Event.status`에 "failed"를 쓰는 자리가 0건, dev DB도 0건. 그래도
    지우지 않는다 — "지금 dev에 0건"과 "원리적으로 안 난다"는 다른 주장이고(PO 판단), prod는
    측정하지 못했다. CHECK 제약(아래)에는 포함시켜 둔다 — 미래에 실제로 쓰이기 시작해도 구조를
    또 안 바꿔도 되고, 지금 당장 무해하다(쓰는 자리가 없으니 존재해도 아무 행도 이 값을 안 가짐).
    """
    pending = "pending"
    delivered = "delivered"
    expired = "expired"
    failed = "failed"


class Event(Base, OrgScopedMixin):
    __tablename__ = "events"

    id: Mapped[uuid.UUID] = mapped_column(UUID(as_uuid=True), primary_key=True, default=uuid.uuid4)
    project_id: Mapped[uuid.UUID] = mapped_column(
        UUID(as_uuid=True), ForeignKey("projects.id", ondelete="CASCADE"), nullable=False, index=True
    )
    event_type: Mapped[str] = mapped_column(Text, nullable=False)
    source_entity_type: Mapped[str | None] = mapped_column(Text, nullable=True)
    source_entity_id: Mapped[uuid.UUID | None] = mapped_column(UUID(as_uuid=True), nullable=True)
    sender_id: Mapped[uuid.UUID | None] = mapped_column(
        UUID(as_uuid=True), ForeignKey("team_members.id", ondelete="SET NULL"), nullable=True
    )
    recipient_id: Mapped[uuid.UUID] = mapped_column(
        UUID(as_uuid=True), ForeignKey("team_members.id", ondelete="CASCADE"), nullable=False
    )
    recipient_type: Mapped[str] = mapped_column(Text, nullable=False)
    payload: Mapped[dict] = mapped_column(JSONB, nullable=False, default=dict)
    status: Mapped[str] = mapped_column(Text, nullable=False, default=EventStatus.pending.value)
    recipient_seq: Mapped[int | None] = mapped_column(nullable=True)
    created_at: Mapped[datetime] = mapped_column(
        DateTime(timezone=True), server_default=func.now(), nullable=False
    )
    delivered_at: Mapped[datetime | None] = mapped_column(DateTime(timezone=True), nullable=True)
    read_at: Mapped[datetime | None] = mapped_column(DateTime(timezone=True), nullable=True)

    # story #2391 AC2 — 구조로 막는다. status는 여태 순수 Text라 오타·미선언 값이 조용히 통과
    # 했다(`expired`가 그렇게 8개월 가까이 enum 밖에 살았다). SQL 문자열을 손으로 다시 적지
    # 않고 EventStatus에서 직접 파생시킨다 — #2387이 같은 날 잡은 "손 스냅샷" 병을 여기서
    # 새로 만들지 않기 위함. enum에 멤버를 추가/제거하면 이 조건도 같이 바뀌지만, 이미 적용된
    # DB 제약 자체를 바꾸려면 여전히 새 Alembic 마이그레이션이 필요하다(그 비대칭은 CHECK
    # 제약의 근본 성질 — 이 파생이 없앨 수 있는 건 "작성 시점 오타"뿐이다, AC5 참조).
    __table_args__ = (
        CheckConstraint(
            f"status IN ({', '.join(repr(s.value) for s in EventStatus)})",
            name="ck_events_status",
        ),
    )
