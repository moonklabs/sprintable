import uuid
from datetime import datetime

from sqlalchemy import DateTime, Text, func
from sqlalchemy.dialects.postgresql import UUID
from sqlalchemy.orm import Mapped, mapped_column

from app.core.database import Base
from app.models.base import TimestampMixin


class NotificationPreference(Base, TimestampMixin):
    __tablename__ = "notification_preferences"

    id: Mapped[uuid.UUID] = mapped_column(UUID(as_uuid=True), primary_key=True, default=uuid.uuid4)
    # E-MEMBER-SSOT AC2-2: team_members FK 완화 — grant-only 휴먼(org_member.id) 수용.
    # 컬럼·인덱스 유지, FK는 migration 0073에서 DROP (0069 conv/events와 동일 패턴).
    member_id: Mapped[uuid.UUID] = mapped_column(
        UUID(as_uuid=True), nullable=False, index=True
    )
    scope_type: Mapped[str] = mapped_column(Text, nullable=False)  # global | project | conversation | thread
    scope_id: Mapped[uuid.UUID | None] = mapped_column(UUID(as_uuid=True), nullable=True)
    channel: Mapped[str] = mapped_column(Text, nullable=False)  # sse | discord | telegram | in_app
    level: Mapped[str] = mapped_column(Text, nullable=False)  # all | mentions | mute
