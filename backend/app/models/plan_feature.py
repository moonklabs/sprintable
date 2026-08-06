import uuid
from datetime import datetime

import sqlalchemy as sa
from sqlalchemy import Boolean, DateTime, Enum, Integer, Text, func
from sqlalchemy.dialects.postgresql import UUID
from sqlalchemy.orm import Mapped, mapped_column

from app.core.database import Base

# v2.3(#2471 A1): free/starter/team/business로 재편(기존 free/team/pro 대체). solo/pro
# enum은 신설하지 않는다(v2.3 D12) — pro는 은퇴, business가 그 자리를 대신한다. 이 Enum은
# 어떤 컬럼에도 바인딩되지 않은 선언뿐이라(plan_feature.tier는 String(16)) 실제 DB CHECK는
# 각 테이블(offering_versions·pricing_versions)이 개별로 가진다.
TierEnum = Enum("free", "starter", "team", "business", name="plan_feature_tier")


class PlanFeature(Base):
    __tablename__ = "plan_features"

    id: Mapped[uuid.UUID] = mapped_column(UUID(as_uuid=True), primary_key=True, default=uuid.uuid4)
    code: Mapped[str] = mapped_column(Text, nullable=False, unique=True, index=True)
    name: Mapped[str] = mapped_column(Text, nullable=False)
    tier: Mapped[str] = mapped_column(sa.String(16), nullable=False, index=True)
    description: Mapped[str | None] = mapped_column(Text, nullable=True)
    is_active: Mapped[bool] = mapped_column(Boolean, nullable=False, server_default="true")
    rate_limit_per_min: Mapped[int | None] = mapped_column(Integer, nullable=True)
    created_at: Mapped[datetime] = mapped_column(
        DateTime(timezone=True), server_default=func.now(), nullable=False
    )
