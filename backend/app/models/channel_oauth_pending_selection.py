"""story #3547 — `channel_oauth_pending_selections` ORM. 모듈 docstring은 마이그
0342 참고(중복 재설명 0)."""
from __future__ import annotations

import uuid
from datetime import datetime

from sqlalchemy import DateTime, Text
from sqlalchemy.dialects.postgresql import JSONB, UUID
from sqlalchemy.orm import Mapped, mapped_column

from app.core.database import Base
from app.models.base import OrgScopedMixin, TimestampMixin


class ChannelOAuthPendingSelection(Base, TimestampMixin, OrgScopedMixin):
    __tablename__ = "channel_oauth_pending_selections"

    id: Mapped[uuid.UUID] = mapped_column(UUID(as_uuid=True), primary_key=True, default=uuid.uuid4)
    requester_member_id: Mapped[uuid.UUID] = mapped_column(UUID(as_uuid=True), nullable=False)
    channel: Mapped[str] = mapped_column(Text, nullable=False)
    encrypted_user_token: Mapped[str] = mapped_column(Text, nullable=False)
    candidates: Mapped[list] = mapped_column(JSONB, nullable=False)
    expires_at: Mapped[datetime] = mapped_column(DateTime(timezone=True), nullable=False)
