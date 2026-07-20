"""story 139d2405(S-slug-infra): workspace/project slug rename 이력 — 향후 301 redirect(S-route-*)용."""
import uuid
from datetime import datetime

from sqlalchemy import DateTime, Text, func
from sqlalchemy.dialects.postgresql import UUID
from sqlalchemy.orm import Mapped, mapped_column

from app.core.database import Base


class EntitySlugHistory(Base):
    """entity_type='organization'|'project'의 slug 변경 1건. old_slug→new_slug 조회로 301 해소.

    org_id는 project 이력도 workspace 스코프로 바로 필터 가능하게 하는 denorm(조인 없이 조회)."""

    __tablename__ = "entity_slug_history"

    id: Mapped[uuid.UUID] = mapped_column(UUID(as_uuid=True), primary_key=True, default=uuid.uuid4)
    org_id: Mapped[uuid.UUID] = mapped_column(UUID(as_uuid=True), nullable=False, index=True)
    entity_type: Mapped[str] = mapped_column(Text, nullable=False)  # 'organization' | 'project'
    entity_id: Mapped[uuid.UUID] = mapped_column(UUID(as_uuid=True), nullable=False, index=True)
    old_slug: Mapped[str] = mapped_column(Text, nullable=False)
    new_slug: Mapped[str] = mapped_column(Text, nullable=False)
    changed_at: Mapped[datetime] = mapped_column(
        DateTime(timezone=True), server_default=func.now(), nullable=False
    )
