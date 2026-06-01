"""per-recipient dense commit-ordered seq 카운터."""
import uuid
from datetime import datetime

from sqlalchemy import BigInteger, DateTime, func
from sqlalchemy.dialects.postgresql import UUID
from sqlalchemy.orm import Mapped, mapped_column

from app.core.database import Base


class AgentEventSeq(Base):
    """recipient_id별 카운터 — row-lock이 commit 순서 직렬화."""
    __tablename__ = "agent_event_seqs"

    recipient_id: Mapped[uuid.UUID] = mapped_column(UUID(as_uuid=True), primary_key=True)
    last_seq: Mapped[int] = mapped_column(BigInteger, nullable=False, server_default="0")
    updated_at: Mapped[datetime] = mapped_column(
        DateTime(timezone=True), server_default=func.now(), nullable=False
    )
