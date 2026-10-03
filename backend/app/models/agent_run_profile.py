"""story #4540 (E-DESKTOP-2 C-5 · alembic 0435) — the model and effort a desktop agent starts with.
Contract: doc «E-DESKTOP-2 C-5 — 에이전트 실행 프로필 계약» v1.1 (20764ba3) §1.

The runtime stays where it always was (`members.runtime_type`, one truth); this row only adds what the CLI is started with.
NULL means the runtime's own default — nothing is made up to fill it. `version` goes up on every change: the daemon keeps the
version it started with and compares it with this one to tell «running ≠ saved» (§4)."""
import uuid
from datetime import datetime

from sqlalchemy import DateTime, ForeignKey, Integer, Text, func
from sqlalchemy.dialects.postgresql import UUID
from sqlalchemy.orm import Mapped, mapped_column

from app.core.database import Base


class AgentRunProfile(Base):
    __tablename__ = "agent_run_profiles"

    member_id: Mapped[uuid.UUID] = mapped_column(
        UUID(as_uuid=True), ForeignKey("members.id", ondelete="CASCADE"), primary_key=True,
    )
    model: Mapped[str | None] = mapped_column(Text, nullable=True)
    effort: Mapped[str | None] = mapped_column(Text, nullable=True)
    version: Mapped[int] = mapped_column(Integer, nullable=False, default=1, server_default="1")
    updated_by: Mapped[uuid.UUID | None] = mapped_column(UUID(as_uuid=True), nullable=True)
    updated_at: Mapped[datetime] = mapped_column(DateTime(timezone=True), nullable=False, server_default=func.now())
