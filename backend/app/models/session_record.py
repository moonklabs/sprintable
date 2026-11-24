"""story 4977 B2 (alembic 0493) — one sealed record of a person's history. See the migration's docstring: `envelope` is the writer's record envelope as it came, which the server cannot open;
the other columns are the header's own words (never a content word)."""
import uuid
from datetime import datetime

from sqlalchemy import BigInteger, CheckConstraint, DateTime, ForeignKey, Identity, Index, Integer, Text, text
from sqlalchemy.dialects.postgresql import JSONB, UUID
from sqlalchemy.orm import Mapped, mapped_column

from app.core.database import Base


class SessionRecord(Base):
    __tablename__ = "session_records"
    __table_args__ = (
        CheckConstraint("kind IN ('chat_line', 'approval_record')", name="ck_session_records_kind"),
        CheckConstraint("jsonb_typeof(envelope) = 'object'", name="ck_session_records_envelope_object"),
        CheckConstraint("rec_gen >= 1 AND epoch >= 0 AND ctr >= 0 AND byte_size > 0", name="ck_session_records_numbers"),
        CheckConstraint("deleted_at IS NULL OR envelope = '{}'::jsonb", name="ck_session_records_tombstone_empty"),
        CheckConstraint("char_length(record_id) BETWEEN 1 AND 256 AND char_length(writer) BETWEEN 1 AND 256", name="ck_session_records_text_len"),
        Index("uq_session_records_conv_owner_record", "conversation_id", "owner_id", "record_id", unique=True),
        Index("uq_session_records_seq", "seq", unique=True),
        Index("ix_session_records_setup_seq", "setup_id", "seq"),
        Index("ix_session_records_owner", "owner_id", "org_id"),
    )

    id: Mapped[uuid.UUID] = mapped_column(UUID(as_uuid=True), primary_key=True, default=uuid.uuid4)
    seq: Mapped[int] = mapped_column(BigInteger, Identity(always=False), nullable=False)
    org_id: Mapped[uuid.UUID] = mapped_column(UUID(as_uuid=True), ForeignKey("organizations.id", ondelete="CASCADE"), nullable=False)
    setup_id: Mapped[uuid.UUID] = mapped_column(UUID(as_uuid=True), nullable=False)  # no foreign key: the history outlives a computer that is removed or reinstalled
    owner_id: Mapped[uuid.UUID] = mapped_column(UUID(as_uuid=True), nullable=False)  # the person (desktop_setups.confirmed_by) whose history it is
    conversation_id: Mapped[uuid.UUID] = mapped_column(UUID(as_uuid=True), ForeignKey("conversations.id", ondelete="CASCADE"), nullable=False)
    record_id: Mapped[str] = mapped_column(Text, nullable=False)
    kind: Mapped[str] = mapped_column(Text, nullable=False)
    rec_gen: Mapped[int] = mapped_column(Integer, nullable=False)
    writer: Mapped[str] = mapped_column(Text, nullable=False)  # the header's `from` — the writer's key id, as the writer wrote it (the server cannot check a signature)
    epoch: Mapped[int] = mapped_column(BigInteger, nullable=False)
    ctr: Mapped[int] = mapped_column(BigInteger, nullable=False)
    byte_size: Mapped[int] = mapped_column(Integer, nullable=False)
    envelope: Mapped[dict] = mapped_column(JSONB, nullable=False)
    created_at: Mapped[datetime] = mapped_column(DateTime(timezone=True), server_default=text("clock_timestamp()"), nullable=False)
    replaced_at: Mapped[datetime | None] = mapped_column(DateTime(timezone=True), nullable=True)
    deleted_at: Mapped[datetime | None] = mapped_column(DateTime(timezone=True), nullable=True)  # set = a tombstone: `envelope` is `{}`, nothing sealed is kept
