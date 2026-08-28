import uuid
from datetime import datetime

from sqlalchemy import DateTime, Integer, Text
from sqlalchemy.dialects.postgresql import UUID
from sqlalchemy.orm import Mapped, mapped_column

from app.core.database import Base

# story #2473(결제②-A3) — usage_meters.meter_type CHECK(DB, migration 0287)이 허용하는
# 전체 값의 Python 쪽 거울. 기존 5종(ai_calls/storage_mb/members/agents/stt_minutes) +
# v2.3 한도표(doc pricing-policy-v2-3 Part 3) 신규 축 5종. 값을 바꾸려면 migration도 같이
# 갱신할 것 — 이 상수 자체가 DB 제약을 대체하지 않는다.
ALLOWED_METER_TYPES = frozenset(
    {
        "ai_calls",
        "storage_mb",
        "members",
        "agents",
        "stt_minutes",
        "automation_units",
        "realtime_connections",
        "webhooks",
        "automation_rules",
        "event_replay_days",
    }
)

# story #2473 — AU(automation_units) 가중치 계측 seam(v2.1 §4.5 · v2.3 Part2 D15:
# "읽기 1 · 쓰기 5 · 배치는 엔티티 1개당 5"). 값을 "기록할 자리"만 정의한다 — 실제
# 호출부 배선(어디서 이 가중치로 usage_meters.current_value를 올릴지)과 한도 집행은
# 이 스토리 범위 밖(후속 스토리 B, ee/plan_limits 확장)이다.
AU_WEIGHTS: dict[str, int] = {
    "read": 1,
    "write": 5,
    "batch_per_entity": 5,
}


class UsageMeter(Base):
    __tablename__ = "usage_meters"

    id: Mapped[uuid.UUID] = mapped_column(UUID(as_uuid=True), primary_key=True, default=uuid.uuid4)
    org_id: Mapped[uuid.UUID] = mapped_column(UUID(as_uuid=True), nullable=False, index=True)
    meter_type: Mapped[str] = mapped_column(Text, nullable=False)
    current_value: Mapped[int] = mapped_column(Integer, nullable=False, default=0)
    limit_value: Mapped[int | None] = mapped_column(Integer, nullable=True)
    period_start: Mapped[datetime] = mapped_column(DateTime(timezone=True), nullable=False)
    period_end: Mapped[datetime | None] = mapped_column(DateTime(timezone=True), nullable=True)
