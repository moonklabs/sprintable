"""story 4791 — SSE lease rows for the one-receiver-per-agent contract when Redis is off (`services/sse_lease_pg.py`).

`sse_leases`      one row per (scope, member) — a live stream's place, with the moment it lapses. Same shape as the Redis ZSET
                  (`scope` = `perkey:<agent id>`, `member` = `rcv:<receiver id>` or a connection id, score = `expires_at`).
`sse_lease_taken` one row per scope — the member a person's [여기서 받기] gave the scope to; the other receivers' streams on OTHER
                  instances read it on their heartbeat and end `superseded` (the Redis `sse_lease_taken` key).

Time is the database's (`now()`), never an instance's: two instances never compare their own clocks.
"""
from datetime import datetime

from sqlalchemy import DateTime, Index, Text
from sqlalchemy.orm import Mapped, mapped_column

from app.core.database import Base


class SseLease(Base):
    __tablename__ = "sse_leases"
    __table_args__ = (Index("ix_sse_leases_expires_at", "expires_at"),)

    scope: Mapped[str] = mapped_column(Text, primary_key=True)
    member: Mapped[str] = mapped_column(Text, primary_key=True)
    expires_at: Mapped[datetime] = mapped_column(DateTime(timezone=True), nullable=False)


class SseLeaseTaken(Base):
    __tablename__ = "sse_lease_taken"

    scope: Mapped[str] = mapped_column(Text, primary_key=True)
    member: Mapped[str] = mapped_column(Text, nullable=False)
    expires_at: Mapped[datetime] = mapped_column(DateTime(timezone=True), nullable=False)
