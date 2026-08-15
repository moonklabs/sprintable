import uuid
from datetime import datetime

from sqlalchemy import DateTime, Index, Text, func, text
from sqlalchemy.dialects.postgresql import UUID
from sqlalchemy.orm import Mapped, mapped_column

from app.core.database import Base
from app.models.base import TimestampMixin


class NotificationPreference(Base, TimestampMixin):
    __tablename__ = "notification_preferences"
    # story #2637 §0-c(디디 발견, 2026-08-14): 이 3개 파티셜 유니크 인덱스는 migration
    # 0033/0250에서 raw op.create_index()로만 존재했고 __table_args__엔 한 번도 등록된 적이
    # 없었다 — Base.metadata.create_all() 기반 realdb 테스트(이 코드베이스의 표준 create_all
    # 패턴)가 upsert_preferences의 ON CONFLICT를 태우면 "no unique or exclusion constraint
    # matching" 크래시로 조용히 못 잡던 사각이었다(원래 uq_notif_pref_global/scoped도 동일
    # 사각 — 지금까지 이 라우터를 create_all로 테스트한 사례가 0건이라 안 드러났을 뿐).
    # 여기 등록해 create_all()도 migration과 동일 제약을 재현하게 한다(순수 additive — 런타임
    # migrated DB는 이미 같은 인덱스가 있어 무회귀).
    __table_args__ = (
        Index(
            "uq_notif_pref_global", "member_id", "scope_type", "channel", unique=True,
            postgresql_where=text("scope_id IS NULL AND event_key IS NULL"),
        ),
        Index(
            "uq_notif_pref_scoped", "member_id", "scope_type", "scope_id", "channel", unique=True,
            postgresql_where=text("scope_id IS NOT NULL"),
        ),
        Index(
            "uq_notif_pref_event_key", "member_id", "event_key", "channel", unique=True,
            postgresql_where=text("event_key IS NOT NULL"),
        ),
    )

    id: Mapped[uuid.UUID] = mapped_column(UUID(as_uuid=True), primary_key=True, default=uuid.uuid4)
    # E-MEMBER-SSOT AC2-2: team_members FK 완화 — grant-only 휴먼(org_member.id) 수용.
    # 컬럼·인덱스 유지, FK는 migration 0073에서 DROP (0069 conv/events와 동일 패턴).
    member_id: Mapped[uuid.UUID] = mapped_column(
        UUID(as_uuid=True), nullable=False, index=True
    )
    scope_type: Mapped[str] = mapped_column(Text, nullable=False)  # global | project | conversation | thread | event_key
    scope_id: Mapped[uuid.UUID | None] = mapped_column(UUID(as_uuid=True), nullable=True)
    # story #2637 §0-c: scope_type="event_key"일 때만 값을 가짐(scope_id는 그 경우 NULL —
    # event_key는 UUID가 아닌 문자열이라 별도 컬럼, migration 0250 참조).
    event_key: Mapped[str | None] = mapped_column(Text, nullable=True)
    channel: Mapped[str] = mapped_column(Text, nullable=False)  # sse | discord | telegram | in_app
    level: Mapped[str] = mapped_column(Text, nullable=False)  # all | mentions | mute
