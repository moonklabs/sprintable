import uuid
from datetime import datetime

from sqlalchemy import DateTime, Integer, Text, func
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
    # story #3175 — 실DB(baseline schema.sql)는 NOT NULL·디폴트 없음이 원본(S48 도입
    # 커밋부터, 마이그레이션으로 바뀐 적 0건). "미터는 기간이 필수"가 의미상 맞고, 이
    # 컬럼을 실제로 쓰는 write 경로가 지금 0건이라 정본을 DB→ORM 방향으로 정렬한다
    # (ORM이 nullable=True로 지어낸 행은 DB가 거부하는데 그 실패가 커밋 시점까지 잠복).
    period_end: Mapped[datetime] = mapped_column(DateTime(timezone=True), nullable=False)
    # story #3175 — 같은 테이블 형제 컬럼 일괄 대조에서 발견: ORM에 아예 없었다(baseline엔
    # 둘 다 DEFAULT now() NOT NULL로 실재). 읽기 코드가 없어 지금까지 조용했을 뿐 — 다른
    # 모델들과 동일 스타일(server_default=func.now(), a2a_task.py 등 참고)로 채운다.
    created_at: Mapped[datetime] = mapped_column(
        DateTime(timezone=True), server_default=func.now(), nullable=False
    )
    updated_at: Mapped[datetime] = mapped_column(
        DateTime(timezone=True), server_default=func.now(), nullable=False
    )
