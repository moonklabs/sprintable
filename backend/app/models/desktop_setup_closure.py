"""story #4769 — what migration 0464 closed, by id (never by value): one row per computer the migration revoked, with the ids of the device tokens, the agent keys and the
agents it stopped. If the count a reviewer makes before or after the deploy shows a row was closed that should not have been, exactly these ids can be restored by a
follow-up. Written only by the migration; the app never reads or writes it."""
import uuid
from datetime import datetime

from sqlalchemy import Boolean, DateTime, Text, func
from sqlalchemy.dialects.postgresql import JSONB, UUID
from sqlalchemy.orm import Mapped, mapped_column

from app.core.database import Base


class DesktopSetupClosure(Base):
    __tablename__ = "desktop_setup_closures"

    id: Mapped[uuid.UUID] = mapped_column(UUID(as_uuid=True), primary_key=True, default=uuid.uuid4)
    org_id: Mapped[uuid.UUID] = mapped_column(UUID(as_uuid=True), nullable=False, index=True)  # no foreign key: see migration 0464 (lock order with an organization delete)
    setup_id: Mapped[uuid.UUID] = mapped_column(UUID(as_uuid=True), nullable=False, index=True)
    confirmed_by: Mapped[uuid.UUID] = mapped_column(UUID(as_uuid=True), nullable=False)
    migration: Mapped[str] = mapped_column(Text, nullable=False)
    reason: Mapped[str] = mapped_column(Text, nullable=False)
    seatless: Mapped[bool] = mapped_column(Boolean, nullable=False)  # True: the person had no seat row at all; False: a soft-deleted one
    token_ids: Mapped[list] = mapped_column(JSONB, nullable=False, default=list)
    key_ids: Mapped[list] = mapped_column(JSONB, nullable=False, default=list)
    agent_ids: Mapped[list] = mapped_column(JSONB, nullable=False, default=list)
    created_at: Mapped[datetime] = mapped_column(DateTime(timezone=True), server_default=func.now(), nullable=False)
