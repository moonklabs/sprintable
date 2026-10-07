"""story #4580 (E-DESKTOP-2 · AC2) — the addresses a desktop agent may connect to without asking (its «허용 주소» list).

One row per (agent, host). A host is added only after a person signed it on their phone (the permission request's second answer —
added by the daemon's report, story #4580 B) and removed by whoever may change the agent's run profile (4540 §3 ⓔ). The daemon reads
the list with the agent's own key and writes it as the agent folder's `WebFetch(domain:<host>)` lines (the line Claude Code itself
writes for «don't ask again»). Exact hosts only — no wildcard, no port (a host is every port, as Claude's own line is)."""
import uuid
from datetime import datetime

from sqlalchemy import DateTime, ForeignKey, Text, func
from sqlalchemy.dialects.postgresql import UUID
from sqlalchemy.orm import Mapped, mapped_column

from app.core.database import Base


class AgentAllowedHost(Base):
    __tablename__ = "agent_allowed_hosts"

    member_id: Mapped[uuid.UUID] = mapped_column(
        UUID(as_uuid=True), ForeignKey("members.id", ondelete="CASCADE"), primary_key=True,
    )
    host: Mapped[str] = mapped_column(Text, primary_key=True)
    added_by: Mapped[uuid.UUID | None] = mapped_column(UUID(as_uuid=True), nullable=True)
    request_id: Mapped[uuid.UUID | None] = mapped_column(UUID(as_uuid=True), nullable=True)
    added_at: Mapped[datetime] = mapped_column(DateTime(timezone=True), nullable=False, server_default=func.now())
