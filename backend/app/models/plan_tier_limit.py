from datetime import datetime

from sqlalchemy import BigInteger, DateTime, Integer, Text, func
from sqlalchemy.orm import Mapped, mapped_column

from app.core.database import Base


class PlanTierLimit(Base):
    """tier별 storage 캡(S8·admin-configurable SSOT). enforce 가 org tier→이 행→캡으로 읽는다.

    값은 MB 단위(admin 편집). client-trust 0(server 권위). seed=0140(결재값).
    """

    __tablename__ = "plan_tier_limits"

    tier: Mapped[str] = mapped_column(Text, primary_key=True)
    max_storage_mb: Mapped[int] = mapped_column(BigInteger, nullable=False)
    max_file_mb: Mapped[int] = mapped_column(Integer, nullable=False)
    created_at: Mapped[datetime] = mapped_column(
        DateTime(timezone=True), server_default=func.now(), nullable=False
    )
    updated_at: Mapped[datetime] = mapped_column(
        DateTime(timezone=True), server_default=func.now(), nullable=False
    )
