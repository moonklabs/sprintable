"""story #4424 — one desktop setup (alembic 0422). See the migration docstring for what each column records."""
import uuid
from datetime import datetime

from sqlalchemy import CheckConstraint, DateTime, ForeignKey, Index, Integer, Text, func
from sqlalchemy.dialects.postgresql import JSONB, UUID
from sqlalchemy.orm import Mapped, mapped_column

from app.core.database import Base


class DesktopSetup(Base):
    __tablename__ = "desktop_setups"
    __table_args__ = (
        CheckConstraint("char_length(device_name) BETWEEN 1 AND 80", name="ck_desktop_setups_device_name_len"),
        CheckConstraint("exchanged_at IS NULL OR confirmed_at IS NOT NULL", name="ck_desktop_setups_exchange_after_confirm"),
        Index("uq_desktop_setups_code_hash", "code_hash", unique=True),
        Index("ix_desktop_setups_org_id", "org_id"),
        Index("ix_desktop_setups_work_item_id", "work_item_id"),
    )

    id: Mapped[uuid.UUID] = mapped_column(UUID(as_uuid=True), primary_key=True, default=uuid.uuid4)
    code_hash: Mapped[str] = mapped_column(Text, nullable=False)
    code_challenge: Mapped[str] = mapped_column(Text, nullable=False)
    device_name: Mapped[str] = mapped_column(Text, nullable=False)
    expires_at: Mapped[datetime] = mapped_column(DateTime(timezone=True), nullable=False)
    org_id: Mapped[uuid.UUID | None] = mapped_column(UUID(as_uuid=True), ForeignKey("organizations.id", ondelete="CASCADE"), nullable=True)
    project_id: Mapped[uuid.UUID | None] = mapped_column(UUID(as_uuid=True), ForeignKey("projects.id", ondelete="CASCADE"), nullable=True)
    event_definition_key: Mapped[str | None] = mapped_column(Text, nullable=True)
    confirmed_by: Mapped[uuid.UUID | None] = mapped_column(UUID(as_uuid=True), nullable=True)
    confirmed_at: Mapped[datetime | None] = mapped_column(DateTime(timezone=True), nullable=True)
    # [{stage, member_id, kind: agent|human, runtime}] — what the confirmation bound
    members: Mapped[list | None] = mapped_column(JSONB, nullable=True)
    # the folder chosen on the web — handed back as is in the exchange; the desktop app is the judge of the path
    workdir_hint: Mapped[str | None] = mapped_column(Text, nullable=True)
    # alembic 0423 — the story the confirmation created (its first work item); the status read and the first-result mark
    # find the setup by this, not by a funnel event
    work_item_id: Mapped[uuid.UUID | None] = mapped_column(
        UUID(as_uuid=True), ForeignKey("stories.id", ondelete="SET NULL", name="fk_desktop_setups_work_item_id"), nullable=True,
    )
    exchanged_at: Mapped[datetime | None] = mapped_column(DateTime(timezone=True), nullable=True)
    keys_issued: Mapped[int] = mapped_column(Integer, nullable=False, server_default="0")
    revoked_at: Mapped[datetime | None] = mapped_column(DateTime(timezone=True), nullable=True)
    revoked_by: Mapped[uuid.UUID | None] = mapped_column(UUID(as_uuid=True), nullable=True)
    created_at: Mapped[datetime] = mapped_column(DateTime(timezone=True), server_default=func.now(), nullable=False)
